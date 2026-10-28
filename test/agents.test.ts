import { getAgentByName } from "agents";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_SNAPSHOTS } from "../src/agents/trip-agent";
import { details } from "./fixtures";

/**
 * Run a call that should fail inside the Durable Object. Rejections that cross
 * the test plugin's RPC wrapper are also reported as unhandled, so expected
 * failures are asserted in-object instead.
 */
function inObject<T extends Rpc.DurableObjectBranded, R>(
  stub: DurableObjectStub<T>,
  fn: (instance: T) => R | Promise<R>
) {
  return runInDurableObject(stub, fn);
}

async function setup(userId = crypto.randomUUID()) {
  const directory = await getAgentByName(env.UserDirectory, userId);
  const summary = await directory.createTrip(details());
  const trip = await getAgentByName(env.TripAgent, summary.id);
  return { userId, directory, summary, trip };
}

describe("UserDirectory", () => {
  it("creates a trip and lists it", async () => {
    const { directory, summary, trip } = await setup();
    expect(summary).toMatchObject({
      title: "Lisbon long weekend",
      destination: "Lisbon",
      startDate: "2026-11-12",
      endDate: "2026-11-14"
    });
    expect(await directory.listTrips()).toEqual([summary]);

    const state = await trip.getTrip();
    expect(state?.days).toHaveLength(3);
  });

  it("rejects invalid trip details without listing anything", async () => {
    const directory = await getAgentByName(env.UserDirectory, "invalid-user");
    await expect(
      inObject(directory, (d) =>
        d.createTrip(details({ endDate: "2026-01-01" }))
      )
    ).rejects.toThrow(/End date/);
    expect(await directory.listTrips()).toEqual([]);
  });

  it("refreshes the summary when title or dates change", async () => {
    const { directory, trip } = await setup();
    await trip.updateDetails({ title: "Lisbon + Sintra" });
    const [listed] = await directory.listTrips();
    expect(listed.title).toBe("Lisbon + Sintra");
  });

  it("deletes a trip from the list", async () => {
    const { directory, summary } = await setup();
    await directory.deleteTrip(summary.id);
    expect(await directory.listTrips()).toEqual([]);
    await expect(
      inObject(directory, (d) => d.deleteTrip(summary.id))
    ).rejects.toThrow(/not found/);
  });
});

describe("TripAgent", () => {
  it("cannot be initialized twice", async () => {
    const { userId, trip } = await setup();
    await expect(
      inObject(trip, (t) =>
        t.initialize({ ownerId: userId, details: details() })
      )
    ).rejects.toThrow(/already initialized/);
  });

  it("applies edits, bumps version and records the change", async () => {
    const { trip } = await setup();
    const result = await trip.addItem("2026-11-12", {
      kind: "meal",
      title: "Time Out Market",
      startTime: "13:00"
    });
    expect(result).toEqual({
      summary: 'Added "Time Out Market" on 2026-11-12',
      version: 1
    });
    const state = await trip.getTrip();
    expect(state?.days[0].items[0]).toMatchObject({
      title: "Time Out Market",
      source: "user"
    });
  });

  it("surfaces validation errors and leaves the trip unchanged", async () => {
    const { trip } = await setup();
    await expect(
      inObject(trip, (t) =>
        t.addItem("2026-11-12", { kind: "meal", title: "" })
      )
    ).rejects.toThrow(/title/);
    expect((await trip.getTrip())?.version).toBe(0);
  });

  it("undoes changes in reverse order", async () => {
    const { trip } = await setup();
    await trip.addItem("2026-11-12", { kind: "meal", title: "Lunch" });
    await trip.updateDetails({ travellers: 4 });

    const undo1 = await trip.undo();
    expect(undo1.summary).toMatch(/Undid: Updated trip details/);
    let state = await trip.getTrip();
    expect(state?.details.travellers).toBe(2);
    expect(state?.days[0].items).toHaveLength(1);
    expect(state?.version).toBe(3);

    await trip.undo();
    state = await trip.getTrip();
    expect(state?.days[0].items).toHaveLength(0);

    await expect(inObject(trip, (t) => t.undo())).rejects.toThrow(
      /Nothing to undo/
    );
  });

  it("undo of a title change also refreshes the directory", async () => {
    const { directory, trip } = await setup();
    await trip.updateDetails({ title: "Renamed" });
    await trip.undo();
    const [listed] = await directory.listTrips();
    expect(listed.title).toBe("Lisbon long weekend");
  });

  it(`keeps at most ${MAX_SNAPSHOTS} snapshots`, async () => {
    const { trip } = await setup();
    for (let i = 0; i < MAX_SNAPSHOTS + 5; i++) {
      await trip.updateDetails({ travellers: (i % 10) + 1 });
    }
    for (let i = 0; i < MAX_SNAPSHOTS; i++) await trip.undo();
    await expect(inObject(trip, (t) => t.undo())).rejects.toThrow(
      /Nothing to undo/
    );
  });
});
