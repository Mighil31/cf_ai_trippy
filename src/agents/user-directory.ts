import { Agent, callable, getAgentByName, type Connection } from "agents";
import { TripDetails, type TripSummary } from "../shared/schema";
import { TripOpError } from "../shared/trip-ops";
import { z } from "zod";
import { toSummary } from "./trip-agent";

export const MAX_TRIPS_PER_USER = 50;

export type UserDirectoryState = {
  trips: TripSummary[];
};

/**
 * One instance per anonymous user (named by the ID kept in the browser).
 * Creates trips and keeps the user's trip list, most recently updated first.
 */
export class UserDirectory extends Agent<Env, UserDirectoryState> {
  initialState: UserDirectoryState = { trips: [] };

  validateStateChange(
    _next: UserDirectoryState,
    source: Connection | "server"
  ) {
    if (source !== "server") {
      throw new Error("Trip list can only be changed through trip actions");
    }
  }

  @callable()
  async createTrip(details: unknown): Promise<TripSummary> {
    if (this.state.trips.length >= MAX_TRIPS_PER_USER) {
      throw new Error(`You can have at most ${MAX_TRIPS_PER_USER} trips`);
    }
    // Validate here so a bad request never touches a new TripAgent
    const parsed = TripDetails.safeParse(details);
    if (!parsed.success) {
      throw new TripOpError("INVALID", z.prettifyError(parsed.error));
    }
    const id = crypto.randomUUID();
    const tripAgent = await getAgentByName(this.env.TripAgent, id);
    const trip = await tripAgent.initialize({
      ownerId: this.name,
      details: parsed.data
    });
    const summary = toSummary(trip);
    this.setTrips([summary, ...this.state.trips]);
    return summary;
  }

  @callable()
  listTrips(): TripSummary[] {
    return this.state.trips;
  }

  @callable()
  async deleteTrip(tripId: string) {
    if (!this.state.trips.some((t) => t.id === tripId)) {
      throw new Error("Trip not found");
    }
    this.setState({ trips: this.state.trips.filter((t) => t.id !== tripId) });
    const tripAgent = await getAgentByName(this.env.TripAgent, tripId);
    // destroy() may abort the trip's isolate before replying
    await tripAgent.destroy().catch(() => {});
  }

  /**
   * Called by TripAgent when a trip's title, destination or dates change.
   * Ignores trips not in the list, so a late sync can't revive a deleted trip.
   */
  updateSummary(summary: TripSummary) {
    if (!this.state.trips.some((t) => t.id === summary.id)) return;
    this.setTrips(
      this.state.trips.map((t) => (t.id === summary.id ? summary : t))
    );
  }

  private setTrips(trips: TripSummary[]) {
    this.setState({
      trips: trips.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    });
  }
}
