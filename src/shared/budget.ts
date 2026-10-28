import type { Trip } from "./schema";

/** Item costs plus lodging (midpoint of the nightly band × nights). */
export function estimatedTotal(trip: Trip): number {
  let total = 0;
  for (const day of trip.days) {
    for (const item of day.items) total += item.cost?.amount ?? 0;
  }
  const band = trip.lodging?.nightlyPrice;
  if (band) {
    const nights = Math.max(trip.days.length - 1, 0);
    total += ((band.min + band.max) / 2) * nights;
  }
  return Math.round(total);
}
