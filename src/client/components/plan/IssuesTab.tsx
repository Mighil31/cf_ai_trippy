import type { Issue } from "../../../shared/schema";
import { useTrip } from "../../lib/trip-context";
import { LinkButton } from "../form";

const SEVERITY_STYLE: Record<Issue["severity"], string> = {
  error: "border-red-500 bg-red-50 dark:bg-red-950/40",
  warning: "border-amber-500 bg-amber-50 dark:bg-amber-950/40",
  info: "border-sky-500 bg-sky-50 dark:bg-sky-950/40"
};

const SEVERITY_LABEL: Record<Issue["severity"], string> = {
  error: "Problem",
  warning: "Worth checking",
  info: "Note"
};

export function IssuesTab() {
  const { trip, askTrippy, showDay } = useTrip();

  if (trip.issues.length === 0) {
    return (
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Nothing to flag. Trippy checks timings, travel between places, pace,
        weather, budget and your rules after every change.
      </p>
    );
  }

  return (
    <ul className="space-y-2 text-sm">
      {trip.issues.map((issue, i) => (
        <li
          key={`${issue.code}-${issue.itemId ?? issue.date ?? ""}-${i}`}
          className={`border-l-4 px-3 py-2 ${SEVERITY_STYLE[issue.severity]}`}
        >
          <p>
            <span className="font-medium">
              {SEVERITY_LABEL[issue.severity]}:
            </span>{" "}
            {issue.message}
          </p>
          <div className="mt-1 flex gap-1">
            {issue.date && (
              <LinkButton onClick={() => showDay(issue.date!)}>
                Show day
              </LinkButton>
            )}
            <LinkButton
              onClick={() => askTrippy(`Please fix this: ${issue.message}`)}
            >
              Ask Trippy to fix
            </LinkButton>
          </div>
        </li>
      ))}
    </ul>
  );
}
