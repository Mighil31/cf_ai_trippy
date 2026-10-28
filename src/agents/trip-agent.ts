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
import { geocode, locatePlace } from "../services/geocode";
import {
  findPlaces,
  type FoundPlace,
  type PlaceCategory
} from "../services/places";
import {
  ItemInput,
  MAX_ITEMS_PER_DAY,
  type Issue,
  type Trip,
  type TripSummary
} from "../shared/schema";
import * as ops from "../shared/trip-ops";
import type { OpContext, OpResult } from "../shared/trip-ops";
import type {
  GeneratedPlan,
  JobProgress,
  PlanParams
} from "../workflows/plan-trip";
import { applyEnrichment, enrichTrip, needsEnrichment } from "./enrich";
import { PLANNER_MODEL } from "./llm";
import { systemPrompt } from "./prompt";
import { createTripTools } from "./tools";
import { runChecks } from "./validate";

export const MAX_SNAPSHOTS = 20;
/** Recent messages sent to the model; the trip itself is always in the prompt. */
const CONTEXT_MESSAGES = 20;
/** Max model steps (tool calls + final reply) per user message. */
const MAX_STEPS = 10;
/** Refresh weather on connect if older than this. */
const WEATHER_MAX_AGE_MS = 6 * 3600_000;
/** A job with no callback for this long is assumed lost. */
const JOB_STALE_MS = 10 * 60_000;
/** Max place lookups per deep check, to stay polite to Wikipedia. */
const MAX_LOCATE = 25;

/** A background Workflow run, shown as progress in the UI. */
export type Job = {
  workflowId: string;
  kind: "plan" | "check";
  status: "running" | "done" | "error";
  message: string;
  percent: number;
  updatedAt: string;
};

export type TripAgentState = {
  trip: Trip | null;
  canUndo: boolean;
  lastChange: { summary: string; at: string } | null;
  /** When coordinates/weather were last refreshed from outside services. */
  enrichedAt: string | null;
  /** Problems from the last refresh, shown to the user. */
  warnings: string[];
  /** The latest background Workflow run. */
  job: Job | null;
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
    warnings: [],
    job: null
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
        if (!this.state.trip) return;
        this.systemUpdate((latest) => applyEnrichment(latest, result), {
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

  /**
   * Like findPlaces, for PlanTripWorkflow: failures return no places instead
   * of throwing, since the planner can work without candidates.
   */
  async candidatePlaces(
    category: PlaceCategory,
    area?: string
  ): Promise<FoundPlace[]> {
    try {
      return (await this.findPlaces(category, area)).places;
    } catch (err) {
      console.warn(`candidate search failed (${category})`, String(err));
      return [];
    }
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

  // ── Background jobs (Workflows) ─────────────────────────────────────

  /** Generate the whole itinerary, or re-plan the given dates. */
  @callable()
  async startPlanning(dates?: string[], request?: string) {
    const trip = this.requireTrip();
    this.assertNoRunningJob();
    const all = trip.days.map((d) => d.date);
    const target = dates?.length ? dates.filter((d) => all.includes(d)) : all;
    if (target.length === 0)
      throw new Error("None of those dates are in the trip");

    const params: PlanParams = { dates: target, ...(request && { request }) };
    const workflowId = await this.runWorkflow("PLAN_TRIP", params);
    this.setJob({
      workflowId,
      kind: "plan",
      status: "running",
      message: "Starting…",
      percent: 0
    });
    return { workflowId, dates: target };
  }

  /** Locate places and review the plan against the traveller's rules. */
  @callable()
  async startCheck() {
    this.requireTrip();
    this.assertNoRunningJob();
    const workflowId = await this.runWorkflow("VALIDATE_TRIP", {});
    this.setJob({
      workflowId,
      kind: "check",
      status: "running",
      message: "Starting…",
      percent: 0
    });
    return { workflowId };
  }

  async onWorkflowProgress(
    _name: string,
    workflowId: string,
    progress: unknown
  ) {
    const job = this.state.job;
    if (job?.workflowId !== workflowId) return;
    const p = progress as JobProgress;
    this.setJob({ ...job, message: p.message, percent: p.percent });
  }

  async onWorkflowComplete(
    _name: string,
    workflowId: string,
    result?: unknown
  ) {
    const job = this.state.job;
    if (job?.workflowId !== workflowId) return;
    const summary =
      (result as { summary?: string } | undefined)?.summary ??
      (job.kind === "check" ? "Check finished" : "Plan ready");
    this.setJob({ ...job, status: "done", message: summary, percent: 1 });
    // A fresh plan is worth checking against the traveller's rules
    if (job.kind === "plan" && this.state.trip?.constraints.length) {
      await this.startCheck().catch((err) =>
        console.error("couldn't start check", err)
      );
    }
  }

  async onWorkflowError(_name: string, workflowId: string, error: string) {
    const job = this.state.job;
    if (job?.workflowId !== workflowId) return;
    console.error(`${job.kind} workflow failed`, error);
    this.setJob({
      ...job,
      status: "error",
      message:
        job.kind === "plan"
          ? "Trippy couldn't finish the plan. Please try again."
          : "The check didn't finish. Please try again."
    });
  }

  /** Called by PlanTripWorkflow: apply all generated days as one change. */
  async applyGeneratedPlan(plan: GeneratedPlan) {
    const dates = plan.days.map((d) => d.date);
    const summary =
      dates.length === 1
        ? `Re-planned ${dates[0]}`
        : `Planned ${dates.length} days`;
    let itemCount = 0;
    await this.applyOp("ai", (trip, ctx) => {
      let next = trip;
      if (plan.lodging && !trip.lodging) {
        const { area, description, nightlyMin, nightlyMax } = plan.lodging;
        next = ops.setLodging(next, {
          area,
          ...(description && { description }),
          ...(nightlyMin !== undefined &&
            nightlyMax !== undefined &&
            nightlyMax >= nightlyMin && {
              nightlyPrice: { min: nightlyMin, max: nightlyMax }
            }),
          estimated: true
        }).trip;
      }
      for (const day of plan.days) {
        if (!next.days.some((d) => d.date === day.date)) continue;
        next = ops.setDayInfo(next, {
          date: day.date,
          patch: {
            theme: day.theme.slice(0, 120),
            dayTrip: day.dayTrip
              ? { destination: day.dayTrip.slice(0, 120) }
              : null
          }
        }).trip;
        // Drop anything that still fails validation rather than the whole day
        const locked = next.days
          .find((d) => d.date === day.date)!
          .items.filter((i) => i.locked).length;
        const items = day.items
          .filter((i) => ItemInput.safeParse(i).success)
          .slice(0, MAX_ITEMS_PER_DAY - locked);
        itemCount += items.length;
        next = ops.replaceDayItems(next, { date: day.date, items }, ctx).trip;
      }
      return { trip: next, summary };
    });
    return { summary: `${summary} (${itemCount} items)` };
  }

  /** Called by ValidateTripWorkflow: find coordinates for unlocated places. */
  async locateMissingPlaces(): Promise<number> {
    const trip = this.requireTrip();
    const { lat, lon, name } = trip.details.destination;
    if (lat === undefined || lon === undefined) return 0;
    const near = { lat, lon, name };

    const missing = trip.days
      .flatMap((d) => d.items.map((item) => ({ item, dayTrip: !!d.dayTrip })))
      .filter(
        ({ item }) =>
          item.kind !== "transit" &&
          item.kind !== "free_time" &&
          item.place?.name &&
          item.place.lat === undefined
      )
      .slice(0, MAX_LOCATE);

    const found = new Map<string, { lat: number; lon: number }>();
    for (const { item, dayTrip } of missing) {
      const pos = await locatePlace(
        this.env.CACHE,
        item.place!.name,
        near,
        dayTrip ? 150 : 60
      ).catch(() => null);
      if (pos) found.set(item.id, pos);
    }
    if (found.size > 0) {
      this.systemUpdate((t) => {
        const next = structuredClone(t);
        for (const day of next.days) {
          for (const item of day.items) {
            const pos = found.get(item.id);
            if (pos && item.place) Object.assign(item.place, pos);
          }
        }
        return next;
      });
    }
    return found.size;
  }

  /** Called by ValidateTripWorkflow with the LLM's rule review. */
  async setReviewIssues(issues: Issue[]) {
    const next = this.systemUpdate((t) => ({
      ...t,
      issues: issues.filter((i) => i.code.startsWith("review."))
    }));
    return { issues: next.issues.length };
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
    after.issues = runChecks(after);
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

  /**
   * Change the trip without an undo snapshot: outside data and check results,
   * not edits. Re-runs the checks and bumps the version.
   */
  private systemUpdate(
    mutate: (trip: Trip) => Trip,
    extra: Partial<TripAgentState> = {}
  ): Trip {
    const latest = this.requireTrip();
    const next = mutate(latest);
    next.version = latest.version + 1;
    next.issues = runChecks(next);
    this.setState({ ...this.state, ...extra, trip: next });
    return next;
  }

  private setJob(job: Omit<Job, "updatedAt">) {
    this.setState({
      ...this.state,
      job: { ...job, updatedAt: new Date().toISOString() }
    });
  }

  private assertNoRunningJob() {
    const job = this.state.job;
    if (
      job?.status === "running" &&
      Date.now() - Date.parse(job.updatedAt) < JOB_STALE_MS
    ) {
      throw new Error(
        job.kind === "plan"
          ? "Trippy is already working on the plan"
          : "Trippy is already checking the plan"
      );
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
