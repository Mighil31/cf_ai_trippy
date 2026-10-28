import { Agent } from "agents";

export type TripAgentState = {
  createdAt: string | null;
};

/**
 * One instance per trip. Holds the itinerary, preferences, budget, chat
 * history and undo snapshots. Becomes an AIChatAgent in Phase 2.
 */
export class TripAgent extends Agent<Env, TripAgentState> {
  initialState: TripAgentState = { createdAt: null };
}
