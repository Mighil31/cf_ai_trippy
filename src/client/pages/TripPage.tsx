import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import { useState } from "react";
import type { Job, TripAgent, TripAgentState } from "../../agents/trip-agent";
import { ChatPanel } from "../components/ChatPanel";
import { PlanPanel } from "../components/PlanPanel";
import { navigate } from "../lib/router";

export function TripPage({ tripId }: { tripId: string }) {
  const agent = useAgent<TripAgent, TripAgentState>({
    agent: "TripAgent",
    name: tripId
  });
  const chat = useAgentChat({ agent, experimental_throttle: 80 });
  const [actionError, setActionError] = useState<string | null>(null);

  const state = agent.state;
  const trip = state?.trip;
  const jobRunning = state?.job?.status === "running";
  const hasItems = trip?.days.some((d) => d.items.length > 0) ?? false;

  async function run(action: () => Promise<unknown>) {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

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
        <div className="flex shrink-0 gap-2">
          {hasItems && (
            <HeaderButton
              disabled={jobRunning}
              onClick={() => run(() => agent.stub.startCheck())}
              title="Locate places and check the plan against your rules"
            >
              Check plan
            </HeaderButton>
          )}
          {state?.canUndo && (
            <HeaderButton
              onClick={() => run(() => agent.stub.undo())}
              title={state.lastChange?.summary}
            >
              Undo
            </HeaderButton>
          )}
        </div>
      </header>
      {(state?.warnings ?? []).map((w) => (
        <p
          key={w}
          className="bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {w}
        </p>
      ))}
      {actionError && (
        <p role="alert" className="px-4 py-2 text-sm text-red-600">
          {actionError}
        </p>
      )}

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:grid-rows-1">
        <ChatPanel chat={chat} />
        <div className="overflow-y-auto border-t border-neutral-200 md:border-t-0 md:border-l dark:border-neutral-800">
          {state?.job && <JobBanner job={state.job} />}
          {trip && !hasItems && !jobRunning && (
            <div className="m-4 rounded-lg border border-dashed border-neutral-300 p-4 text-center dark:border-neutral-700">
              <p className="mb-3 text-sm text-neutral-600 dark:text-neutral-400">
                Let Trippy draft a day-by-day plan from your interests, pace and
                the weather. You can change anything afterwards.
              </p>
              <button
                type="button"
                onClick={() => run(() => agent.stub.startPlanning())}
                className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700"
              >
                Build my itinerary
              </button>
            </div>
          )}
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

function HeaderButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
    />
  );
}

function JobBanner({ job }: { job: Job }) {
  if (job.status === "running") {
    return (
      <div
        className="border-b border-neutral-200 px-4 py-3 dark:border-neutral-800"
        aria-live="polite"
      >
        <p className="mb-1.5 text-sm">{job.message}</p>
        <div className="h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
          <div
            className="h-full bg-orange-500 transition-[width] duration-500"
            style={{ width: `${Math.max(job.percent, 0.03) * 100}%` }}
          />
        </div>
      </div>
    );
  }
  const tone =
    job.status === "error"
      ? "text-red-600"
      : "text-emerald-700 dark:text-emerald-400";
  return (
    <p
      className={`border-b border-neutral-200 px-4 py-2 text-sm dark:border-neutral-800 ${tone}`}
      aria-live="polite"
    >
      {job.message}
    </p>
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
