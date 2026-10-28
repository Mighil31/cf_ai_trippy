import { Agent, callable, getAgentByName, type Connection } from "agents";
import type { Trip, TripSummary } from "../shared/schema";
import * as ops from "../shared/trip-ops";
import type { OpContext, OpResult } from "../shared/trip-ops";

export const MAX_SNAPSHOTS = 20;

export type TripAgentState = {
  trip: Trip | null;
  canUndo: boolean;
  lastChange: { summary: string; at: string } | null;
};

type Op = (trip: Trip, ctx: OpContext) => OpResult;

/**
 * One instance per trip. Holds the itinerary, preferences, budget and undo
 * snapshots. State is broadcast to connected clients; clients change it only
 * through the callable methods below. Becomes an AIChatAgent in Phase 2.
 */
export class TripAgent extends Agent<Env, TripAgentState> {
  initialState: TripAgentState = {
    trip: null,
    canUndo: false,
    lastChange: null
  };

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
      trip,
      canUndo: false,
      lastChange: { summary: "Created trip", at: trip.createdAt }
    });
    return trip;
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
    const ctx: OpContext = { actor, newId: () => crypto.randomUUID() };
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
      trip: after,
      canUndo: n > 0,
      lastChange: { summary, at }
    });
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
