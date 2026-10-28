import { tool } from "ai";
import { z } from "zod";
import {
  ConstraintKind,
  IsoDate,
  ItemKind,
  Pace,
  TimeOfDay,
  type ItemInput,
  type ItemPatch,
  type TripDetailsPatch
} from "../shared/schema";
import { ServiceError } from "../services/http";
import { PlaceCategory, type FoundPlace } from "../services/places";
import * as ops from "../shared/trip-ops";
import type { OpContext, OpResult } from "../shared/trip-ops";
import type { Trip } from "../shared/schema";

/** The slice of TripAgent the tools need; keeps tools testable on their own. */
export type TripActions = {
  applyOp(
    actor: OpContext["actor"],
    op: (trip: Trip, ctx: OpContext) => OpResult
  ): Promise<{ summary: string; version: number }>;
  undo(): Promise<{ summary: string; version: number }>;
  findPlaces(
    category: PlaceCategory,
    area?: string,
    cuisine?: string
  ): Promise<{ near: string; places: FoundPlace[] }>;
};

export type ToolResult =
  | { ok: true; summary: string; [extra: string]: unknown }
  | { ok: false; error: string };

/** Run an AI edit and turn failures into a result the model can react to. */
async function run(
  actions: TripActions,
  op: (trip: Trip, ctx: OpContext) => OpResult,
  extra: () => Record<string, unknown> = () => ({})
): Promise<ToolResult> {
  try {
    const { summary } = await actions.applyOp("ai", op);
    return { ok: true, summary, ...extra() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Accept ids the way the model tends to quote them from the prompt:
 * "[a1b2c3]", "id: a1b2c3", "#a1b2c3".
 */
const Id = z
  .string()
  .transform((v) => v.replace(/^\s*\[?\s*(id\s*[:=]\s*)?#?|\s*\]?\s*$/gi, ""))
  .describe("6-character id, without brackets");

/** Records ids generated during an op so the model can refer to new items. */
function recordIds(ctx: OpContext, ids: string[]): OpContext {
  return {
    ...ctx,
    newId: () => {
      const id = ctx.newId();
      ids.push(id);
      return id;
    }
  };
}

// Flat, simple parameters: Llama follows these more reliably than nested ones.
// Numbers are coerced because Llama often sends them as strings ("50").
const ItemArgs = z.object({
  kind: ItemKind.describe(
    "activity, meal, transit, lodging (check-in etc.) or free_time"
  ),
  title: z.string().describe("Short name, e.g. 'Belém Tower'"),
  startTime: TimeOfDay.optional().describe("Local start time, HH:MM"),
  endTime: TimeOfDay.optional().describe("Local end time, HH:MM"),
  placeName: z.string().optional().describe("Venue or area name"),
  placeLat: z.coerce
    .number()
    .min(-90)
    .max(90)
    .optional()
    .describe("Latitude from search_places, if known"),
  placeLon: z.coerce
    .number()
    .min(-180)
    .max(180)
    .optional()
    .describe("Longitude from search_places, if known"),
  estimatedCost: z.coerce
    .number()
    .nonnegative()
    .optional()
    .describe("Estimated total for the whole group, in the trip currency"),
  description: z.string().optional().describe("One or two sentences")
});

function toItemFields(args: Partial<z.infer<typeof ItemArgs>>): ItemPatch {
  const fields: ItemPatch = {};
  if (args.kind !== undefined) fields.kind = args.kind;
  if (args.title !== undefined) fields.title = args.title;
  if (args.startTime !== undefined) fields.startTime = args.startTime;
  if (args.endTime !== undefined) fields.endTime = args.endTime;
  if (args.placeName !== undefined) {
    fields.place = { name: args.placeName };
    if (args.placeLat !== undefined && args.placeLon !== undefined) {
      fields.place.lat = args.placeLat;
      fields.place.lon = args.placeLon;
    }
  }
  if (args.estimatedCost !== undefined) {
    fields.cost = { amount: args.estimatedCost, estimated: true };
  }
  if (args.description !== undefined) fields.description = args.description;
  return fields;
}

export function createTripTools(actions: TripActions) {
  return {
    search_places: tool({
      description:
        "Find real places from OpenStreetMap near the destination (or near another area, e.g. a day-trip town). Use before suggesting specific places, and copy name, lat and lon into add_item.",
      inputSchema: z.object({
        category: z.enum(PlaceCategory),
        area: z
          .string()
          .optional()
          .describe(
            "Search near this town or district instead of the destination"
          ),
        cuisine: z
          .string()
          .optional()
          .describe("For food: e.g. 'portuguese', 'vegetarian', 'seafood'")
      }),
      execute: async ({ category, area, cuisine }) => {
        try {
          const { near, places } = await actions.findPlaces(
            category,
            area,
            cuisine
          );
          return {
            ok: true as const,
            summary: `Found ${places.length} ${category} near ${near}`,
            near,
            // Compact rows keep the model's context small
            places: places.map((p) => ({
              name: p.name,
              kind: p.kind,
              lat: p.lat,
              lon: p.lon,
              km: p.distanceKm,
              ...(p.notable && { notable: true }),
              ...(p.cuisine && { cuisine: p.cuisine })
            }))
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            ok: false as const,
            // Stop the model retrying a down service in a loop
            error:
              err instanceof ServiceError
                ? `${message}. Place search is unavailable right now: do not call search_places again this turn. Continue the plan with add_item anyway, using well-known places you are confident exist, and mention in your reply that they weren't checked against a map.`
                : message
          };
        }
      }
    }),

    update_trip_details: tool({
      description:
        "Change trip-level details: title, destination, dates, travellers, budget, pace, interests or notes. Only pass fields that change.",
      inputSchema: z.object({
        title: z.string().optional(),
        destinationName: z.string().optional(),
        startDate: IsoDate.optional().describe("YYYY-MM-DD"),
        endDate: IsoDate.optional().describe("YYYY-MM-DD"),
        travellers: z.coerce.number().int().min(1).optional(),
        budgetAmount: z.coerce.number().nonnegative().optional(),
        currency: z.string().optional().describe("3-letter code, e.g. EUR"),
        pace: Pace.optional(),
        interests: z.array(z.string()).optional(),
        notes: z.string().optional()
      }),
      execute: (args) =>
        run(actions, (trip) => {
          const patch: TripDetailsPatch = {};
          if (args.title !== undefined) patch.title = args.title;
          if (args.destinationName !== undefined) {
            // A new destination invalidates coordinates; geocoding refills them
            patch.destination = { name: args.destinationName };
          }
          if (args.startDate !== undefined) patch.startDate = args.startDate;
          if (args.endDate !== undefined) patch.endDate = args.endDate;
          if (args.travellers !== undefined) patch.travellers = args.travellers;
          if (args.budgetAmount !== undefined || args.currency !== undefined) {
            patch.budget = {
              amount: args.budgetAmount ?? trip.details.budget.amount,
              currency: (
                args.currency ?? trip.details.budget.currency
              ).toUpperCase()
            };
          }
          if (args.pace !== undefined) patch.pace = args.pace;
          if (args.interests !== undefined) patch.interests = args.interests;
          if (args.notes !== undefined) patch.notes = args.notes;
          return ops.updateDetails(trip, patch);
        })
    }),

    add_constraint: tool({
      description:
        "Save a lasting user rule or preference, e.g. 'avoid: early mornings', 'must: see Sintra', 'preference: vegetarian food'.",
      inputSchema: z.object({
        kind: ConstraintKind,
        text: z.string()
      }),
      execute: ({ kind, text }) => {
        const ids: string[] = [];
        return run(
          actions,
          (trip, ctx) =>
            ops.addConstraint(trip, { kind, text }, recordIds(ctx, ids)),
          () => ({ constraintId: ids[0] })
        );
      }
    }),

    remove_constraint: tool({
      description: "Remove a saved constraint by its id.",
      inputSchema: z.object({ constraintId: Id }),
      execute: ({ constraintId }) =>
        run(actions, (trip) => ops.removeConstraint(trip, constraintId))
    }),

    add_item: tool({
      description:
        "Add an activity, meal, transit leg or free time to a day. Items are kept in time order.",
      inputSchema: ItemArgs.extend({
        date: IsoDate.describe("Day to add to, YYYY-MM-DD")
      }),
      execute: ({ date, ...args }) => {
        const ids: string[] = [];
        return run(
          actions,
          (trip, ctx) =>
            ops.addItem(
              trip,
              { date, item: toItemFields(args) as ItemInput },
              recordIds(ctx, ids)
            ),
          () => ({ itemId: ids[0] })
        );
      }
    }),

    update_item: tool({
      description:
        "Change fields of an existing item. Only pass fields that change.",
      inputSchema: ItemArgs.partial().extend({ itemId: Id }),
      execute: ({ itemId, ...args }) =>
        run(actions, (trip, ctx) =>
          ops.updateItem(trip, { itemId, patch: toItemFields(args) }, ctx)
        )
    }),

    remove_item: tool({
      description: "Remove an item from the itinerary.",
      inputSchema: z.object({ itemId: Id }),
      execute: ({ itemId }) =>
        run(actions, (trip, ctx) => ops.removeItem(trip, { itemId }, ctx))
    }),

    move_item: tool({
      description:
        "Move an item to another day (placed by its start time), or to a position within a day.",
      inputSchema: z.object({
        itemId: Id,
        toDate: IsoDate.describe("Target day, YYYY-MM-DD"),
        position: z.coerce
          .number()
          .int()
          .min(0)
          .optional()
          .describe("0-based position in the day; omit to order by time")
      }),
      execute: ({ itemId, toDate, position }) =>
        run(actions, (trip, ctx) =>
          ops.moveItem(trip, { itemId, toDate, toIndex: position }, ctx)
        )
    }),

    set_day_info: tool({
      description:
        "Set a day's theme, or make it a day trip to a nearby destination (or cancel the day trip).",
      inputSchema: z.object({
        date: IsoDate.describe("YYYY-MM-DD"),
        theme: z.string().optional().describe("e.g. 'Old town & food'"),
        dayTripDestination: z.string().optional(),
        cancelDayTrip: z.boolean().optional()
      }),
      execute: ({ date, theme, dayTripDestination, cancelDayTrip }) =>
        run(actions, (trip) =>
          ops.setDayInfo(trip, {
            date,
            patch: {
              ...(theme !== undefined && { theme }),
              ...(dayTripDestination !== undefined && {
                dayTrip: { destination: dayTripDestination }
              }),
              ...(cancelDayTrip && { dayTrip: null })
            }
          })
        )
    }),

    set_lodging: tool({
      description:
        "Suggest the area to stay in, with an estimated nightly price range for the group.",
      inputSchema: z.object({
        area: z.string().describe("Neighbourhood or district"),
        description: z.string().optional().describe("Why this area"),
        nightlyMin: z.coerce.number().nonnegative().optional(),
        nightlyMax: z.coerce.number().nonnegative().optional()
      }),
      execute: ({ area, description, nightlyMin, nightlyMax }) =>
        run(actions, (trip) =>
          ops.setLodging(trip, {
            area,
            description,
            nightlyPrice:
              nightlyMin !== undefined && nightlyMax !== undefined
                ? { min: nightlyMin, max: nightlyMax }
                : undefined,
            estimated: true
          })
        )
    }),

    undo_last_change: tool({
      description:
        "Undo the most recent change to the trip (by anyone). Use only when the user asks to undo or revert.",
      inputSchema: z.object({}),
      execute: async (): Promise<ToolResult> => {
        try {
          const { summary } = await actions.undo();
          return { ok: true, summary };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          };
        }
      }
    })
  };
}
