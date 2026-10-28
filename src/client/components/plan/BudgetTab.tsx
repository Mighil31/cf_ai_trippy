import {
  CATEGORY_LABEL,
  budgetBreakdown,
  type BudgetCategory
} from "../../../shared/budget";
import { formatDate, formatMoney } from "../../lib/format";
import { useTrip } from "../../lib/trip-context";

export function BudgetTab() {
  const { trip, askTrippy } = useTrip();
  const { amount, currency } = trip.details.budget;
  const b = budgetBreakdown(trip);
  const ratio = amount > 0 ? b.total / amount : 0;
  const remaining = amount - b.total;
  const perPerson = b.total / trip.details.travellers;
  const maxCategory = Math.max(1, ...Object.values(b.byCategory));
  const maxDay = Math.max(1, ...b.byDay.map((d) => d.total));

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Estimated total
        </p>
        <p className="text-3xl font-semibold tabular-nums">
          {formatMoney(b.total, currency)}
          <span className="ml-2 text-base font-normal text-neutral-500">
            of {formatMoney(amount, currency)}
          </span>
        </p>
        <div
          className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
          aria-hidden="true"
        >
          <div
            className={ratio > 1 ? "h-full bg-red-500" : "h-full bg-orange-500"}
            style={{ width: `${Math.min(ratio, 1) * 100}%` }}
          />
        </div>
        <p
          className={`mt-2 text-sm ${remaining < 0 ? "text-red-600" : "text-neutral-600 dark:text-neutral-400"}`}
        >
          {remaining >= 0
            ? `${formatMoney(remaining, currency)} left`
            : `${formatMoney(-remaining, currency)} over budget`}{" "}
          · about {formatMoney(perPerson, currency)} per person
        </p>
        {remaining < 0 && (
          <button
            type="button"
            onClick={() =>
              askTrippy(
                `We're ${formatMoney(-remaining, currency)} over budget. Suggest cheaper swaps that keep the trip fun.`
              )
            }
            className="mt-2 text-sm text-orange-700 underline dark:text-orange-400"
          >
            Ask Trippy to bring it under budget
          </button>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-medium">By category</h2>
        <ul className="space-y-2 text-sm">
          {(Object.keys(CATEGORY_LABEL) as BudgetCategory[]).map((key) => (
            <li key={key}>
              <div className="flex justify-between">
                <span>{CATEGORY_LABEL[key]}</span>
                <span className="tabular-nums">
                  {formatMoney(b.byCategory[key], currency)}
                </span>
              </div>
              <Bar value={b.byCategory[key]} max={maxCategory} />
            </li>
          ))}
        </ul>
        {b.lodgingEstimate > 0 && (
          <p className="mt-2 text-xs text-neutral-500">
            Lodging uses the middle of the nightly range ×{" "}
            {trip.days.length - 1} nights.
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-medium">By day (excluding lodging)</h2>
        <ul className="space-y-2 text-sm">
          {b.byDay.map((d, i) => (
            <li key={d.date}>
              <div className="flex justify-between">
                <span>
                  Day {i + 1} ·{" "}
                  {formatDate(d.date, {
                    weekday: "short",
                    day: "numeric",
                    month: "short"
                  })}
                </span>
                <span className="tabular-nums">
                  {formatMoney(d.total, currency)}
                </span>
              </div>
              <Bar value={d.total} max={maxDay} />
            </li>
          ))}
        </ul>
      </section>

      <p className="text-xs text-neutral-500">
        All amounts are estimates for the whole group unless you entered them
        yourself. Check real prices before booking.
      </p>
    </div>
  );
}

function Bar({ value, max }: { value: number; max: number }) {
  return (
    <div
      className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
      aria-hidden="true"
    >
      <div
        className="h-full bg-neutral-500 dark:bg-neutral-400"
        style={{ width: `${(value / max) * 100}%` }}
      />
    </div>
  );
}
