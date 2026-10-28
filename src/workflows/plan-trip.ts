import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep
} from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";
import type { TripAgent } from "../agents/trip-agent";
import { generateJson } from "../agents/llm";
import {
  DayPlan,
  PLANNER_SYSTEM,
  Skeleton,
  categoriesFor,
  dayPrompt,
  skeletonPrompt,
  toItemInputs,
  type DayOutline
} from "../agents/planner";
import type { FoundPlace } from "../services/places";
import type { ItemInput, Trip } from "../shared/schema";

export type PlanParams = {
  /** Dates to (re)plan; the whole trip when generating from scratch. */
  dates: string[];
  /** The traveller's wishes for this run, in their words. */
  request?: string;
};

export type JobProgress = { step: string; message: string; percent: number };

export type GeneratedDay = {
  date: string;
  theme: string;
  dayTrip: string | null;
  items: ItemInput[];
};

export type GeneratedPlan = {
  days: GeneratedDay[];
  lodging?: {
    area: string;
    description?: string;
    nightlyMin?: number;
    nightlyMax?: number;
  };
};

/** LLM steps: retry a couple of times on bad JSON or a busy model. */
const LLM_STEP = {
  retries: { limit: 2, delay: "3 seconds", backoff: "constant" },
  timeout: "2 minutes"
} as const;
const CANDIDATES_PER_DAY = 30;

/**
 * Builds or rebuilds days of the itinerary. Each LLM call is its own durable
 * step, so a failure on day 4 retries day 4 only. The result is applied to the
 * trip in one step, which makes the whole run a single undoable change.
 */
export class PlanTripWorkflow extends AgentWorkflow<
  TripAgent,
  PlanParams,
  JobProgress,
  Env
> {
  async run(event: AgentWorkflowEvent<PlanParams>, step: AgentWorkflowStep) {
    const { dates, request } = event.payload;
    const progress = (stepName: string, message: string, percent: number) =>
      this.reportProgress({ step: stepName, message, percent });

    await progress("prepare", "Checking the map and weather…", 0.05);
    const trip = await step.do("load trip", async () => {
      await this.agent.refreshExternalData();
      const t = await this.agent.getTrip();
      if (!t) throw new NonRetryableError("Trip not found");
      // RPC results carry a Disposable brand; steps need plain data
      return t as Trip;
    });
    const targets = trip.days.filter((d) => dates.includes(d.date));
    if (targets.length === 0) throw new NonRetryableError("No matching days");

    // Reuse a single day's existing theme instead of re-planning the outline
    let outlines: DayOutline[];
    let lodging: GeneratedPlan["lodging"];
    const single = targets.length === 1 ? targets[0] : null;
    if (single?.theme) {
      outlines = [
        {
          date: single.date,
          theme: single.theme,
          dayTrip: single.dayTrip?.destination
        }
      ];
    } else {
      await progress("outline", "Sketching the days…", 0.15);
      const skeleton = await step.do("outline days", LLM_STEP, () =>
        generateJson(
          this.env.AI,
          Skeleton,
          PLANNER_SYSTEM,
          skeletonPrompt(trip, dates, request),
          1200
        )
      );
      outlines = targets.map((d) => {
        const planned = skeleton.days.find((s) => s.date === d.date);
        return {
          date: d.date,
          theme: planned?.theme ?? `Explore ${trip.details.destination.name}`,
          dayTrip: planned?.dayTrip || d.dayTrip?.destination || undefined
        };
      });
      lodging = trip.lodging ? undefined : (skeleton.lodging ?? undefined);
    }

    await progress("places", "Finding places worth visiting…", 0.25);
    const candidates = await step.do("find places", () =>
      this.findCandidates(trip, outlines)
    );

    const days: GeneratedDay[] = [];
    // Places on days not being re-planned, so new days don't repeat them
    const alreadyPlanned = trip.days
      .filter((d) => !dates.includes(d.date))
      .flatMap((d) => d.items.map((i) => i.place?.name ?? i.title));

    for (const [k, outline] of outlines.entries()) {
      const day = targets.find((d) => d.date === outline.date)!;
      await progress(
        `day:${outline.date}`,
        `Planning ${outline.theme} (${k + 1} of ${outlines.length})…`,
        0.3 + (0.6 * k) / outlines.length
      );
      const items = await step.do(
        `plan ${outline.date}`,
        LLM_STEP,
        async () => {
          const plan = await generateJson(
            this.env.AI,
            DayPlan,
            PLANNER_SYSTEM,
            dayPrompt({
              trip,
              day,
              outline,
              candidates: (outline.dayTrip
                ? (candidates[outline.dayTrip] ?? [])
                : candidates.main
              ).slice(0, CANDIDATES_PER_DAY),
              alreadyPlanned,
              request
            })
          );
          return toItemInputs(plan);
        }
      );
      alreadyPlanned.push(...items.map((i) => i.place?.name ?? i.title));
      days.push({
        date: outline.date,
        theme: outline.theme,
        dayTrip: outline.dayTrip ?? null,
        items
      });
    }

    await progress("save", "Saving the plan…", 0.95);
    const result = await step.do("apply plan", async () => {
      const { summary } = await this.agent.applyGeneratedPlan({
        days,
        lodging
      });
      return { summary };
    });
    await step.reportComplete(result);
    return result;
  }

  /**
   * Candidate places for the planner: interest-based categories near the
   * destination, plus sights and food in each day-trip town. A failed search
   * just means fewer candidates; the planner can still use its own knowledge.
   */
  private async findCandidates(trip: Trip, outlines: DayOutline[]) {
    const search = async (
      category: Parameters<TripAgent["candidatePlaces"]>[0],
      area?: string
    ) => (await this.agent.candidatePlaces(category, area)) as FoundPlace[];

    const categories = categoriesFor(trip.details.interests);
    const main = (await Promise.all(categories.map((c) => search(c)))).flatMap(
      (places) => places.slice(0, 10)
    );

    const result: Record<string, FoundPlace[]> = { main };
    const towns = [
      ...new Set(outlines.map((o) => o.dayTrip).filter(Boolean))
    ] as string[];
    for (const town of towns) {
      const [sights, food] = await Promise.all([
        search("sights", town),
        search("food", town)
      ]);
      result[town] = [...sights.slice(0, 12), ...food.slice(0, 8)];
    }
    return result;
  }
}
