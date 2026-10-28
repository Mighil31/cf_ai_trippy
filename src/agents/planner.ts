import { z } from "zod";
import type { FoundPlace } from "../services/places";
import {
  IsoDate,
  ItemKind,
  MAX_ITEMS_PER_DAY,
  type Day,
  type ItemInput,
  type Trip
} from "../shared/schema";
import { MAX_ACTIVITIES } from "./validate";

/** Prompts and output schemas for PlanTripWorkflow's LLM steps. */

export const PLANNER_SYSTEM = `You are Trippy's itinerary planner. You produce realistic, specific travel plans as JSON.
- Use real, well-known places. Prefer places from the candidate lists you are given, and copy their name, lat and lon exactly.
- Times are local, 24h HH:MM. Leave time to travel between places.
- Costs are estimates in the trip currency for the whole group: entry tickets, meals, local transport. Free places cost 0.
- Respect the traveller's rules and pace.`;

/** "9:30" → "09:30"; anything unparseable becomes undefined. */
const LooseTime = z.preprocess((v) => {
  if (typeof v !== "string") return undefined;
  const m = v.trim().match(/^(\d{1,2})[:.h](\d{2})/);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}, z.string().optional());

const LooseKind = z.preprocess(
  (v) =>
    typeof v === "string" ? v.trim().toLowerCase().replace(/[\s-]/g, "_") : v,
  ItemKind.catch("activity")
);

const OptionalNumber = z.preprocess(
  (v) => (v === null || v === "" ? undefined : v),
  z.coerce.number().optional()
);

export const Skeleton = z.object({
  lodging: z
    .object({
      area: z.string().min(1),
      description: z.string().optional(),
      nightlyMin: OptionalNumber,
      nightlyMax: OptionalNumber
    })
    .nullable()
    .optional(),
  days: z.array(
    z.object({
      date: IsoDate,
      theme: z.string().min(1).max(120),
      dayTrip: z.string().nullable().optional()
    })
  )
});
export type Skeleton = z.infer<typeof Skeleton>;

export const DayPlan = z.object({
  items: z
    .array(
      z.object({
        kind: LooseKind,
        title: z.string().min(1).max(160),
        startTime: LooseTime,
        endTime: LooseTime,
        placeName: z.string().max(160).nullable().optional(),
        lat: OptionalNumber,
        lon: OptionalNumber,
        cost: OptionalNumber,
        description: z.string().max(1000).nullable().optional()
      })
    )
    .max(MAX_ITEMS_PER_DAY)
});
export type DayPlan = z.infer<typeof DayPlan>;

export type DayOutline = { date: string; theme: string; dayTrip?: string };

/** Turn planner output into validated item inputs, fixing what's fixable. */
export function toItemInputs(plan: DayPlan): ItemInput[] {
  return plan.items.map((p) => {
    const item: ItemInput = { kind: p.kind, title: p.title };
    if (p.startTime) item.startTime = p.startTime;
    if (p.endTime && (!p.startTime || p.endTime > p.startTime)) {
      item.endTime = p.endTime;
    }
    if (p.placeName) {
      item.place = { name: p.placeName };
      if (validLat(p.lat) && validLon(p.lon)) {
        item.place.lat = p.lat;
        item.place.lon = p.lon;
      }
    }
    if (p.cost !== undefined && p.cost >= 0) {
      item.cost = { amount: Math.round(p.cost), estimated: true };
    }
    if (p.description) item.description = p.description;
    return item;
  });
}

function validLat(n: number | undefined): n is number {
  return n !== undefined && Number.isFinite(n) && Math.abs(n) <= 90;
}
function validLon(n: number | undefined): n is number {
  return n !== undefined && Number.isFinite(n) && Math.abs(n) <= 180;
}

function tripBrief(trip: Trip): string {
  const d = trip.details;
  const lines = [
    `Destination: ${d.destination.name}${d.destination.country ? `, ${d.destination.country}` : ""}`,
    `Dates: ${d.startDate} to ${d.endDate}`,
    `Travellers: ${d.travellers}`,
    `Budget: ${d.budget.amount} ${d.budget.currency} total for everything`,
    `Pace: ${d.pace} (about ${MAX_ACTIVITIES[d.pace]} activities a day at most, plus meals)`,
    `Interests: ${d.interests.join(", ") || "general sightseeing"}`
  ];
  if (d.notes) lines.push(`Notes from the traveller: ${d.notes}`);
  if (trip.constraints.length) {
    lines.push("Rules from the traveller:");
    for (const c of trip.constraints) lines.push(`- ${c.kind}: ${c.text}`);
  }
  return lines.join("\n");
}

function weatherLine(day: Day): string {
  const w = day.weather;
  if (!w) return "weather unknown";
  const temps =
    w.tempMinC !== undefined ? ` ${w.tempMinC}-${w.tempMaxC}°C` : "";
  const rain =
    w.precipitationChance !== undefined
      ? `, ${w.precipitationChance}% rain`
      : "";
  return `${w.summary}${temps}${rain}${w.basis === "climate" ? " (typical)" : ""}`;
}

export function skeletonPrompt(
  trip: Trip,
  dates: string[],
  request?: string
): string {
  const days = trip.days.filter((d) => dates.includes(d.date));
  const allowDayTrip = trip.days.length >= 3;
  return `${tripBrief(trip)}

Plan the shape of these days (one theme per day, grouping nearby sights so each day stays in one or two areas):
${days.map((d) => `- ${d.date}: ${weatherLine(d)}${d.dayTrip ? ` (already a day trip to ${d.dayTrip.destination})` : ""}`).join("\n")}
${
  allowDayTrip
    ? "You may make at most one day a day trip to a nearby town (under 1.5 hours away), if it suits the interests. Prefer a dry day for it."
    : "No day trips: the trip is too short."
}
Put outdoor-heavy themes on dry days and museums/indoor themes on wet days.
${trip.lodging ? "" : "Also suggest the best area to stay, with an estimated nightly price range for the whole group in the trip currency."}
${request ? `\nThe traveller asked: "${request}"` : ""}

JSON shape:
{${trip.lodging ? "" : '"lodging": {"area": string, "description": string, "nightlyMin": number, "nightlyMax": number}, '}"days": [{"date": "YYYY-MM-DD", "theme": string, "dayTrip": string or null}]}`;
}

export function formatCandidates(places: FoundPlace[]): string {
  return places
    .map(
      (p) =>
        `- ${p.name} (${p.kind}${p.cuisine ? `, ${p.cuisine}` : ""}) lat ${p.lat} lon ${p.lon}`
    )
    .join("\n");
}

export function dayPrompt(input: {
  trip: Trip;
  day: Day;
  outline: DayOutline;
  candidates: FoundPlace[];
  alreadyPlanned: string[];
  request?: string;
}): string {
  const { trip, day, outline, candidates, alreadyPlanned, request } = input;
  const locked = day.items.filter((i) => i.locked);
  return `${tripBrief(trip)}

Plan ${day.date}. Theme: ${outline.theme}.${outline.dayTrip ? ` This is a day trip to ${outline.dayTrip}: include the transport there in the morning and back in the evening as "transit" items.` : ""}
Weather: ${weatherLine(day)}.
${
  locked.length
    ? `These items are fixed and must stay; plan around them without overlapping:\n${locked.map((i) => `- ${i.startTime ?? "untimed"}${i.endTime ? `-${i.endTime}` : ""} ${i.title}`).join("\n")}\n`
    : ""
}Include lunch and dinner as "meal" items at specific restaurants. Don't repeat places from other days: ${alreadyPlanned.length ? alreadyPlanned.join(", ") : "(none yet)"}.
${candidates.length ? `\nCandidate places (real, with coordinates):\n${formatCandidates(candidates)}\n` : ""}${request ? `\nThe traveller asked: "${request}"\n` : ""}
JSON shape:
{"items": [{"kind": "activity" | "meal" | "transit" | "free_time", "title": string, "startTime": "HH:MM", "endTime": "HH:MM", "placeName": string, "lat": number or null, "lon": number or null, "cost": number, "description": string}]}
Order items by time. Use lat/lon only when copying them from the candidates.`;
}

/** Interest keywords that suggest extra place categories to search. */
export function categoriesFor(interests: string[]) {
  const text = interests.join(" ").toLowerCase();
  const categories: (
    | "sights"
    | "museums"
    | "parks"
    | "viewpoints"
    | "food"
    | "markets"
  )[] = ["sights", "food"];
  if (/museum|art|history|histor|culture|science|gallery/.test(text) || !text) {
    categories.push("museums");
  }
  if (/nature|park|garden|outdoor|hik|walk/.test(text))
    categories.push("parks");
  if (/view|photo|sunset|panoram/.test(text)) categories.push("viewpoints");
  if (/market|shop/.test(text)) categories.push("markets");
  return categories;
}
