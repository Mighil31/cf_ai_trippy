import { z } from "zod";
import {
  ConstraintKind,
  DayInfoPatch,
  Item,
  ItemInput,
  ItemPatch,
  Lodging,
  MAX_ITEMS_PER_DAY,
  TripDetails,
  TripDetailsPatch,
  datesBetween,
  type Day,
  type Source,
  type Trip
} from "./schema";

/**
 * Pure itinerary operations. Each takes a trip and returns a new trip plus a
 * one-line summary of what changed (used for undo labels and tool results).
 * Inputs are validated here because callers include the LLM.
 */

export type OpContext = {
  actor: Source;
  newId: () => string;
};

export type OpResult = {
  trip: Trip;
  summary: string;
};

export type TripOpErrorCode =
  | "INVALID"
  | "NOT_FOUND"
  | "LOCKED"
  | "LIMIT"
  | "FORBIDDEN";

export class TripOpError extends Error {
  constructor(
    readonly code: TripOpErrorCode,
    message: string
  ) {
    super(message);
    this.name = "TripOpError";
  }
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new TripOpError("INVALID", z.prettifyError(result.error));
  }
  return result.data;
}

function emptyDay(date: string): Day {
  return { date, items: [] };
}

function getDay(trip: Trip, date: string): Day {
  const day = trip.days.find((d) => d.date === date);
  if (!day) throw new TripOpError("NOT_FOUND", `No day ${date} in this trip`);
  return day;
}

function findItem(trip: Trip, itemId: string) {
  for (const day of trip.days) {
    const index = day.items.findIndex((i) => i.id === itemId);
    if (index !== -1) return { day, index, item: day.items[index] };
  }
  throw new TripOpError("NOT_FOUND", `No item ${itemId} in this trip`);
}

function assertEditable(item: Item, ctx: OpContext) {
  if (item.locked && ctx.actor === "ai") {
    throw new TripOpError(
      "LOCKED",
      `"${item.title}" is locked by the user and cannot be changed`
    );
  }
}

function assertRoom(day: Day, adding = 1) {
  if (day.items.length + adding > MAX_ITEMS_PER_DAY) {
    throw new TripOpError(
      "LIMIT",
      `${day.date} already has the maximum of ${MAX_ITEMS_PER_DAY} items`
    );
  }
}

/** Index to insert an item so timed items stay in start-time order. */
function chronologicalIndex(items: Item[], startTime?: string): number {
  if (!startTime) return items.length;
  const next = items.findIndex((i) => i.startTime && i.startTime > startTime);
  return next === -1 ? items.length : next;
}

function sortChronologically(items: Item[]): Item[] {
  // Stable sort; untimed items keep their relative order at the end.
  return [...items].sort((a, b) => {
    if (!a.startTime) return b.startTime ? 1 : 0;
    if (!b.startTime) return -1;
    return a.startTime.localeCompare(b.startTime);
  });
}

export function createTrip(
  input: { id: string; ownerId: string; details: unknown },
  now: string
): Trip {
  const details = parse(TripDetails, input.details);
  return {
    id: input.id,
    ownerId: input.ownerId,
    details,
    constraints: [],
    days: datesBetween(details.startDate, details.endDate).map(emptyDay),
    lodging: null,
    issues: [],
    version: 0,
    createdAt: now,
    updatedAt: now
  };
}

export function updateDetails(trip: Trip, patch: unknown): OpResult {
  const changes = parse(TripDetailsPatch, patch);
  const details = parse(TripDetails, { ...trip.details, ...changes });
  const next = structuredClone(trip);
  next.details = details;

  let removedItems = 0;
  const datesChanged =
    details.startDate !== trip.details.startDate ||
    details.endDate !== trip.details.endDate;
  if (datesChanged) {
    const existing = new Map(next.days.map((d) => [d.date, d]));
    const dates = datesBetween(details.startDate, details.endDate);
    const kept = new Set(dates);
    for (const day of next.days) {
      if (!kept.has(day.date)) removedItems += day.items.length;
    }
    next.days = dates.map((date) => existing.get(date) ?? emptyDay(date));
  }

  const fields = Object.keys(changes).join(", ") || "nothing";
  const dropped =
    removedItems > 0
      ? `; removed ${removedItems} item(s) on dates no longer in the trip`
      : "";
  return { trip: next, summary: `Updated trip details (${fields})${dropped}` };
}

export function addConstraint(
  trip: Trip,
  input: { kind: unknown; text: unknown },
  ctx: OpContext
): OpResult {
  const kind = parse(ConstraintKind, input.kind);
  const text = parse(z.string().trim().min(1).max(300), input.text);
  if (trip.constraints.length >= 50) {
    throw new TripOpError("LIMIT", "A trip can have at most 50 constraints");
  }
  const next = structuredClone(trip);
  next.constraints.push({ id: ctx.newId(), kind, text });
  return { trip: next, summary: `Added constraint (${kind}): ${text}` };
}

export function removeConstraint(trip: Trip, constraintId: string): OpResult {
  const index = trip.constraints.findIndex((c) => c.id === constraintId);
  if (index === -1) {
    throw new TripOpError("NOT_FOUND", `No constraint ${constraintId}`);
  }
  const next = structuredClone(trip);
  const [removed] = next.constraints.splice(index, 1);
  return { trip: next, summary: `Removed constraint: ${removed.text}` };
}

export function addItem(
  trip: Trip,
  input: { date: string; item: unknown; index?: number | null },
  ctx: OpContext
): OpResult {
  const fields = parse(ItemInput, input.item);
  const next = structuredClone(trip);
  const day = getDay(next, input.date);
  assertRoom(day);

  const item: Item = {
    ...fields,
    id: ctx.newId(),
    locked: false,
    source: ctx.actor
  };
  const index =
    input.index == null
      ? chronologicalIndex(day.items, item.startTime)
      : Math.max(0, Math.min(input.index, day.items.length));
  day.items.splice(index, 0, item);
  return { trip: next, summary: `Added "${item.title}" on ${day.date}` };
}

const CLEARABLE_ITEM_FIELDS = [
  "description",
  "place",
  "startTime",
  "endTime",
  "cost",
  "notes"
] as const;

export function updateItem(
  trip: Trip,
  input: { itemId: string; patch: unknown },
  ctx: OpContext
): OpResult {
  // null clears an optional field (undefined doesn't survive JSON transport)
  const raw = (input.patch ?? {}) as Record<string, unknown>;
  const cleared = CLEARABLE_ITEM_FIELDS.filter((k) => raw[k] === null);
  const patch = parse(
    ItemPatch,
    Object.fromEntries(
      Object.entries(raw).filter(
        ([k]) => !(cleared as readonly string[]).includes(k)
      )
    )
  );
  const next = structuredClone(trip);
  const { day, index, item } = findItem(next, input.itemId);
  assertEditable(item, ctx);

  const merged: Record<string, unknown> = { ...item, ...patch };
  for (const key of cleared) delete merged[key];
  day.items[index] = parse(Item, merged);
  return { trip: next, summary: `Updated "${day.items[index].title}"` };
}

export function removeItem(
  trip: Trip,
  input: { itemId: string },
  ctx: OpContext
): OpResult {
  const next = structuredClone(trip);
  const { day, index, item } = findItem(next, input.itemId);
  assertEditable(item, ctx);

  day.items.splice(index, 1);
  return { trip: next, summary: `Removed "${item.title}" from ${day.date}` };
}

export function moveItem(
  trip: Trip,
  input: { itemId: string; toDate: string; toIndex?: number | null },
  ctx: OpContext
): OpResult {
  const next = structuredClone(trip);
  const from = findItem(next, input.itemId);
  assertEditable(from.item, ctx);
  const target = getDay(next, input.toDate);
  if (target !== from.day) assertRoom(target);

  from.day.items.splice(from.index, 1);
  const index =
    input.toIndex == null
      ? chronologicalIndex(target.items, from.item.startTime)
      : Math.max(0, Math.min(input.toIndex, target.items.length));
  target.items.splice(index, 0, from.item);

  const where =
    target === from.day ? `within ${target.date}` : `to ${target.date}`;
  return { trip: next, summary: `Moved "${from.item.title}" ${where}` };
}

export function setItemLocked(
  trip: Trip,
  input: { itemId: string; locked: boolean },
  ctx: OpContext
): OpResult {
  if (!input.locked && ctx.actor === "ai") {
    throw new TripOpError("FORBIDDEN", "Only the user can unlock items");
  }
  const next = structuredClone(trip);
  const { item } = findItem(next, input.itemId);
  item.locked = input.locked;
  return {
    trip: next,
    summary: `${input.locked ? "Locked" : "Unlocked"} "${item.title}"`
  };
}

export function setDayInfo(
  trip: Trip,
  input: { date: string; patch: unknown }
): OpResult {
  const patch = parse(DayInfoPatch, input.patch);
  const next = structuredClone(trip);
  const day = getDay(next, input.date);

  if (patch.theme !== undefined) {
    if (patch.theme === null) delete day.theme;
    else day.theme = patch.theme;
  }
  if (patch.dayTrip !== undefined) {
    if (patch.dayTrip === null) delete day.dayTrip;
    else day.dayTrip = patch.dayTrip;
  }
  return { trip: next, summary: `Updated day info for ${day.date}` };
}

/**
 * Replace a day's items, keeping any locked ones. Used when (re)generating a
 * day. Result is sorted by start time.
 */
export function replaceDayItems(
  trip: Trip,
  input: { date: string; items: unknown },
  ctx: OpContext
): OpResult {
  const fresh = parse(z.array(ItemInput), input.items);
  const next = structuredClone(trip);
  const day = getDay(next, input.date);

  const locked = day.items.filter((i) => i.locked);
  if (locked.length + fresh.length > MAX_ITEMS_PER_DAY) {
    throw new TripOpError(
      "LIMIT",
      `A day can have at most ${MAX_ITEMS_PER_DAY} items`
    );
  }
  const created: Item[] = fresh.map((fields) => ({
    ...fields,
    id: ctx.newId(),
    locked: false,
    source: ctx.actor
  }));
  day.items = sortChronologically([...locked, ...created]);

  const kept = locked.length ? ` (kept ${locked.length} locked)` : "";
  return {
    trip: next,
    summary: `Replaced plan for ${day.date} with ${created.length} item(s)${kept}`
  };
}

export function setLodging(trip: Trip, lodging: unknown): OpResult {
  const next = structuredClone(trip);
  if (lodging === null) {
    next.lodging = null;
    return { trip: next, summary: "Cleared lodging suggestion" };
  }
  next.lodging = parse(Lodging, lodging);
  return { trip: next, summary: `Set lodging area to ${next.lodging.area}` };
}
