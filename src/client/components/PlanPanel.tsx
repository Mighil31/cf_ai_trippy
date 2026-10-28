import { estimatedTotal } from "../../shared/budget";
import type { Day, Item, Trip } from "../../shared/schema";
import { formatDate, formatMoney } from "../lib/format";

/** Read-only view of the plan. Direct editing controls arrive in Phase 5. */
export function PlanPanel({
  trip,
  lastChange
}: {
  trip: Trip;
  lastChange: { summary: string; at: string } | null;
}) {
  const d = trip.details;
  const { currency } = d.budget;
  const spent = estimatedTotal(trip);
  const ratio = d.budget.amount > 0 ? spent / d.budget.amount : 0;

  return (
    <div className="space-y-6 p-4">
      <section className="space-y-2">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {d.destination.name} · {formatDate(d.startDate)} –{" "}
          {formatDate(d.endDate)} · {d.travellers}{" "}
          {d.travellers === 1 ? "traveller" : "travellers"} · {d.pace} pace
        </p>
        {d.interests.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {d.interests.map((i) => (
              <li
                key={i}
                className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800"
              >
                {i}
              </li>
            ))}
          </ul>
        )}
        <div>
          <div className="flex justify-between text-sm">
            <span>
              Estimated {formatMoney(spent, currency)} of{" "}
              {formatMoney(d.budget.amount, currency)}
            </span>
            {ratio > 1 && <span className="text-red-600">Over budget</span>}
          </div>
          <div
            className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
            aria-hidden="true"
          >
            <div
              className={
                ratio > 1 ? "h-full bg-red-500" : "h-full bg-orange-500"
              }
              style={{ width: `${Math.min(ratio, 1) * 100}%` }}
            />
          </div>
        </div>
        {lastChange && (
          <p className="text-xs text-neutral-500">
            Last change: {lastChange.summary}
          </p>
        )}
      </section>

      {(trip.constraints.length > 0 || trip.lodging) && (
        <section className="space-y-3 text-sm">
          {trip.constraints.length > 0 && (
            <div>
              <h2 className="mb-1 font-medium">Your rules</h2>
              <ul className="list-inside list-disc text-neutral-700 dark:text-neutral-300">
                {trip.constraints.map((c) => (
                  <li key={c.id}>
                    <span className="text-neutral-500">{c.kind}:</span> {c.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {trip.lodging && (
            <div>
              <h2 className="mb-1 font-medium">Where to stay</h2>
              <p>
                {trip.lodging.area}
                {trip.lodging.nightlyPrice && (
                  <span className="text-neutral-500">
                    {" "}
                    · {formatMoney(trip.lodging.nightlyPrice.min, currency)}–
                    {formatMoney(trip.lodging.nightlyPrice.max, currency)}/night
                    (estimated)
                  </span>
                )}
              </p>
              {trip.lodging.description && (
                <p className="text-neutral-600 dark:text-neutral-400">
                  {trip.lodging.description}
                </p>
              )}
            </div>
          )}
        </section>
      )}

      <section className="space-y-4">
        {trip.days.map((day, i) => (
          <DayCard key={day.date} day={day} index={i} currency={currency} />
        ))}
      </section>
    </div>
  );
}

function DayCard({
  day,
  index,
  currency
}: {
  day: Day;
  index: number;
  currency: string;
}) {
  return (
    <article className="rounded-lg border border-neutral-200 dark:border-neutral-800">
      <header className="border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <h3 className="font-medium">
          Day {index + 1} ·{" "}
          {formatDate(day.date, {
            weekday: "short",
            day: "numeric",
            month: "short"
          })}
          {day.dayTrip && (
            <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-800 dark:bg-sky-900 dark:text-sky-200">
              Day trip: {day.dayTrip.destination}
            </span>
          )}
        </h3>
        {day.theme && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {day.theme}
          </p>
        )}
      </header>
      {day.items.length === 0 ? (
        <p className="px-4 py-3 text-sm text-neutral-500">
          Nothing planned yet.
        </p>
      ) : (
        <ol className="divide-y divide-neutral-100 dark:divide-neutral-900">
          {day.items.map((item) => (
            <ItemRow key={item.id} item={item} currency={currency} />
          ))}
        </ol>
      )}
    </article>
  );
}

const KIND_LABEL: Record<Item["kind"], string> = {
  activity: "Activity",
  meal: "Meal",
  transit: "Transit",
  lodging: "Lodging",
  free_time: "Free time"
};

function ItemRow({ item, currency }: { item: Item; currency: string }) {
  const time = item.startTime
    ? `${item.startTime}${item.endTime ? `–${item.endTime}` : ""}`
    : "";
  return (
    <li className="flex gap-3 px-4 py-2 text-sm">
      <span className="w-24 shrink-0 text-neutral-500 tabular-nums">
        {time}
      </span>
      <div className="min-w-0 flex-1">
        <p>
          <span className="font-medium">{item.title}</span>
          {item.locked && (
            <span className="ml-1.5 text-xs text-neutral-500" title="Locked">
              🔒
            </span>
          )}
        </p>
        <p className="text-xs text-neutral-500">
          {KIND_LABEL[item.kind]}
          {item.place && ` · ${item.place.name}`}
          {item.cost &&
            ` · ${formatMoney(item.cost.amount, currency)}${item.cost.estimated ? " est." : ""}`}
        </p>
        {item.description && (
          <p className="mt-0.5 text-neutral-600 dark:text-neutral-400">
            {item.description}
          </p>
        )}
      </div>
    </li>
  );
}
