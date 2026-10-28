import { estimatedTotal } from "../shared/budget";
import type { Day, Issue, Item, Pace, Trip } from "../shared/schema";
import { distanceKm, estimateTravel } from "../services/travel";
import { isWetWeather } from "../services/weather";

/**
 * Deterministic checks, run after every change. They only flag problems; the
 * model or the user decides how to fix them. Issues whose code starts with
 * "review." come from the LLM review in ValidateTripWorkflow and are kept.
 */

/** Activities per day beyond which a day feels rushed, by pace. */
export const MAX_ACTIVITIES: Record<Pace, number> = {
  relaxed: 3,
  moderate: 4,
  packed: 6
};
const MAX_DAY_SPAN_MIN = 14 * 60;
const MAX_DAY_TRIP_KM = 150;
const OUTDOOR =
  /\b(viewpoint|miradouro|park|garden|beach|hike|hiking|walk|walking|tour|boat|cruise|picnic|market|zoo|outdoor|terrace|rooftop)\b/i;

export function runChecks(trip: Trip): Issue[] {
  const issues: Issue[] = [];
  const { destination } = trip.details;
  const anyPlanned = trip.days.some((d) => d.items.length > 0);

  for (const day of trip.days) {
    if (day.items.length === 0) {
      if (anyPlanned) {
        issues.push({
          code: "empty_day",
          severity: "info",
          message: `Nothing planned on ${label(day)} yet.`,
          date: day.date
        });
      }
      continue;
    }
    issues.push(...checkTimes(day));
    issues.push(...checkLoad(day, trip.details.pace));
    issues.push(...checkWeather(day));
    if (
      day.dayTrip &&
      destination.lat !== undefined &&
      destination.lon !== undefined
    ) {
      const home = { lat: destination.lat, lon: destination.lon };
      const far = day.items.find(
        (i) =>
          i.place?.lat !== undefined &&
          distanceKm(home, { lat: i.place.lat, lon: i.place.lon! }) >
            MAX_DAY_TRIP_KM
      );
      if (far) {
        issues.push({
          code: "day_trip_far",
          severity: "warning",
          message: `${far.title} is over ${MAX_DAY_TRIP_KM} km from ${destination.name}: too far for a day trip.`,
          date: day.date,
          itemId: far.id
        });
      }
    }
  }

  issues.push(...checkTimeRules(trip));
  issues.push(...checkBudget(trip));
  const kept = trip.issues.filter(
    (i) => i.code.startsWith("review.") && stillRelevant(trip, i)
  );
  return sortIssues([...issues, ...kept]);
}

function checkTimes(day: Day): Issue[] {
  const issues: Issue[] = [];
  const timed = day.items.filter((i) => i.startTime);
  for (let k = 1; k < timed.length; k++) {
    const prev = timed[k - 1];
    const next = timed[k];
    const prevEnd = prev.endTime ?? prev.startTime!;
    const gap = minutes(next.startTime!) - minutes(prevEnd);

    if (gap < 0) {
      issues.push({
        code: "overlap",
        severity: "error",
        message: `"${prev.title}" (until ${prevEnd}) overlaps "${next.title}" (from ${next.startTime}) on ${label(day)}.`,
        date: day.date,
        itemId: next.id
      });
      continue;
    }
    const a = coords(prev);
    const b = coords(next);
    if (a && b && next.kind !== "transit" && prev.kind !== "transit") {
      const travel = estimateTravel(a, b);
      if (travel.minutes > gap + 5) {
        issues.push({
          code: "travel_gap",
          severity: "warning",
          message: `Getting from "${prev.title}" to "${next.title}" takes about ${travel.minutes} min (${travel.mode === "walk" ? "walking" : "by transit"}), but there are only ${gap} min between them.`,
          date: day.date,
          itemId: next.id
        });
      }
    }
  }
  return issues;
}

function checkLoad(day: Day, pace: Pace): Issue[] {
  const issues: Issue[] = [];
  const activities = day.items.filter((i) => i.kind === "activity").length;
  if (activities > MAX_ACTIVITIES[pace]) {
    issues.push({
      code: "long_day",
      severity: "warning",
      message: `${label(day)} has ${activities} activities, a lot for a ${pace} pace (about ${MAX_ACTIVITIES[pace]} max).`,
      date: day.date
    });
  }
  const timed = day.items.filter((i) => i.startTime);
  if (timed.length >= 2) {
    const first = minutes(timed[0].startTime!);
    const last = timed[timed.length - 1];
    const end = minutes(last.endTime ?? last.startTime!);
    if (end - first > MAX_DAY_SPAN_MIN) {
      issues.push({
        code: "long_day",
        severity: "warning",
        message: `${label(day)} runs from ${timed[0].startTime} to ${last.endTime ?? last.startTime}, over ${MAX_DAY_SPAN_MIN / 60} hours.`,
        date: day.date
      });
    }
  }
  return issues;
}

function checkWeather(day: Day): Issue[] {
  if (!day.weather || !isWetWeather(day.weather)) return [];
  const outdoor = day.items.filter(
    (i) =>
      i.kind === "activity" &&
      OUTDOOR.test(`${i.title} ${i.description ?? ""} ${i.place?.name ?? ""}`)
  );
  return outdoor.map((i) => ({
    code: "outdoor_in_rain",
    severity: "info" as const,
    message: `"${i.title}" looks like an outdoor plan, and ${day.weather!.basis === "forecast" ? "the forecast says" : "it's typically"} ${day.weather!.summary.toLowerCase()} on ${label(day)}.`,
    date: day.date,
    itemId: i.id
  }));
}

export type TimeRule = {
  constraintText: string;
  kind: "start" | "end";
  time: string;
};

/**
 * Time-of-day rules ("nothing before 9:30", "back by 10pm") parsed from the
 * traveller's constraints, so they are checked exactly rather than by the LLM.
 */
export function parseTimeRules(trip: Trip): TimeRule[] {
  const rules: TimeRule[] = [];
  for (const c of trip.constraints) {
    // Needs a real time ("9:30", "21.00", "10pm"), so "after 2 museums" isn't one
    const m = c.text.match(
      /\b(before|earlier than|until|after|later than|past|back by|by)\s+(\d{1,2})(?:[:.h](\d{2})\s*(am|pm)?|\s*(am|pm))\b/i
    );
    if (!m) continue;
    let hour = Number(m[2]);
    const minute = m[3] ?? "00";
    const meridiem = (m[4] ?? m[5])?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour > 23 || Number(minute) > 59) continue;
    const time = `${String(hour).padStart(2, "0")}:${minute}`;
    const word = m[1].toLowerCase();
    // "nothing before 9:30" limits starts; "nothing after 22:00" / "back by" limits ends
    const kind = ["before", "earlier than", "until"].includes(word)
      ? "start"
      : "end";
    rules.push({ constraintText: c.text, kind, time });
  }
  return rules;
}

function checkTimeRules(trip: Trip): Issue[] {
  const issues: Issue[] = [];
  for (const rule of parseTimeRules(trip)) {
    for (const day of trip.days) {
      for (const item of day.items) {
        if (item.kind === "transit") continue;
        const breaks =
          rule.kind === "start"
            ? item.startTime !== undefined && item.startTime < rule.time
            : (item.endTime ?? item.startTime) !== undefined &&
              (item.endTime ?? item.startTime)! > rule.time;
        if (!breaks) continue;
        const when =
          rule.kind === "start"
            ? `starts at ${item.startTime}`
            : `ends at ${item.endTime ?? item.startTime}`;
        issues.push({
          code: "rule_time",
          severity: "warning",
          message: `${label(day)}: "${item.title}" ${when} (your rule: ${rule.constraintText}).`,
          date: day.date,
          itemId: item.id
        });
      }
    }
  }
  return issues;
}

function checkBudget(trip: Trip): Issue[] {
  const { amount, currency } = trip.details.budget;
  if (amount <= 0) return [];
  const total = estimatedTotal(trip);
  const ratio = total / amount;
  if (ratio > 1) {
    return [
      {
        code: "over_budget",
        severity: "error",
        message: `Estimated cost ${total} ${currency} is over the ${amount} ${currency} budget by ${total - amount} ${currency}.`
      }
    ];
  }
  if (ratio > 0.9) {
    return [
      {
        code: "near_budget",
        severity: "warning",
        message: `Estimated cost ${total} ${currency} uses ${Math.round(ratio * 100)}% of the budget.`
      }
    ];
  }
  return [];
}

/** Drop review issues that point at items or days no longer in the trip. */
function stillRelevant(trip: Trip, issue: Issue): boolean {
  if (issue.date && !trip.days.some((d) => d.date === issue.date)) return false;
  if (
    issue.itemId &&
    !trip.days.some((d) => d.items.some((i) => i.id === issue.itemId))
  ) {
    return false;
  }
  return true;
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

function sortIssues(issues: Issue[]): Issue[] {
  return issues.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.date ?? "").localeCompare(b.date ?? "")
  );
}

function coords(item: Item) {
  const { lat, lon } = item.place ?? {};
  return lat !== undefined && lon !== undefined ? { lat, lon } : null;
}

function minutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function label(day: Day): string {
  return new Date(`${day.date}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short"
  });
}
