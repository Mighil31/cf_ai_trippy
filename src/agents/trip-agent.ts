import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  callable,
  getAgentByName,
  type Connection,
  type ConnectionContext
} from "agents";
import {
  convertToModelMessages,
  pruneMessages,
  simulateStreamingMiddleware,
  stepCountIs,
  streamText,
  wrapLanguageModel
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { geocode } from "../services/geocode";
import { findPlaces, type PlaceCategory } from "../services/places";
import type { Trip, TripSummary } from "../shared/schema";
import * as ops from "../shared/trip-ops";
import type { OpContext, OpResult } from "../shared/trip-ops";
import { applyEnrichment, enrichTrip, needsEnrichment } from "./enrich";
import { systemPrompt } from "./prompt";
import { createTripTools } from "./tools";

export const MAX_SNAPSHOTS = 20;
export const PLANNER_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/** Recent messages sent to the model; the trip itself is always in the prompt. */
const CONTEXT_MESSAGES = 20;
/** Max model steps (tool calls + final reply) per user message. */
const MAX_STEPS = 10;
/** Refresh weather on connect if older than this. */
const WEATHER_MAX_AGE_MS = 6 * 3600_000;

export type TripAgentState = {
  trip: Trip | null;
  canUndo: boolean;
  lastChange: { summary: string; at: string } | null;
  /** When coordinates/weather were last refreshed from outside services. */
  enrichedAt: string | null;
  /** Problems from the last refresh, shown to the user. */
  warnings: string[];
};

type Op = (trip: Trip, ctx: OpContext) => OpResult;

/**
 * One instance per trip. Holds the itinerary, preferences, budget, chat
 * history and undo snapshots. State is broadcast to connected clients; clients
 * change it only through the callable methods below or by chatting.
 */
export class TripAgent extends AIChatAgent<Env, TripAgentState> {
  maxPersistedMessages = 200;

  initialState: TripAgentState = {
    trip: null,
    canUndo: false,
    lastChange: null,
    enrichedAt: null,
    warnings: []
  };

  private enrichment: Promise<void> | null = null;

  onStart() {
    this.sql`
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        summary TEXT NOT NULL,
        trip TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `;
  }

  validateStateChange(_next: TripAgentState, source: Connection | "server") {
    if (source !== "server") {
      throw new Error("Trip state can only be changed through trip actions");
    }
  }

  /** Called once by UserDirectory when the trip is created. Not client-callable. */
  async initialize(input: { ownerId: string; details: unknown }) {
    if (this.state.trip) throw new Error("Trip already initialized");
    const trip = ops.createTrip(
      { id: this.name, ownerId: input.ownerId, details: input.details },
      new Date().toISOString()
    );
    this.setState({
      ...this.state,
      trip,
      canUndo: false,
      lastChange: { summary: "Created trip", at: trip.createdAt }
    });
    // Geocoding and weather fill in shortly after; creation doesn't wait
    void this.refreshExternalData();
    return trip;
  }

  onConnect(_connection: Connection, _ctx: ConnectionContext) {
    const { trip, enrichedAt } = this.state;
    if (!trip) return;
    const stale =
      !enrichedAt || Date.now() - Date.parse(enrichedAt) > WEATHER_MAX_AGE_MS;
    if (stale) void this.refreshExternalData();
  }

  /**
   * Geocode the destination if needed and refresh weather. Not an undoable
   * edit: it only adds outside data. Concurrent calls share one run.
   */
  @callable()
  refreshExternalData(): Promise<void> {
    this.enrichment ??= (async () => {
      try {
        const trip = this.state.trip;
        if (!trip) return;
        const today = new Date().toISOString().slice(0, 10);
        const result = await enrichTrip(trip, this.env.CACHE, today);
        const latest = this.state.trip;
        if (!latest) return;
        this.setState({
          ...this.state,
          trip: {
            ...applyEnrichment(latest, result),
            version: latest.version + 1
          },
          enrichedAt: new Date().toISOString(),
          warnings: result.warnings
        });
      } catch (err) {
        console.error("refreshing external data failed", err);
      } finally {
        this.enrichment = null;
      }
    })();
    return this.enrichment;
  }

  /** Place search for the search_places tool. */
  async findPlaces(category: PlaceCategory, area?: string, cuisine?: string) {
    const trip = this.requireTrip();
    let center: { lat: number; lon: number; name: string } | null = null;
    if (area) {
      const place = await geocode(
        this.env.CACHE,
        trip.details.destination.country
          ? `${area}, ${trip.details.destination.country}`
          : area
      );
      if (place) center = { lat: place.lat, lon: place.lon, name: place.name };
    } else {
      const { lat, lon, name } = trip.details.destination;
      if (lat !== undefined && lon !== undefined) center = { lat, lon, name };
    }
    if (!center) {
      throw new Error(
        `Couldn't locate ${area ?? trip.details.destination.name} on the map`
      );
    }
    const places = await findPlaces(
      this.env.CACHE,
      category,
      center.lat,
      center.lon,
      cuisine
    );
    return { near: center.name, places };
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const trip = this.requireTrip();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      // workers-ai-provider 4.0.1 duplicates every streamed tool-call delta for
      // Llama 3.3 (it reads both `tool_calls` and `choices[0].delta.tool_calls`
      // from each chunk), corrupting the arguments. Generate each step whole
      // and replay it as a stream instead.
      model: wrapLanguageModel({
        model: workersai(PLANNER_MODEL),
        middleware: simulateStreamingMiddleware()
      }),
      system: systemPrompt(trip, new Date().toISOString().slice(0, 10)),
      messages: pruneMessages({
        messages: await convertToModelMessages(
          this.messages.slice(-CONTEXT_MESSAGES)
        ),
        toolCalls: "before-last-2-messages"
      }),
      tools: createTripTools(this),
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse({ onError: chatErrorMessage });
  }

  @callable()
  getTrip(): Trip | null {
    return this.state.trip;
  }

  // ── User actions (client-callable) ──────────────────────────────────

  @callable()
  updateDetails(patch: unknown) {
    return this.applyOp("user", (t) => ops.updateDetails(t, patch));
  }

  @callable()
  addConstraint(kind: unknown, text: unknown) {
    return this.applyOp("user", (t, ctx) =>
      ops.addConstraint(t, { kind, text }, ctx)
    );
  }

  @callable()
  removeConstraint(constraintId: string) {
    return this.applyOp("user", (t) => ops.removeConstraint(t, constraintId));
  }

  @callable()
  addItem(date: string, item: unknown, index?: number) {
    return this.applyOp("user", (t, ctx) =>
      ops.addItem(t, { date, item, index }, ctx)
    );
  }

  @callable()
  updateItem(itemId: string, patch: unknown) {
    return this.applyOp("user", (t, ctx) =>
      ops.updateItem(t, { itemId, patch }, ctx)
    );
  }

  @callable()
  removeItem(itemId: string) {
    return this.applyOp("user", (t, ctx) => ops.removeItem(t, { itemId }, ctx));
  }

  @callable()
  moveItem(itemId: string, toDate: string, toIndex?: number) {
    return this.applyOp("user", (t, ctx) =>
      ops.moveItem(t, { itemId, toDate, toIndex }, ctx)
    );
  }

  @callable()
  setItemLocked(itemId: string, locked: boolean) {
    return this.applyOp("user", (t, ctx) =>
      ops.setItemLocked(t, { itemId, locked }, ctx)
    );
  }

  @callable()
  setDayInfo(date: string, patch: unknown) {
    return this.applyOp("user", (t) => ops.setDayInfo(t, { date, patch }));
  }

  @callable()
  setLodging(lodging: unknown) {
    return this.applyOp("user", (t) => ops.setLodging(t, lodging));
  }

  @callable()
  async undo() {
    const trip = this.requireTrip();
    const [snapshot] = this.sql<{ id: number; summary: string; trip: string }>`
      SELECT id, summary, trip FROM snapshots ORDER BY id DESC LIMIT 1
    `;
    if (!snapshot) throw new Error("Nothing to undo");
    this.sql`DELETE FROM snapshots WHERE id = ${snapshot.id}`;

    const now = new Date().toISOString();
    const restored: Trip = {
      ...(JSON.parse(snapshot.trip) as Trip),
      // Versions only ever increase so clients can detect any change
      version: trip.version + 1,
      updatedAt: now
    };
    const summary = `Undid: ${snapshot.summary}`;
    await this.commit(trip, restored, summary, now);
    return { summary, version: restored.version };
  }

  // ── Internals ───────────────────────────────────────────────────────

  /**
   * Run an operation as `actor`, snapshot the previous trip for undo, and
   * broadcast the result. AI tools (Phase 2) call this with actor "ai".
   */
  async applyOp(actor: OpContext["actor"], op: Op) {
    const before = this.requireTrip();
    const ctx: OpContext = { actor, newId: shortIdGenerator(before) };
    const { trip, summary } = op(before, ctx);

    const now = new Date().toISOString();
    trip.version = before.version + 1;
    trip.updatedAt = now;

    this.sql`
      INSERT INTO snapshots (summary, trip, created_at)
      VALUES (${summary}, ${JSON.stringify(before)}, ${now})
    `;
    this.sql`
      DELETE FROM snapshots WHERE id NOT IN (
        SELECT id FROM snapshots ORDER BY id DESC LIMIT ${MAX_SNAPSHOTS}
      )
    `;
    await this.commit(before, trip, summary, now);
    return { summary, version: trip.version };
  }

  private async commit(before: Trip, after: Trip, summary: string, at: string) {
    const [{ n }] = this.sql<{
      n: number;
    }>`SELECT COUNT(*) AS n FROM snapshots`;
    this.setState({
      ...this.state,
      trip: after,
      canUndo: n > 0,
      lastChange: { summary, at }
    });
    if (needsEnrichment(before, after)) void this.refreshExternalData();
    if (summaryChanged(before, after)) {
      // Keep the owner's trip list in sync; a failure here shouldn't fail the edit
      await this.syncDirectory(after).catch(console.error);
    }
  }

  private async syncDirectory(trip: Trip) {
    const directory = await getAgentByName(
      this.env.UserDirectory,
      trip.ownerId
    );
    await directory.updateSummary(toSummary(trip));
  }

  private requireTrip(): Trip {
    if (!this.state.trip) throw new Error("Trip not found");
    return this.state.trip;
  }
}

/**
 * Short ids (6 hex chars) unique within the trip. The model reads and
 * repeats ids, and short ones cost fewer tokens and get mistyped less.
 */
function shortIdGenerator(trip: Trip): () => string {
  const taken = new Set<string>(trip.constraints.map((c) => c.id));
  for (const day of trip.days) for (const item of day.items) taken.add(item.id);
  return () => {
    let id: string;
    do {
      id = crypto.randomUUID().replace(/-/g, "").slice(0, 6);
    } while (taken.has(id));
    taken.add(id);
    return id;
  };
}

function chatErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  console.error("chat error", message);
  if (/InvalidToolInput|Invalid input for tool/i.test(message)) {
    // The model sees the full error and usually corrects itself
    return "Trippy tried an invalid change and is retrying.";
  }
  if (/4006|daily free allocation|neurons/i.test(message)) {
    return "Trippy has used up today's free AI allowance. Direct edits still work; chat will be back after the daily reset (00:00 UTC).";
  }
  return "Something went wrong while Trippy was thinking. Please try again.";
}

export function toSummary(trip: Trip): TripSummary {
  return {
    id: trip.id,
    title: trip.details.title,
    destination: trip.details.destination.name,
    startDate: trip.details.startDate,
    endDate: trip.details.endDate,
    updatedAt: trip.updatedAt
  };
}

function summaryChanged(a: Trip, b: Trip) {
  const x = toSummary(a);
  const y = toSummary(b);
  return (
    x.title !== y.title ||
    x.destination !== y.destination ||
    x.startDate !== y.startDate ||
    x.endDate !== y.endDate
  );
}
