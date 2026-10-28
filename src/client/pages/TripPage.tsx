import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import { useCallback, useRef, useState } from "react";
import type { Job, TripAgent, TripAgentState } from "../../agents/trip-agent";
import { budgetBreakdown } from "../../shared/budget";
import { ChatPanel } from "../components/ChatPanel";
import { SecondaryButton } from "../components/form";
import { BudgetTab } from "../components/plan/BudgetTab";
import { DaysTab } from "../components/plan/DaysTab";
import { IssuesTab } from "../components/plan/IssuesTab";
import { OverviewTab } from "../components/plan/OverviewTab";
import { formatDate, formatMoney } from "../lib/format";
import { navigate } from "../lib/router";
import {
  TripContext,
  useTrip,
  type TripActions,
  type TripContextValue
} from "../lib/trip-context";

type Tab = "days" | "overview" | "budget" | "issues";

export function TripPage({ tripId }: { tripId: string }) {
  const agent = useAgent<TripAgent, TripAgentState>({
    agent: "TripAgent",
    name: tripId
  });
  const chat = useAgentChat({ agent, experimental_throttle: 80 });
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<Tab>("days");
  const [mobileView, setMobileView] = useState<"plan" | "chat">("plan");
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  const state = agent.state;
  const trip = state?.trip;
  const job = state?.job ?? null;
  const jobRunning = job?.status === "running";

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, []);

  const stub = agent.stub;
  const actions: TripActions = {
    updateDetails: (patch) => run(() => stub.updateDetails(patch)),
    addConstraint: (kind, text) => run(() => stub.addConstraint(kind, text)),
    removeConstraint: (id) => run(() => stub.removeConstraint(id)),
    addItem: (date, item) => run(() => stub.addItem(date, item)),
    updateItem: (id, patch) => run(() => stub.updateItem(id, patch)),
    removeItem: (id) => run(() => stub.removeItem(id)),
    moveItem: (id, date, index) => run(() => stub.moveItem(id, date, index)),
    setItemLocked: (id, locked) => run(() => stub.setItemLocked(id, locked)),
    setLodging: (lodging) => run(() => stub.setLodging(lodging)),
    redoDay: (date) => run(() => stub.startPlanning([date])),
    buildItinerary: () => run(() => stub.startPlanning())
  };

  function askTrippy(text: string) {
    setDraft(text);
    setMobileView("chat");
    requestAnimationFrame(() => {
      const input = chatInputRef.current;
      input?.focus();
      input?.setSelectionRange(text.length, text.length);
    });
  }

  function showDay(date: string) {
    setTab("days");
    setMobileView("plan");
    requestAnimationFrame(() =>
      document
        .getElementById(`day-${date}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" })
    );
  }

  if (state && !trip) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16 text-center">
        <p className="mb-4">This trip doesn't exist, or it was deleted.</p>
        <BackLink />
      </main>
    );
  }

  const context: TripContextValue | null = trip
    ? { trip, job, jobRunning, actions, askTrippy, showDay }
    : null;
  const hasItems = trip?.days.some((d) => d.items.length > 0) ?? false;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="flex min-w-0 items-center gap-3">
          <BackLink />
          <div className="min-w-0">
            <h1 className="truncate font-semibold">
              {trip?.details.title ?? "Loading…"}
            </h1>
            {trip && (
              <p className="truncate text-xs text-neutral-500">
                {trip.details.destination.name} ·{" "}
                {formatDate(trip.details.startDate, {
                  day: "numeric",
                  month: "short"
                })}
                –{formatDate(trip.details.endDate)}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {hasItems && (
            <SecondaryButton
              disabled={jobRunning}
              onClick={() => run(() => stub.startCheck())}
              title="Locate places and check the plan against your rules"
            >
              Check plan
            </SecondaryButton>
          )}
          {state?.canUndo && (
            <SecondaryButton
              onClick={() => run(() => stub.undo())}
              title={
                state.lastChange ? `Undo: ${state.lastChange.summary}` : "Undo"
              }
            >
              Undo
            </SecondaryButton>
          )}
        </div>
      </header>

      {/* Small screens show one pane at a time */}
      <div
        className="flex border-b border-neutral-200 md:hidden dark:border-neutral-800"
        role="tablist"
        aria-label="View"
      >
        {(["plan", "chat"] as const).map((view) => (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={mobileView === view}
            onClick={() => setMobileView(view)}
            className={`flex-1 py-2 text-sm capitalize ${mobileView === view ? "border-b-2 border-orange-600 font-medium" : "text-neutral-500"}`}
          >
            {view}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div
          className={`min-h-0 flex-col ${mobileView === "chat" ? "flex" : "hidden"} md:flex`}
        >
          <ChatPanel
            chat={chat}
            input={draft}
            setInput={setDraft}
            inputRef={chatInputRef}
          />
        </div>
        <div
          className={`min-h-0 overflow-y-auto border-neutral-200 md:block md:border-l dark:border-neutral-800 ${mobileView === "plan" ? "block" : "hidden"}`}
        >
          {job && <JobBanner job={job} />}
          {(state?.warnings ?? []).map((w) => (
            <p
              key={w}
              className="bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
            >
              {w}
            </p>
          ))}
          {error && (
            <p
              role="alert"
              className="px-4 py-2 text-sm whitespace-pre-wrap text-red-600"
            >
              {error}
            </p>
          )}
          {context ? (
            <TripContext.Provider value={context}>
              <PlanPane
                tab={tab}
                setTab={setTab}
                lastChange={state?.lastChange ?? null}
              />
            </TripContext.Provider>
          ) : (
            <p className="p-4 text-sm text-neutral-500">Loading trip…</p>
          )}
        </div>
      </div>
    </div>
  );
}

function PlanPane({
  tab,
  setTab,
  lastChange
}: {
  tab: Tab;
  setTab: (tab: Tab) => void;
  lastChange: { summary: string; at: string } | null;
}) {
  const { trip } = useTrip();
  const { total } = budgetBreakdown(trip);
  const { amount, currency } = trip.details.budget;
  const tabs: { id: Tab; label: string; alert?: boolean }[] = [
    { id: "days", label: "Days" },
    { id: "overview", label: "Overview" },
    {
      id: "budget",
      label: `Budget · ${formatMoney(total, currency)}`,
      alert: total > amount
    },
    {
      id: "issues",
      label: `Issues${trip.issues.length ? ` (${trip.issues.length})` : ""}`
    }
  ];

  return (
    <div className="p-4">
      <div
        role="tablist"
        aria-label="Plan sections"
        className="mb-4 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-neutral-200 dark:border-neutral-800"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
              tab === t.id
                ? "border-orange-600 font-medium"
                : "border-transparent text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
            } ${t.alert ? "text-red-600" : ""}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "days" && <DaysTab />}
        {tab === "overview" && <OverviewTab />}
        {tab === "budget" && <BudgetTab />}
        {tab === "issues" && <IssuesTab />}
      </div>
      {lastChange && (
        <p className="mt-6 text-xs text-neutral-500">
          Last change: {lastChange.summary}
        </p>
      )}
    </div>
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
