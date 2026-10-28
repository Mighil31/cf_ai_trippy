import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep
} from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import type { TripAgent } from "../agents/trip-agent";
import { generateJson } from "../agents/llm";
import { renderTrip } from "../agents/prompt";
import { parseTimeRules } from "../agents/validate";
import type { Issue, Trip } from "../shared/schema";
import type { JobProgress } from "./plan-trip";

export type ValidateParams = Record<string, never>;

const Review = z.object({
  rules: z
    .array(
      z.object({
        rule: z.string(),
        violated: z.boolean(),
        evidence: z.array(z.string()).default([]),
        explanation: z.string().default("")
      })
    )
    .max(50)
});

const REVIEW_SYSTEM = `You check a travel itinerary against the traveller's own rules. Go through the rules one by one. A rule is violated only if specific items clearly break it; cite those items' ids as evidence. Count carefully. When unsure, the rule is not violated.`;

/** Rules that the instant checks already cover exactly. */
function isCheckedElsewhere(trip: Trip, ruleText: string) {
  return parseTimeRules(trip).some((r) => r.constraintText === ruleText);
}

/**
 * Turn the model's per-rule verdicts into issues, keeping only violations
 * backed by item ids that exist. Unsupported claims are dropped.
 */
export function reviewToIssues(
  trip: Trip,
  review: z.infer<typeof Review>
): Issue[] {
  const items = new Map(
    trip.days.flatMap((d) => d.items.map((i) => [i.id, { item: i, day: d }]))
  );
  const issues: Issue[] = [];
  for (const verdict of review.rules) {
    if (!verdict.violated) continue;
    const evidence = verdict.evidence
      .map((id) => items.get(id.replace(/[[\]\s]/g, "")))
      .filter((e) => e !== undefined);
    if (evidence.length === 0) continue;
    const first = evidence[0];
    const sameDay = evidence.every((e) => e.day.date === first.day.date);
    const titles = evidence.map((e) => `"${e.item.title}"`).join(", ");
    issues.push({
      code: "review.constraint",
      severity: "warning",
      message:
        `${sameDay ? `${dayLabel(first.day.date)}: ` : ""}${titles} may break your rule "${verdict.rule}". ${verdict.explanation}`.trim(),
      ...(sameDay && { date: first.day.date }),
      ...(evidence.length === 1 && { itemId: first.item.id })
    });
  }
  return issues;
}

function dayLabel(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short"
  });
}

/**
 * The thorough check, beyond the instant rule-based checks that run on every
 * change: locates places that lack coordinates (so travel times can be
 * checked) and has the LLM review the plan against the traveller's rules.
 */
export class ValidateTripWorkflow extends AgentWorkflow<
  TripAgent,
  ValidateParams,
  JobProgress,
  Env
> {
  async run(
    _event: AgentWorkflowEvent<ValidateParams>,
    step: AgentWorkflowStep
  ) {
    await this.reportProgress({
      step: "locate",
      message: "Locating places on the map…",
      percent: 0.1
    });
    const located = await step.do("locate places", async () => {
      const t = await this.agent.getTrip();
      if (!t) throw new NonRetryableError("Trip not found");
      return this.agent.locateMissingPlaces();
    });

    const trip = await step.do("reload trip", async () => {
      const t = await this.agent.getTrip();
      if (!t) throw new NonRetryableError("Trip not found");
      // RPC results carry a Disposable brand; steps need plain data
      return t as Trip;
    });

    let reviewIssues: Issue[] = [];
    const rulesToReview = trip.constraints.filter(
      (c) => !isCheckedElsewhere(trip, c.text)
    );
    const hasItems = trip.days.some((d) => d.items.length > 0);
    if (rulesToReview.length > 0 && hasItems) {
      await this.reportProgress({
        step: "review",
        message: "Checking the plan against your rules…",
        percent: 0.5
      });
      reviewIssues = await step.do(
        "review rules",
        {
          retries: { limit: 2, delay: "3 seconds", backoff: "constant" },
          timeout: "2 minutes"
        },
        async () => {
          const review = await generateJson(
            this.env.AI,
            Review,
            REVIEW_SYSTEM,
            `${renderTrip(trip)}

Rules to check:
${rulesToReview.map((c) => `- ${c.kind}: ${c.text}`).join("\n")}

For each rule above, decide whether the itinerary violates it.
JSON shape: {"rules": [{"rule": string, "violated": boolean, "evidence": [item ids], "explanation": string}]}
Item ids are the 6 characters inside [brackets]; give them without brackets.`,
            1000
          );
          return reviewToIssues(trip, review);
        }
      );
    }

    await this.reportProgress({
      step: "save",
      message: "Saving results…",
      percent: 0.9
    });
    const result = await step.do("save review", async () => {
      const { issues } = await this.agent.setReviewIssues(reviewIssues);
      return { issues };
    });
    const plural = (n: number, word: string) =>
      `${n} ${word}${n === 1 ? "" : "s"}`;
    const details = [
      located > 0 && `located ${plural(located, "place")}`,
      `${plural(result.issues, "issue")} found`
    ]
      .filter(Boolean)
      .join(", ");
    const summary = {
      summary: `Check finished: ${details}`,
      located,
      ruleIssues: reviewIssues.length,
      totalIssues: result.issues
    };
    await step.reportComplete(summary);
    return summary;
  }
}
