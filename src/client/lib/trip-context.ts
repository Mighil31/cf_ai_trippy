import { createContext, useContext } from "react";
import type { Job } from "../../agents/trip-agent";
import type { Trip } from "../../shared/schema";

/** Every action resolves to true on success; errors are shown by the page. */
export type TripActions = {
  updateDetails(patch: unknown): Promise<boolean>;
  addConstraint(kind: string, text: string): Promise<boolean>;
  removeConstraint(id: string): Promise<boolean>;
  addItem(date: string, item: unknown): Promise<boolean>;
  updateItem(itemId: string, patch: unknown): Promise<boolean>;
  removeItem(itemId: string): Promise<boolean>;
  moveItem(itemId: string, toDate: string, toIndex?: number): Promise<boolean>;
  setItemLocked(itemId: string, locked: boolean): Promise<boolean>;
  setLodging(lodging: unknown): Promise<boolean>;
  redoDay(date: string): Promise<boolean>;
  buildItinerary(): Promise<boolean>;
};

export type TripContextValue = {
  trip: Trip;
  job: Job | null;
  jobRunning: boolean;
  actions: TripActions;
  /** Put text in the chat box (switching to chat on small screens). */
  askTrippy(text: string): void;
  /** Switch to the Days tab and scroll to a day. */
  showDay(date: string): void;
};

export const TripContext = createContext<TripContextValue | null>(null);

export function useTrip(): TripContextValue {
  const value = useContext(TripContext);
  if (!value) throw new Error("useTrip must be used inside a TripPage");
  return value;
}
