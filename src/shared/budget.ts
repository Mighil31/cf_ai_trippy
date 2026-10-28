import type { ItemKind, Trip } from "./schema";

export type BudgetCategory =
  | "lodging"
  | "food"
  | "activities"
  | "transport"
  | "other";

export const CATEGORY_LABEL: Record<BudgetCategory, string> = {
  lodging: "Lodging",
  food: "Food & drink",
  activities: "Activities",
  transport: "Getting around",
  other: "Other"
};

const CATEGORY_BY_KIND: Record<ItemKind, BudgetCategory> = {
  meal: "food",
  activity: "activities",
  transit: "transport",
  lodging: "lodging",
  free_time: "other"
};

export type BudgetBreakdown = {
  total: number;
  byCategory: Record<BudgetCategory, number>;
  byDay: { date: string; total: number }[];
  /** Lodging estimate from the suggested nightly range (midpoint × nights). */
  lodgingEstimate: number;
};

export function budgetBreakdown(trip: Trip): BudgetBreakdown {
  const byCategory: Record<BudgetCategory, number> = {
    lodging: 0,
    food: 0,
    activities: 0,
    transport: 0,
    other: 0
  };
  const byDay = trip.days.map((day) => {
    let total = 0;
    for (const item of day.items) {
      const amount = item.cost?.amount ?? 0;
      byCategory[CATEGORY_BY_KIND[item.kind]] += amount;
      total += amount;
    }
    return { date: day.date, total: Math.round(total) };
  });

  const band = trip.lodging?.nightlyPrice;
  const nights = Math.max(trip.days.length - 1, 0);
  const lodgingEstimate = band ? ((band.min + band.max) / 2) * nights : 0;
  byCategory.lodging += lodgingEstimate;

  for (const key of Object.keys(byCategory) as BudgetCategory[]) {
    byCategory[key] = Math.round(byCategory[key]);
  }
  const total = Object.values(byCategory).reduce((a, b) => a + b, 0);
  return {
    total,
    byCategory,
    byDay,
    lodgingEstimate: Math.round(lodgingEstimate)
  };
}

/** Item costs plus lodging (midpoint of the nightly band × nights). */
export function estimatedTotal(trip: Trip): number {
  return budgetBreakdown(trip).total;
}
