import { describe, expect, it } from "vitest";
import { MAX_ITEMS_PER_DAY, datesBetween } from "../src/shared/schema";
import * as ops from "../src/shared/trip-ops";
import { TripOpError } from "../src/shared/trip-ops";
import { ctx, details } from "./fixtures";

const NOW = "2026-10-29T10:00:00.000Z";

function newTrip(overrides = {}) {
  return ops.createTrip(
    { id: "trip-1", ownerId: "user-1", details: details(overrides) },
    NOW
  );
}

function expectOpError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(TripOpError);
    expect((err as TripOpError).code).toBe(code);
    return err as TripOpError;
  }
  throw new Error(`Expected TripOpError ${code}`);
}

describe("datesBetween", () => {
  it("is inclusive and crosses month boundaries", () => {
    expect(datesBetween("2026-10-30", "2026-11-02")).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02"
    ]);
  });
});

describe("createTrip", () => {
  it("creates one empty day per date", () => {
    const trip = newTrip();
    expect(trip.days.map((d) => d.date)).toEqual([
      "2026-11-12",
      "2026-11-13",
      "2026-11-14"
    ]);
    expect(trip.days.every((d) => d.items.length === 0)).toBe(true);
    expect(trip.version).toBe(0);
  });

  it("rejects end before start", () => {
    const err = expectOpError(
      () => newTrip({ startDate: "2026-11-14", endDate: "2026-11-12" }),
      "INVALID"
    );
    expect(err.message).toMatch(/End date/);
  });

  it("rejects trips longer than 30 days", () => {
    expectOpError(
      () => newTrip({ startDate: "2026-11-01", endDate: "2026-12-31" }),
      "INVALID"
    );
  });

  it("rejects bad currency codes", () => {
    expectOpError(
      () => newTrip({ budget: { amount: 100, currency: "euro" } }),
      "INVALID"
    );
  });
});

describe("updateDetails", () => {
  it("merges a partial patch", () => {
    const { trip } = ops.updateDetails(newTrip(), { travellers: 3 });
    expect(trip.details.travellers).toBe(3);
    expect(trip.details.title).toBe("Lisbon long weekend");
  });

  it("keeps items on surviving dates and reports dropped ones", () => {
    let trip = newTrip();
    trip = ops.addItem(
      trip,
      { date: "2026-11-12", item: { kind: "meal", title: "Pastéis" } },
      ctx()
    ).trip;
    trip = ops.addItem(
      trip,
      { date: "2026-11-14", item: { kind: "activity", title: "Belém" } },
      ctx()
    ).trip;

    const result = ops.updateDetails(trip, {
      startDate: "2026-11-11",
      endDate: "2026-11-13"
    });
    expect(result.trip.days.map((d) => d.date)).toEqual([
      "2026-11-11",
      "2026-11-12",
      "2026-11-13"
    ]);
    expect(result.trip.days[1].items[0].title).toBe("Pastéis");
    expect(result.summary).toMatch(/removed 1 item/);
  });

  it("re-validates the merged details", () => {
    expectOpError(
      () => ops.updateDetails(newTrip(), { endDate: "2026-11-01" }),
      "INVALID"
    );
  });

  it("does not mutate the input trip", () => {
    const trip = newTrip();
    ops.updateDetails(trip, { travellers: 5 });
    expect(trip.details.travellers).toBe(2);
  });
});

describe("items", () => {
  const day1 = "2026-11-12";

  it("inserts timed items chronologically and untimed at the end", () => {
    const c = ctx();
    let trip = newTrip();
    for (const item of [
      { kind: "meal", title: "Dinner", startTime: "19:00" },
      { kind: "free_time", title: "Wander" },
      { kind: "meal", title: "Breakfast", startTime: "08:00" },
      { kind: "activity", title: "Castle", startTime: "10:00" }
    ]) {
      trip = ops.addItem(trip, { date: day1, item }, c).trip;
    }
    expect(trip.days[0].items.map((i) => i.title)).toEqual([
      "Breakfast",
      "Castle",
      "Dinner",
      "Wander"
    ]);
  });

  it("assigns id, source and unlocked state", () => {
    const { trip } = ops.addItem(
      newTrip(),
      { date: day1, item: { kind: "activity", title: "Tram 28" } },
      ctx("ai")
    );
    expect(trip.days[0].items[0]).toMatchObject({
      id: "id-1",
      source: "ai",
      locked: false
    });
  });

  it("rejects end time before start time", () => {
    expectOpError(
      () =>
        ops.addItem(
          newTrip(),
          {
            date: day1,
            item: {
              kind: "activity",
              title: "X",
              startTime: "12:00",
              endTime: "11:00"
            }
          },
          ctx()
        ),
      "INVALID"
    );
  });

  it("rejects unknown dates", () => {
    expectOpError(
      () =>
        ops.addItem(
          newTrip(),
          { date: "2027-01-01", item: { kind: "meal", title: "X" } },
          ctx()
        ),
      "NOT_FOUND"
    );
  });

  it("enforces the per-day item limit", () => {
    const c = ctx();
    let trip = newTrip();
    for (let i = 0; i < MAX_ITEMS_PER_DAY; i++) {
      trip = ops.addItem(
        trip,
        { date: day1, item: { kind: "activity", title: `A${i}` } },
        c
      ).trip;
    }
    expectOpError(
      () =>
        ops.addItem(
          trip,
          { date: day1, item: { kind: "activity", title: "One more" } },
          c
        ),
      "LIMIT"
    );
  });

  it("updates and re-validates an item", () => {
    const c = ctx();
    let trip = ops.addItem(
      newTrip(),
      {
        date: day1,
        item: { kind: "meal", title: "Lunch", startTime: "12:00" }
      },
      c
    ).trip;
    trip = ops.updateItem(
      trip,
      { itemId: "id-1", patch: { endTime: "13:30" } },
      c
    ).trip;
    expect(trip.days[0].items[0].endTime).toBe("13:30");

    expectOpError(
      () =>
        ops.updateItem(
          trip,
          { itemId: "id-1", patch: { endTime: "11:00" } },
          c
        ),
      "INVALID"
    );
  });

  it("moves an item to another day in chronological position", () => {
    const c = ctx();
    let trip = newTrip();
    trip = ops.addItem(
      trip,
      {
        date: day1,
        item: { kind: "meal", title: "Lunch", startTime: "13:00" }
      },
      c
    ).trip;
    trip = ops.addItem(
      trip,
      {
        date: "2026-11-13",
        item: { kind: "activity", title: "Museum", startTime: "10:00" }
      },
      c
    ).trip;
    trip = ops.addItem(
      trip,
      {
        date: "2026-11-13",
        item: { kind: "meal", title: "Dinner", startTime: "19:00" }
      },
      c
    ).trip;

    const { trip: moved, summary } = ops.moveItem(
      trip,
      { itemId: "id-1", toDate: "2026-11-13" },
      c
    );
    expect(moved.days[0].items).toHaveLength(0);
    expect(moved.days[1].items.map((i) => i.title)).toEqual([
      "Museum",
      "Lunch",
      "Dinner"
    ]);
    expect(summary).toMatch(/to 2026-11-13/);
  });

  it("reorders within a day by explicit index", () => {
    const c = ctx();
    let trip = newTrip();
    for (const title of ["A", "B", "C"]) {
      trip = ops.addItem(
        trip,
        { date: day1, item: { kind: "activity", title } },
        c
      ).trip;
    }
    trip = ops.moveItem(
      trip,
      { itemId: "id-3", toDate: day1, toIndex: 0 },
      c
    ).trip;
    expect(trip.days[0].items.map((i) => i.title)).toEqual(["C", "A", "B"]);
  });

  it("removes an item", () => {
    const c = ctx();
    let trip = ops.addItem(
      newTrip(),
      { date: day1, item: { kind: "meal", title: "Lunch" } },
      c
    ).trip;
    trip = ops.removeItem(trip, { itemId: "id-1" }, c).trip;
    expect(trip.days[0].items).toHaveLength(0);
    expectOpError(
      () => ops.removeItem(trip, { itemId: "id-1" }, c),
      "NOT_FOUND"
    );
  });
});

describe("locking", () => {
  const day1 = "2026-11-12";

  function tripWithLockedItem() {
    const user = ctx("user");
    let trip = ops.addItem(
      newTrip(),
      {
        date: day1,
        item: { kind: "meal", title: "Dinner", startTime: "20:00" }
      },
      user
    ).trip;
    trip = ops.setItemLocked(trip, { itemId: "id-1", locked: true }, user).trip;
    return trip;
  }

  it("blocks AI edits, moves and removals of locked items", () => {
    const trip = tripWithLockedItem();
    const ai = ctx("ai");
    expectOpError(
      () => ops.updateItem(trip, { itemId: "id-1", patch: { title: "X" } }, ai),
      "LOCKED"
    );
    expectOpError(() => ops.removeItem(trip, { itemId: "id-1" }, ai), "LOCKED");
    expectOpError(
      () => ops.moveItem(trip, { itemId: "id-1", toDate: "2026-11-13" }, ai),
      "LOCKED"
    );
  });

  it("lets the user edit locked items", () => {
    const trip = tripWithLockedItem();
    const { trip: next } = ops.updateItem(
      trip,
      { itemId: "id-1", patch: { title: "Late dinner" } },
      ctx("user")
    );
    expect(next.days[0].items[0].title).toBe("Late dinner");
  });

  it("only lets the user unlock", () => {
    const trip = tripWithLockedItem();
    expectOpError(
      () =>
        ops.setItemLocked(trip, { itemId: "id-1", locked: false }, ctx("ai")),
      "FORBIDDEN"
    );
  });

  it("replaceDayItems keeps locked items and sorts by time", () => {
    const trip = tripWithLockedItem();
    const ai: ReturnType<typeof ctx> = {
      actor: "ai",
      newId: (() => {
        let n = 100;
        return () => `id-${++n}`;
      })()
    };
    const { trip: next, summary } = ops.replaceDayItems(
      trip,
      {
        date: day1,
        items: [
          { kind: "activity", title: "Alfama walk", startTime: "10:00" },
          { kind: "free_time", title: "Rest" },
          { kind: "meal", title: "Lunch", startTime: "13:00" }
        ]
      },
      ai
    );
    expect(next.days[0].items.map((i) => i.title)).toEqual([
      "Alfama walk",
      "Lunch",
      "Dinner",
      "Rest"
    ]);
    expect(next.days[0].items.find((i) => i.title === "Dinner")?.locked).toBe(
      true
    );
    expect(summary).toMatch(/kept 1 locked/);
  });
});

describe("day info, constraints, lodging", () => {
  it("sets and clears theme and day trip", () => {
    let trip = ops.setDayInfo(newTrip(), {
      date: "2026-11-13",
      patch: { theme: "Sintra", dayTrip: { destination: "Sintra" } }
    }).trip;
    expect(trip.days[1]).toMatchObject({
      theme: "Sintra",
      dayTrip: { destination: "Sintra" }
    });
    trip = ops.setDayInfo(trip, {
      date: "2026-11-13",
      patch: { dayTrip: null }
    }).trip;
    expect(trip.days[1].dayTrip).toBeUndefined();
    expect(trip.days[1].theme).toBe("Sintra");
  });

  it("adds and removes constraints", () => {
    const c = ctx();
    let trip = ops.addConstraint(
      newTrip(),
      { kind: "avoid", text: "No early mornings" },
      c
    ).trip;
    expect(trip.constraints).toEqual([
      { id: "id-1", kind: "avoid", text: "No early mornings" }
    ]);
    trip = ops.removeConstraint(trip, "id-1").trip;
    expect(trip.constraints).toEqual([]);
    expectOpError(
      () => ops.addConstraint(trip, { kind: "nope", text: "x" }, c),
      "INVALID"
    );
  });

  it("sets and clears lodging", () => {
    let trip = ops.setLodging(newTrip(), {
      area: "Baixa",
      nightlyPrice: { min: 90, max: 140 },
      estimated: true
    }).trip;
    expect(trip.lodging?.area).toBe("Baixa");
    expectOpError(
      () =>
        ops.setLodging(trip, {
          area: "Baixa",
          nightlyPrice: { min: 200, max: 100 },
          estimated: true
        }),
      "INVALID"
    );
    trip = ops.setLodging(trip, null).trip;
    expect(trip.lodging).toBeNull();
  });
});
