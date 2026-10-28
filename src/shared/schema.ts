import { z } from "zod";

/** Shared trip data model. Used by the Worker, the agents and the UI. */

export const MAX_TRIP_DAYS = 30;
export const MAX_ITEMS_PER_DAY = 20;

export const IsoDate = z.iso.date();
export const TimeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM (24h)");
export const CurrencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, "Expected a 3-letter ISO currency code");

export const Pace = z.enum(["relaxed", "moderate", "packed"]);

export const Destination = z.object({
  name: z.string().trim().min(1).max(120),
  country: z.string().max(80).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  timezone: z.string().max(64).optional()
});

export const Budget = z.object({
  amount: z.number().nonnegative().max(10_000_000),
  currency: CurrencyCode
});

const TripDetailsShape = z.object({
  title: z.string().trim().min(1).max(120),
  destination: Destination,
  startDate: IsoDate,
  endDate: IsoDate,
  travellers: z.int().min(1).max(20),
  budget: Budget,
  interests: z.array(z.string().trim().min(1).max(40)).max(20),
  pace: Pace,
  notes: z.string().max(2000).optional()
});

export const TripDetails = TripDetailsShape.superRefine((d, ctx) => {
  const days = tripLength(d.startDate, d.endDate);
  if (days < 1) {
    ctx.addIssue({
      code: "custom",
      path: ["endDate"],
      message: "End date must be on or after the start date"
    });
  } else if (days > MAX_TRIP_DAYS) {
    ctx.addIssue({
      code: "custom",
      path: ["endDate"],
      message: `Trips can be at most ${MAX_TRIP_DAYS} days`
    });
  }
});

/** Partial update of trip details; the merged result is re-validated. */
export const TripDetailsPatch = TripDetailsShape.partial();

export const ConstraintKind = z.enum(["must", "avoid", "preference"]);

export const Constraint = z.object({
  id: z.string(),
  kind: ConstraintKind,
  text: z.string().trim().min(1).max(300)
});

export const ItemKind = z.enum([
  "activity",
  "meal",
  "transit",
  "lodging",
  "free_time"
]);

export const Place = z.object({
  name: z.string().trim().min(1).max(160),
  address: z.string().max(300).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional()
});

export const Cost = z.object({
  /** Total for the whole group, in the trip currency. */
  amount: z.number().nonnegative().max(1_000_000),
  /** Prices are LLM or heuristic estimates unless the user entered them. */
  estimated: z.boolean()
});

export const Source = z.enum(["ai", "user"]);

const ItemFields = z.object({
  kind: ItemKind,
  title: z.string().trim().min(1).max(160),
  description: z.string().max(1000).optional(),
  place: Place.optional(),
  startTime: TimeOfDay.optional(),
  endTime: TimeOfDay.optional(),
  cost: Cost.optional(),
  notes: z.string().max(1000).optional()
});

function endAfterStart(
  i: { startTime?: string; endTime?: string },
  ctx: z.RefinementCtx
) {
  if (i.startTime && i.endTime && i.endTime <= i.startTime) {
    ctx.addIssue({
      code: "custom",
      path: ["endTime"],
      message: "End time must be after start time"
    });
  }
}

export const Item = ItemFields.extend({
  id: z.string(),
  locked: z.boolean(),
  source: Source
}).superRefine(endAfterStart);

/** What a caller supplies to create an item; the id/source are assigned. */
export const ItemInput = ItemFields.superRefine(endAfterStart);

/** Partial update of an item; the merged result is re-validated as an Item. */
export const ItemPatch = ItemFields.partial();

export const WeatherSummary = z.object({
  summary: z.string().max(120),
  tempMinC: z.number().optional(),
  tempMaxC: z.number().optional(),
  precipitationChance: z.number().min(0).max(100).optional(),
  /** "forecast" for real forecasts, "climate" for historical averages. */
  basis: z.enum(["forecast", "climate"])
});

export const DayTrip = z.object({
  destination: z.string().trim().min(1).max(120)
});

export const Day = z.object({
  date: IsoDate,
  theme: z.string().max(120).optional(),
  dayTrip: DayTrip.optional(),
  weather: WeatherSummary.optional(),
  items: z.array(Item).max(MAX_ITEMS_PER_DAY)
});

export const DayInfoPatch = z.object({
  theme: z.string().max(120).nullable().optional(),
  dayTrip: DayTrip.nullable().optional()
});

export const Lodging = z.object({
  area: z.string().trim().min(1).max(160),
  description: z.string().max(1000).optional(),
  nightlyPrice: z
    .object({
      min: z.number().nonnegative(),
      max: z.number().nonnegative()
    })
    .refine((p) => p.max >= p.min, "max must be >= min")
    .optional(),
  estimated: z.boolean()
});

export const IssueSeverity = z.enum(["info", "warning", "error"]);

export const Issue = z.object({
  code: z.string(),
  severity: IssueSeverity,
  message: z.string(),
  date: IsoDate.optional(),
  itemId: z.string().optional()
});

export const Trip = z.object({
  id: z.string(),
  ownerId: z.string(),
  details: TripDetails,
  constraints: z.array(Constraint).max(50),
  days: z.array(Day),
  lodging: Lodging.nullable(),
  issues: z.array(Issue),
  version: z.int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
});

export const TripSummary = z.object({
  id: z.string(),
  title: z.string(),
  destination: z.string(),
  startDate: IsoDate,
  endDate: IsoDate,
  updatedAt: z.iso.datetime()
});

export type Pace = z.infer<typeof Pace>;
export type Destination = z.infer<typeof Destination>;
export type TripDetails = z.infer<typeof TripDetails>;
export type TripDetailsPatch = z.infer<typeof TripDetailsPatch>;
export type ConstraintKind = z.infer<typeof ConstraintKind>;
export type Constraint = z.infer<typeof Constraint>;
export type ItemKind = z.infer<typeof ItemKind>;
export type Item = z.infer<typeof Item>;
export type ItemInput = z.infer<typeof ItemInput>;
export type ItemPatch = z.infer<typeof ItemPatch>;
export type Source = z.infer<typeof Source>;
export type WeatherSummary = z.infer<typeof WeatherSummary>;
export type Day = z.infer<typeof Day>;
export type DayInfoPatch = z.infer<typeof DayInfoPatch>;
export type Lodging = z.infer<typeof Lodging>;
export type Issue = z.infer<typeof Issue>;
export type Trip = z.infer<typeof Trip>;
export type TripSummary = z.infer<typeof TripSummary>;

/** Number of calendar days from start to end, inclusive. */
export function tripLength(startDate: string, endDate: string): number {
  const ms = Date.parse(endDate) - Date.parse(startDate);
  return Math.round(ms / 86_400_000) + 1;
}

/** Every ISO date from start to end, inclusive. */
export function datesBetween(startDate: string, endDate: string): string[] {
  const n = tripLength(startDate, endDate);
  const start = Date.parse(startDate);
  return Array.from({ length: Math.max(n, 0) }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10)
  );
}
