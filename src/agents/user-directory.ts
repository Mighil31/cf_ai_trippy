import { Agent } from "agents";

export type UserDirectoryState = {
  tripIds: string[];
};

/** One instance per anonymous user; indexes that user's trips. */
export class UserDirectory extends Agent<Env, UserDirectoryState> {
  initialState: UserDirectoryState = { tripIds: [] };
}
