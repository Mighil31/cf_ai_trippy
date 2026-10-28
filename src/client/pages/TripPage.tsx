import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import { useState } from "react";
import type { TripAgent, TripAgentState } from "../../agents/trip-agent";
import { ChatPanel } from "../components/ChatPanel";
import { PlanPanel } from "../components/PlanPanel";
import { navigate } from "../lib/router";

export function TripPage({ tripId }: { tripId: string }) {
  const agent = useAgent<TripAgent, TripAgentState>({
    agent: "TripAgent",
    name: tripId
  });
  const chat = useAgentChat({ agent, experimental_throttle: 80 });
  const [undoError, setUndoError] = useState<string | null>(null);

  const state = agent.state;
  const trip = state?.trip;

  if (state && !trip) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16 text-center">
        <p className="mb-4">This trip doesn't exist.</p>
        <BackLink />
      </main>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="flex min-w-0 items-center gap-3">
          <BackLink />
          <h1 className="truncate font-semibold">
            {trip?.details.title ?? "Loading…"}
          </h1>
        </div>
        {state?.canUndo && (
          <button
            type="button"
            onClick={async () => {
              setUndoError(null);
              try {
                await agent.stub.undo();
              } catch (err) {
                setUndoError(err instanceof Error ? err.message : String(err));
              }
            }}
            title={state.lastChange?.summary}
            className="shrink-0 rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Undo
          </button>
        )}
      </header>
      {(state?.warnings ?? []).map((w) => (
        <p
          key={w}
          className="bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {w}
        </p>
      ))}
      {undoError && (
        <p role="alert" className="px-4 py-2 text-sm text-red-600">
          {undoError}
        </p>
      )}

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:grid-rows-1">
        <ChatPanel chat={chat} />
        <div className="overflow-y-auto border-t border-neutral-200 md:border-t-0 md:border-l dark:border-neutral-800">
          {trip ? (
            <PlanPanel trip={trip} lastChange={state?.lastChange ?? null} />
          ) : (
            <p className="p-4 text-sm text-neutral-500">Loading trip…</p>
          )}
        </div>
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <a
      href="/"
      onClick={(e) => {
        e.preventDefault();
        navigate("/");
      }}
      className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
    >
      ← Trips
    </a>
  );
}
