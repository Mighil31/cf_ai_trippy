import { describe, expect, it } from "vitest";
import { parseTimeRules, runChecks } from "../src/agents/validate";
import type { ItemInput, Trip } from "../src/shared/schema";
import * as ops from "../src/shared/trip-ops";
import { ctx, details } from "./fixtures";

const DAY1 = "2026-11-12";
const LISBON = { lat: 38.7223, lon: -9.1393 };

function trip(overrides = {}): Trip {
  const t = ops.createTrip(
    { id: "t", ownerId: "u", details: details(overrides) },
    "2026-10-29T00:00:00.000Z"
  );
  t.details.destination = { ...t.details.destination, ...LISBON };
  return t;
}

function withItems(t: Trip, date: string, items: ItemInput[]): Trip {
  return ops.replaceDayItems(t, { date, items }, ctx("ai")).trip;
}

const codes = (t: Trip) => runChecks(t).map((i) => i.code);

describe("runChecks", () => {
  it("is quiet for a fresh, empty trip", () => {
    expect(runChecks(trip())).toEqual([]);
  });

  it("flags overlapping items", () => {
    const t = withItems(trip(), DAY1, [
      {
        kind: "activity",
        title: "Castle",
        startTime: "10:00",
        endTime: "12:30"
      },
      { kind: "meal", title: "Lunch", startTime: "12:00", endTime: "13:00" }
    ]);
    const [issue] = runChecks(t).filter((i) => i.code === "overlap");
    expect(issue).toMatchObject({ severity: "error", date: DAY1 });
    expect(issue.message).toMatch(/"Castle" \(until 12:30\) overlaps "Lunch"/);
  });

  it("flags gaps too short for the travel between places", () => {
    const t = withItems(trip(), DAY1, [
      {
        kind: "activity",
        title: "Castle",
        startTime: "10:00",
        endTime: "12:00",
        place: { name: "Castle", lat: 38.7139, lon: -9.1335 }
      },
      {
        kind: "activity",
        title: "Belém Tower",
        startTime: "12:05",
        endTime: "13:00",
        place: { name: "Belém Tower", lat: 38.6916, lon: -9.2161 }
      }
    ]);
    const [issue] = runChecks(t).filter((i) => i.code === "travel_gap");
    expect(issue.message).toMatch(/only 5 min/);
  });

  it("doesn't flag travel when one side is a transit item", () => {
    const t = withItems(trip(), DAY1, [
      {
        kind: "activity",
        title: "Castle",
        startTime: "10:00",
        endTime: "12:00",
        place: { name: "Castle", lat: 38.7139, lon: -9.1335 }
      },
      {
        kind: "transit",
        title: "Tram to Belém",
        startTime: "12:00",
        endTime: "12:40",
        place: { name: "Belém", lat: 38.6916, lon: -9.2161 }
      }
    ]);
    expect(codes(t)).not.toContain("travel_gap");
  });

  it("flags too many activities for the pace", () => {
    const items: ItemInput[] = ["A", "B", "C", "D"].map((title) => ({
      kind: "activity",
      title
    }));
    expect(codes(withItems(trip({ pace: "relaxed" }), DAY1, items))).toContain(
      "long_day"
    );
    expect(
      codes(withItems(trip({ pace: "moderate" }), DAY1, items))
    ).not.toContain("long_day");
  });

  it("notes outdoor plans on wet days", () => {
    let t = withItems(trip(), DAY1, [
      { kind: "activity", title: "Miradouro da Graça viewpoint" },
      { kind: "activity", title: "Gulbenkian Museum" }
    ]);
    t.days[0].weather = {
      summary: "Rain",
      precipitationChance: 80,
      basis: "forecast"
    };
    const rain = runChecks(t).filter((i) => i.code === "outdoor_in_rain");
    expect(rain).toHaveLength(1);
    expect(rain[0].message).toMatch(/Miradouro.*the forecast says rain/);
  });

  it("flags going over, or close to, the budget", () => {
    const pricey = (amount: number) =>
      withItems(trip({ budget: { amount: 100, currency: "EUR" } }), DAY1, [
        { kind: "meal", title: "Dinner", cost: { amount, estimated: true } }
      ]);
    expect(codes(pricey(120))).toContain("over_budget");
    expect(codes(pricey(95))).toContain("near_budget");
    expect(codes(pricey(50))).toEqual(["empty_day", "empty_day"]);
  });

  it("flags day-trip places too far away", () => {
    let t = withItems(trip(), DAY1, [
      {
        kind: "activity",
        title: "Porto riverside",
        place: { name: "Ribeira", lat: 41.1405, lon: -8.6131 }
      }
    ]);
    t = ops.setDayInfo(t, {
      date: DAY1,
      patch: { dayTrip: { destination: "Porto" } }
    }).trip;
    expect(codes(t)).toContain("day_trip_far");
  });

  it("orders errors first and keeps relevant review issues only", () => {
    let t = withItems(trip(), DAY1, [
      { kind: "activity", title: "A", startTime: "10:00", endTime: "12:00" },
      { kind: "activity", title: "B", startTime: "11:00", endTime: "13:00" }
    ]);
    const kept = t.days[0].items[0].id;
    t = {
      ...t,
      issues: [
        {
          code: "review.constraint",
          severity: "warning",
          message: "kept",
          itemId: kept
        },
        {
          code: "review.constraint",
          severity: "warning",
          message: "stale",
          itemId: "gone00"
        },
        { code: "overlap", severity: "error", message: "old check result" }
      ]
    };
    const issues = runChecks(t);
    expect(issues[0].code).toBe("overlap");
    expect(issues.map((i) => i.message)).toContain("kept");
    expect(issues.map((i) => i.message)).not.toContain("stale");
    expect(issues.map((i) => i.message)).not.toContain("old check result");
  });
});

describe("time rules", () => {
  function withRule(text: string, items: ItemInput[]) {
    const t = withItems(trip(), DAY1, items);
    return ops.addConstraint(t, { kind: "avoid", text }, ctx()).trip;
  }

  it("parses common phrasings and ignores non-times", () => {
    const t = [
      "nothing before 9:30",
      "back by 10pm",
      "no museums after 2 museums"
    ].reduce(
      (acc, text) =>
        ops.addConstraint(acc, { kind: "avoid", text }, ctx()).trip,
      trip()
    );
    expect(parseTimeRules(t)).toEqual([
      { constraintText: "nothing before 9:30", kind: "start", time: "09:30" },
      { constraintText: "back by 10pm", kind: "end", time: "22:00" }
    ]);
  });

  it("flags items starting too early, exactly at the limit is fine", () => {
    const t = withRule("nothing before 9:30", [
      { kind: "activity", title: "On time", startTime: "09:30" },
      { kind: "meal", title: "Too early", startTime: "09:00" },
      { kind: "transit", title: "Taxi", startTime: "08:00" }
    ]);
    const issues = runChecks(t).filter((i) => i.code === "rule_time");
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe(
      'Thu 12 Nov: "Too early" starts at 09:00 (your rule: nothing before 9:30).'
    );
  });

  it("flags items ending too late", () => {
    const t = withRule("back by 10pm", [
      { kind: "meal", title: "Fado", startTime: "21:00", endTime: "23:00" }
    ]);
    expect(codes(t)).toContain("rule_time");
  });
});
