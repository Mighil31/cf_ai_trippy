import type { TripDetails } from "../src/shared/schema";
import type { OpContext } from "../src/shared/trip-ops";

export function details(overrides: Partial<TripDetails> = {}): TripDetails {
  return {
    title: "Lisbon long weekend",
    destination: { name: "Lisbon", country: "Portugal" },
    startDate: "2026-11-12",
    endDate: "2026-11-14",
    travellers: 2,
    budget: { amount: 1500, currency: "EUR" },
    interests: ["food", "history"],
    pace: "moderate",
    ...overrides
  };
}

/** Deterministic id generator: id-1, id-2, … */
export function ctx(actor: OpContext["actor"] = "user"): OpContext {
  let n = 0;
  return { actor, newId: () => `id-${++n}` };
}
