import { describe, expect, it } from "vitest";
import { LlmOutputError, extractJson, parseJson } from "../src/agents/llm";
import {
  DayPlan,
  Skeleton,
  categoriesFor,
  dayPrompt,
  skeletonPrompt,
  toItemInputs
} from "../src/agents/planner";
import { ItemInput } from "../src/shared/schema";
import { reviewToIssues } from "../src/workflows/validate-trip";
import * as ops from "../src/shared/trip-ops";
import { details } from "./fixtures";

describe("extractJson", () => {
  it("reads JSON wrapped in prose or code fences", () => {
    expect(extractJson('Here you go:\n{"a": 1}\nEnjoy!')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a": {"b": 2}}\n```')).toEqual({
      a: { b: 2 }
    });
  });

  it("throws LlmOutputError on missing or broken JSON", () => {
    expect(() => extractJson("no json here")).toThrow(LlmOutputError);
    expect(() => extractJson('{"a": 1,}')).toThrow(/not valid JSON/);
  });

  it("parseJson reports schema mismatches", () => {
    expect(() => parseJson(Skeleton, '{"days": "nope"}')).toThrow(
      /didn't match the schema/
    );
  });
});

describe("DayPlan parsing", () => {
  it("normalises sloppy model output", () => {
    const plan = parseJson(
      DayPlan,
      JSON.stringify({
        items: [
          {
            kind: "Activity",
            title: "Castle",
            startTime: "9:30",
            endTime: "11.30",
            placeName: "São Jorge Castle",
            lat: "38.7139",
            lon: -9.1335,
            cost: "30"
          },
          {
            kind: "lunch break",
            title: "Lunch",
            startTime: "13:00",
            endTime: "12:00",
            placeName: null,
            lat: null,
            cost: null
          },
          { kind: "free time", title: "Wander", startTime: "later" }
        ]
      })
    );
    const items = toItemInputs(plan);
    expect(items[0]).toEqual({
      kind: "activity",
      title: "Castle",
      startTime: "09:30",
      endTime: "11:30",
      place: { name: "São Jorge Castle", lat: 38.7139, lon: -9.1335 },
      cost: { amount: 30, estimated: true }
    });
    // Unknown kind falls back to activity; end before start is dropped
    expect(items[1]).toEqual({
      kind: "activity",
      title: "Lunch",
      startTime: "13:00"
    });
    expect(items[2]).toEqual({ kind: "free_time", title: "Wander" });
    for (const item of items)
      expect(ItemInput.safeParse(item).success).toBe(true);
  });
});

describe("prompts", () => {
  const trip = ops.createTrip(
    { id: "t", ownerId: "u", details: details() },
    "2026-10-29T00:00:00.000Z"
  );

  it("only offers day trips for trips of three days or more", () => {
    expect(skeletonPrompt(trip, ["2026-11-12"])).toMatch(/at most one day/);
    const short = ops.updateDetails(trip, { endDate: "2026-11-13" }).trip;
    expect(skeletonPrompt(short, ["2026-11-12"])).toMatch(/No day trips/);
  });

  it("asks for lodging only when none is set", () => {
    expect(skeletonPrompt(trip, ["2026-11-12"])).toMatch(/"lodging"/);
    const withLodging = ops.setLodging(trip, {
      area: "Baixa",
      estimated: true
    }).trip;
    expect(skeletonPrompt(withLodging, ["2026-11-12"])).not.toMatch(
      /"lodging"/
    );
  });

  it("day prompt lists locked items, candidates and places to avoid", () => {
    let t = ops.addItem(
      trip,
      {
        date: "2026-11-12",
        item: { kind: "meal", title: "Fado dinner", startTime: "20:00" }
      },
      { actor: "user", newId: () => "abc123" }
    ).trip;
    t = ops.setItemLocked(
      t,
      { itemId: "abc123", locked: true },
      { actor: "user", newId: () => "x" }
    ).trip;
    const prompt = dayPrompt({
      trip: t,
      day: t.days[0],
      outline: { date: "2026-11-12", theme: "Alfama" },
      candidates: [
        {
          name: "São Jorge Castle",
          kind: "Historic castle",
          lat: 38.71389,
          lon: -9.13361,
          distanceKm: 1.2,
          notable: true
        }
      ],
      alreadyPlanned: ["Belém Tower"],
      request: "more food"
    });
    expect(prompt).toContain("- 20:00 Fado dinner");
    expect(prompt).toContain(
      "- São Jorge Castle (Historic castle) lat 38.71389 lon -9.13361"
    );
    expect(prompt).toContain(
      "Don't repeat places from other days: Belém Tower"
    );
    expect(prompt).toContain('The traveller asked: "more food"');
  });

  it("picks extra search categories from interests", () => {
    expect(categoriesFor(["food", "history"])).toEqual([
      "sights",
      "food",
      "museums"
    ]);
    expect(categoriesFor(["sunset views", "hiking"])).toEqual([
      "sights",
      "food",
      "parks",
      "viewpoints"
    ]);
  });
});

describe("reviewToIssues", () => {
  const base = ops.createTrip(
    { id: "t", ownerId: "u", details: details() },
    "2026-10-29T00:00:00.000Z"
  );
  const t = ops.replaceDayItems(
    base,
    {
      date: "2026-11-13",
      items: [
        { kind: "activity", title: "Museum A" },
        { kind: "activity", title: "Museum B" },
        { kind: "activity", title: "Museum C" }
      ]
    },
    {
      actor: "ai",
      newId: (() => {
        let n = 0;
        return () => `m${++n}0000`;
      })()
    }
  ).trip;

  it("keeps violations backed by real item ids and names the day", () => {
    const issues = reviewToIssues(t, {
      rules: [
        {
          rule: "max two museums a day",
          violated: true,
          evidence: ["[m10000]", "m20000", "m30000"],
          explanation: "Three museums on one day."
        },
        { rule: "vegetarian", violated: false, evidence: [], explanation: "" }
      ]
    });
    expect(issues).toEqual([
      {
        code: "review.constraint",
        severity: "warning",
        message:
          'Fri 13 Nov: "Museum A", "Museum B", "Museum C" may break your rule "max two museums a day". Three museums on one day.',
        date: "2026-11-13"
      }
    ]);
  });

  it("drops claimed violations without valid evidence", () => {
    expect(
      reviewToIssues(t, {
        rules: [
          { rule: "x", violated: true, evidence: [], explanation: "" },
          { rule: "y", violated: true, evidence: ["nope00"], explanation: "" }
        ]
      })
    ).toEqual([]);
  });
});
