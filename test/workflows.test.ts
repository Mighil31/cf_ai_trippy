import { getAgentByName } from "agents";
import { introspectWorkflow, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ItemInput } from "../src/shared/schema";
import { details } from "./fixtures";
import { lisbonGeocoding, mockFetch, weatherRoutes } from "./mock-fetch";

const DATES = ["2026-11-12", "2026-11-13", "2026-11-14"];

async function newTrip() {
  const directory = await getAgentByName(
    env.UserDirectory,
    crypto.randomUUID()
  );
  const { id } = await directory.createTrip(details());
  const stub = await getAgentByName(env.TripAgent, id);
  await stub.refreshExternalData();
  return stub;
}

const dayItems = (n: number): ItemInput[] => [
  {
    kind: "activity",
    title: `Sight ${n}`,
    startTime: "10:00",
    endTime: "12:00",
    cost: { amount: 20, estimated: true }
  },
  {
    kind: "meal",
    title: `Lunch ${n}`,
    startTime: "12:30",
    endTime: "13:30",
    cost: { amount: 40, estimated: true }
  }
];

async function waitForJob(
  stub: Awaited<ReturnType<typeof newTrip>>,
  status: "done" | "error"
) {
  await vi.waitFor(
    async () => {
      const job = await runInDurableObject(stub, (a) => a.state.job);
      expect(job?.status).toBe(status);
    },
    { timeout: 5000, interval: 50 }
  );
}

describe("PlanTripWorkflow", () => {
  it("plans every day as one undoable change and reports progress", async () => {
    mockFetch({
      "geocoding-api.open-meteo.com": () => lisbonGeocoding,
      ...weatherRoutes
    });
    await using introspector = await introspectWorkflow(env.PLAN_TRIP);
    await introspector.modifyAll(async (m) => {
      await m.mockStepResult(
        { name: "outline days" },
        {
          lodging: { area: "Baixa", nightlyMin: 90, nightlyMax: 130 },
          days: [
            { date: DATES[0], theme: "Alfama & the castle", dayTrip: null },
            { date: DATES[1], theme: "Sintra palaces", dayTrip: "Sintra" },
            { date: DATES[2], theme: "Belém", dayTrip: null }
          ]
        }
      );
      for (const [k, date] of DATES.entries()) {
        await m.mockStepResult({ name: `plan ${date}` }, dayItems(k + 1));
      }
    });

    const stub = await newTrip();
    const { dates } = await stub.startPlanning();
    expect(dates).toEqual(DATES);

    const [instance] = await introspector.get();
    await instance.waitForStatus("complete");
    await waitForJob(stub, "done");

    const state = await runInDurableObject(stub, (a) => a.state);
    const trip = state.trip!;
    expect(trip.days.map((d) => d.theme)).toEqual([
      "Alfama & the castle",
      "Sintra palaces",
      "Belém"
    ]);
    expect(trip.days[1].dayTrip).toEqual({ destination: "Sintra" });
    expect(trip.days.every((d) => d.items.length === 2)).toBe(true);
    expect(trip.days[0].items[0].source).toBe("ai");
    expect(trip.lodging).toMatchObject({
      area: "Baixa",
      nightlyPrice: { min: 90, max: 130 },
      estimated: true
    });
    expect(state.job).toMatchObject({
      kind: "plan",
      status: "done",
      message: "Planned 3 days (6 items)",
      percent: 1
    });

    // One undo reverts the whole generated plan
    await stub.undo();
    const reverted = (await stub.getTrip())!;
    expect(reverted.days.every((d) => d.items.length === 0)).toBe(true);
    expect(reverted.lodging).toBeNull();
  });

  it("re-plans a single day around locked items", async () => {
    await using introspector = await introspectWorkflow(env.PLAN_TRIP);
    await introspector.modifyAll(async (m) => {
      await m.mockStepResult({ name: `plan ${DATES[0]}` }, dayItems(9));
    });

    const stub = await newTrip();
    await stub.setDayInfo(DATES[0], { theme: "Old town" });
    await stub.addItem(DATES[0], {
      kind: "meal",
      title: "Fado dinner",
      startTime: "20:00"
    });
    await stub.addItem(DATES[0], { kind: "activity", title: "To be replaced" });
    const locked = (await stub.getTrip())!.days[0].items[0].id;
    await stub.setItemLocked(locked, true);

    await stub.startPlanning([DATES[0]], "less walking");
    const [instance] = await introspector.get();
    await instance.waitForStatus("complete");
    await waitForJob(stub, "done");

    const day = (await stub.getTrip())!.days[0];
    expect(day.theme).toBe("Old town");
    expect(day.items.map((i) => i.title)).toEqual([
      "Sight 9",
      "Lunch 9",
      "Fado dinner"
    ]);
    const job = await runInDurableObject(stub, (a) => a.state.job);
    expect(job?.message).toBe(`Re-planned ${DATES[0]} (2 items)`);
  });

  it("refuses to start while another job is running", async () => {
    await using introspector = await introspectWorkflow(env.PLAN_TRIP);
    await introspector.modifyAll(async (m) => {
      // Keep the workflow from finishing during the test
      await m.mockStepError(
        { name: "outline days" },
        new Error("slow model"),
        3
      );
    });
    const stub = await newTrip();
    await stub.startPlanning();
    await expect(
      runInDurableObject(stub, (a) => a.startPlanning())
    ).rejects.toThrow(/already working/);
  });
});

describe("ValidateTripWorkflow", () => {
  it("locates places and saves rule-review issues", async () => {
    mockFetch({
      "geocoding-api.open-meteo.com": () => lisbonGeocoding,
      ...weatherRoutes,
      "en.wikipedia.org": () => ({
        query: {
          pages: [{ index: 1, coordinates: [{ lat: 38.71389, lon: -9.13361 }] }]
        }
      })
    });
    await using introspector = await introspectWorkflow(env.VALIDATE_TRIP);

    const stub = await newTrip();
    await stub.addConstraint("avoid", "early mornings");
    await stub.addItem(DATES[0], {
      kind: "activity",
      title: "Castle at dawn",
      startTime: "07:00",
      place: { name: "São Jorge Castle" }
    });
    const itemId = (await stub.getTrip())!.days[0].items[0].id;

    await introspector.modifyAll(async (m) => {
      await m.mockStepResult({ name: "review rules" }, [
        {
          code: "review.constraint",
          severity: "warning",
          message: "Starts at 07:00 (your rule: avoid early mornings)",
          itemId
        }
      ]);
    });

    await stub.startCheck();
    const [instance] = await introspector.get();
    await instance.waitForStatus("complete");
    await waitForJob(stub, "done");

    const trip = (await stub.getTrip())!;
    expect(trip.days[0].items[0].place).toEqual({
      name: "São Jorge Castle",
      lat: 38.71389,
      lon: -9.13361
    });
    expect(trip.issues.map((i) => i.code)).toContain("review.constraint");
    const job = await runInDurableObject(stub, (a) => a.state.job);
    expect(job?.message).toMatch(
      /^Check finished: located 1 place, \d+ issues? found$/
    );
    // Locating places and saving checks are not undoable edits
    const state = await runInDurableObject(stub, (a) => a.state);
    expect(state.lastChange?.summary).toMatch(/Added "Castle at dawn"/);
  });
});
