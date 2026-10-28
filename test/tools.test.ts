import { getAgentByName } from "agents";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { renderTrip } from "../src/agents/prompt";
import { budgetBreakdown, estimatedTotal } from "../src/shared/budget";
import type { TripAgent } from "../src/agents/trip-agent";
import { createTripTools, type ToolResult } from "../src/agents/tools";
import { details } from "./fixtures";

type Tools = ReturnType<typeof createTripTools>;

async function newTrip() {
  const directory = await getAgentByName(
    env.UserDirectory,
    crypto.randomUUID()
  );
  const { id } = await directory.createTrip(details());
  return getAgentByName(env.TripAgent, id);
}

/** Call a tool the way the AI SDK would, inside the trip's Durable Object. */
function callTool<K extends keyof Tools>(
  stub: DurableObjectStub<TripAgent>,
  name: K,
  input: Parameters<NonNullable<Tools[K]["execute"]>>[0]
): Promise<ToolResult> {
  return runInDurableObject(stub, async (agent) => {
    const tool = createTripTools(agent)[name];
    // Parse like the AI SDK does before execute (coercion, id clean-up)
    const parsed = (tool.inputSchema as z.ZodType).parse(input);
    // oxlint-disable-next-line typescript/no-explicit-any -- tool input unions
    return (await tool.execute!(parsed as any, {
      toolCallId: "test",
      messages: []
    })) as ToolResult;
  });
}

describe("trip tools", () => {
  it("add_item returns a short id and marks the item as AI-sourced", async () => {
    const stub = await newTrip();
    const result = await callTool(stub, "add_item", {
      date: "2026-11-12",
      kind: "meal",
      title: "Pastéis de Belém",
      startTime: "10:00",
      endTime: "10:45",
      placeName: "Belém",
      estimatedCost: 12
    });
    expect(result).toMatchObject({ ok: true });
    const itemId = (result as { itemId: string }).itemId;
    expect(itemId).toMatch(/^[0-9a-f]{6}$/);

    const trip = await stub.getTrip();
    expect(trip?.days[0].items[0]).toMatchObject({
      id: itemId,
      source: "ai",
      place: { name: "Belém" },
      cost: { amount: 12, estimated: true }
    });
  });

  it("add_item stores place coordinates when both are given", async () => {
    const stub = await newTrip();
    await callTool(stub, "add_item", {
      date: "2026-11-12",
      kind: "activity",
      title: "Pena Palace",
      placeName: "Pena Palace",
      placeLat: 38.7876,
      placeLon: -9.3906
    });
    expect((await stub.getTrip())?.days[0].items[0].place).toEqual({
      name: "Pena Palace",
      lat: 38.7876,
      lon: -9.3906
    });
  });

  it("returns ok:false with the reason instead of throwing", async () => {
    const stub = await newTrip();
    const result = await callTool(stub, "add_item", {
      date: "2030-01-01",
      kind: "meal",
      title: "Nowhere"
    });
    expect(result).toEqual({
      ok: false,
      error: "No day 2030-01-01 in this trip"
    });
  });

  it("refuses to touch locked items", async () => {
    const stub = await newTrip();
    await stub.addItem("2026-11-12", { kind: "meal", title: "Dinner" });
    const id = (await stub.getTrip())!.days[0].items[0].id;
    await stub.setItemLocked(id, true);

    const result = await callTool(stub, "remove_item", { itemId: id });
    expect(result).toMatchObject({ ok: false, error: /locked/ });
    expect((await stub.getTrip())?.days[0].items).toHaveLength(1);
  });

  it("update_item only changes the given fields", async () => {
    const stub = await newTrip();
    await stub.addItem("2026-11-12", {
      kind: "activity",
      title: "Castle",
      startTime: "10:00"
    });
    const id = (await stub.getTrip())!.days[0].items[0].id;
    await callTool(stub, "update_item", { itemId: id, endTime: "12:00" });
    expect((await stub.getTrip())?.days[0].items[0]).toMatchObject({
      title: "Castle",
      startTime: "10:00",
      endTime: "12:00"
    });
  });

  it("accepts ids quoted with brackets or an id: prefix", async () => {
    const stub = await newTrip();
    await stub.addItem("2026-11-12", { kind: "meal", title: "Lunch" });
    const id = (await stub.getTrip())!.days[0].items[0].id;

    expect(
      await callTool(stub, "update_item", {
        itemId: `[${id}]`,
        startTime: "13:00"
      })
    ).toMatchObject({ ok: true });
    expect(
      await callTool(stub, "remove_item", { itemId: `id: ${id}` })
    ).toMatchObject({ ok: true });
  });

  it("coerces numbers sent as strings", async () => {
    const stub = await newTrip();
    const result = await callTool(stub, "add_item", {
      date: "2026-11-12",
      kind: "meal",
      title: "Dinner",
      // oxlint-disable-next-line typescript/no-explicit-any -- model quirk
      estimatedCost: "50" as any
    });
    expect(result).toMatchObject({ ok: true });
    expect((await stub.getTrip())?.days[0].items[0].cost?.amount).toBe(50);
  });

  it("update_trip_details merges budget fields", async () => {
    const stub = await newTrip();
    await callTool(stub, "update_trip_details", { currency: "usd" });
    expect((await stub.getTrip())?.details.budget).toEqual({
      amount: 1500,
      currency: "USD"
    });
  });

  it("set_day_info sets and cancels day trips", async () => {
    const stub = await newTrip();
    await callTool(stub, "set_day_info", {
      date: "2026-11-13",
      dayTripDestination: "Sintra",
      theme: "Palaces"
    });
    expect((await stub.getTrip())?.days[1].dayTrip).toEqual({
      destination: "Sintra"
    });
    await callTool(stub, "set_day_info", {
      date: "2026-11-13",
      cancelDayTrip: true
    });
    const day = (await stub.getTrip())!.days[1];
    expect(day.dayTrip).toBeUndefined();
    expect(day.theme).toBe("Palaces");
  });

  it("add_constraint returns its id; undo_last_change reverts", async () => {
    const stub = await newTrip();
    const added = await callTool(stub, "add_constraint", {
      kind: "avoid",
      text: "early mornings"
    });
    expect(added).toMatchObject({ ok: true, constraintId: /^[0-9a-f]{6}$/ });

    const undone = await callTool(stub, "undo_last_change", {});
    expect(undone).toMatchObject({ ok: true, summary: /Undid/ });
    expect((await stub.getTrip())?.constraints).toEqual([]);

    expect(await callTool(stub, "undo_last_change", {})).toEqual({
      ok: false,
      error: "Nothing to undo"
    });
  });
});

describe("renderTrip", () => {
  it("shows ids, times, costs, locks and the running total", async () => {
    const stub = await newTrip();
    await stub.addItem("2026-11-12", {
      kind: "meal",
      title: "Lunch",
      startTime: "13:00",
      endTime: "14:00",
      cost: { amount: 40, estimated: true }
    });
    const id = (await stub.getTrip())!.days[0].items[0].id;
    await stub.setItemLocked(id, true);
    await stub.setLodging({
      area: "Baixa",
      nightlyPrice: { min: 100, max: 140 },
      estimated: true
    });

    const trip = (await stub.getTrip())!;
    const text = renderTrip(trip);
    expect(text).toContain(
      `[${id}] 13:00-14:00 meal: Lunch (40 EUR est.) [LOCKED]`
    );
    expect(text).toContain("Day 2 2026-11-13\n  (empty)");
    // 40 + 120/night midpoint × 2 nights
    expect(estimatedTotal(trip)).toBe(280);
    expect(text).toContain("Estimated cost so far: 280 EUR of 1500 EUR");
  });
});

describe("budgetBreakdown", () => {
  it("splits costs by category and day, including lodging nights", async () => {
    const stub = await newTrip();
    await stub.addItem("2026-11-12", {
      kind: "meal",
      title: "Lunch",
      cost: { amount: 40, estimated: true }
    });
    await stub.addItem("2026-11-12", {
      kind: "activity",
      title: "Castle",
      cost: { amount: 30, estimated: true }
    });
    await stub.addItem("2026-11-13", {
      kind: "transit",
      title: "Train",
      cost: { amount: 10.4, estimated: true }
    });
    await stub.setLodging({
      area: "Baixa",
      nightlyPrice: { min: 100, max: 140 },
      estimated: true
    });
    const b = budgetBreakdown((await stub.getTrip())!);
    expect(b.byCategory).toEqual({
      lodging: 240,
      food: 40,
      activities: 30,
      transport: 10,
      other: 0
    });
    expect(b.byDay.map((d) => d.total)).toEqual([70, 10, 0]);
    expect(b.total).toBe(320);
  });
});
