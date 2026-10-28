import { useState, type FormEvent } from "react";
import type {
  Day,
  Issue,
  Item,
  ItemKind,
  WeatherSummary
} from "../../../shared/schema";
import { formatDate, formatMoney } from "../../lib/format";
import { useTrip } from "../../lib/trip-context";
import { Field, LinkButton, PrimaryButton, SecondaryButton } from "../form";

export function DaysTab() {
  const { trip, jobRunning, actions } = useTrip();
  const hasItems = trip.days.some((d) => d.items.length > 0);

  return (
    <div className="space-y-4">
      {!hasItems && !jobRunning && (
        <div className="rounded-lg border border-dashed border-neutral-300 p-4 text-center dark:border-neutral-700">
          <p className="mb-3 text-sm text-neutral-600 dark:text-neutral-400">
            Let Trippy draft a day-by-day plan from your interests, pace and the
            weather. You can change anything afterwards.
          </p>
          <PrimaryButton onClick={() => actions.buildItinerary()}>
            Build my itinerary
          </PrimaryButton>
        </div>
      )}
      {trip.days.map((day, i) => (
        <DayCard key={day.date} day={day} index={i} />
      ))}
    </div>
  );
}

function DayCard({ day, index }: { day: Day; index: number }) {
  const { trip, jobRunning, actions, askTrippy } = useTrip();
  const [adding, setAdding] = useState(false);
  const dayIssues = trip.issues.filter((i) => i.date === day.date);
  const label = formatDate(day.date, {
    weekday: "short",
    day: "numeric",
    month: "short"
  });

  return (
    <article
      id={`day-${day.date}`}
      className="scroll-mt-4 rounded-lg border border-neutral-200 dark:border-neutral-800"
    >
      <header className="border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-medium">
            Day {index + 1} · {label}
            {day.dayTrip && (
              <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-xs font-normal text-sky-800 dark:bg-sky-900 dark:text-sky-200">
                Day trip: {day.dayTrip.destination}
              </span>
            )}
            {dayIssues.length > 0 && (
              <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-normal text-amber-900 dark:bg-amber-900 dark:text-amber-100">
                {dayIssues.length} to check
              </span>
            )}
          </h3>
          <div className="flex gap-1">
            <LinkButton onClick={() => setAdding(true)}>Add item</LinkButton>
            <LinkButton
              disabled={jobRunning}
              onClick={() => actions.redoDay(day.date)}
              title="Re-plan this day from scratch (locked items stay)"
            >
              Redo day
            </LinkButton>
            <LinkButton
              onClick={() => askTrippy(`For day ${index + 1} (${label}): `)}
            >
              Ask Trippy
            </LinkButton>
          </div>
        </div>
        {(day.theme || day.weather) && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {day.theme}
            {day.theme && day.weather && " · "}
            {day.weather && <WeatherLabel weather={day.weather} />}
          </p>
        )}
      </header>

      {day.items.length === 0 && !adding && (
        <p className="px-4 py-3 text-sm text-neutral-500">
          Nothing planned yet.
        </p>
      )}
      <ol className="divide-y divide-neutral-100 dark:divide-neutral-900">
        {day.items.map((item, i) => (
          <ItemRow
            key={item.id}
            item={item}
            day={day}
            index={i}
            issues={trip.issues.filter((x) => x.itemId === item.id)}
          />
        ))}
      </ol>
      {adding && (
        <div className="border-t border-neutral-200 p-4 dark:border-neutral-800">
          <ItemForm
            onCancel={() => setAdding(false)}
            onSubmit={async (fields) => {
              if (await actions.addItem(day.date, fields)) setAdding(false);
            }}
          />
        </div>
      )}
    </article>
  );
}

function WeatherLabel({ weather: w }: { weather: WeatherSummary }) {
  const temps =
    w.tempMinC !== undefined && w.tempMaxC !== undefined
      ? ` ${w.tempMinC}–${w.tempMaxC}°C`
      : "";
  const rain =
    w.precipitationChance !== undefined && w.precipitationChance >= 20
      ? `, ${w.precipitationChance}% rain`
      : "";
  return (
    <span
      title={
        w.basis === "climate"
          ? "Too far ahead for a forecast: this is last year's weather on the same date"
          : "Forecast from Open-Meteo"
      }
    >
      {w.summary}
      {temps}
      {rain}
      {w.basis === "climate" && " (typical)"}
    </span>
  );
}

export const KIND_LABEL: Record<ItemKind, string> = {
  activity: "Activity",
  meal: "Meal",
  transit: "Transit",
  lodging: "Lodging",
  free_time: "Free time"
};

function ItemRow({
  item,
  day,
  index,
  issues
}: {
  item: Item;
  day: Day;
  index: number;
  issues: Issue[];
}) {
  const { trip, actions, askTrippy } = useTrip();
  const [editing, setEditing] = useState(false);
  const currency = trip.details.budget.currency;
  const time = item.startTime
    ? `${item.startTime}${item.endTime ? `–${item.endTime}` : ""}`
    : "";

  if (editing) {
    return (
      <li className="p-4">
        <ItemForm
          item={item}
          onCancel={() => setEditing(false)}
          onSubmit={async (fields) => {
            if (await actions.updateItem(item.id, fields)) setEditing(false);
          }}
        />
      </li>
    );
  }

  return (
    <li className="group flex gap-3 px-4 py-2 text-sm">
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
        {issues.map((issue, k) => (
          <p
            key={k}
            className="mt-1 text-xs text-amber-800 dark:text-amber-300"
          >
            ⚠ {issue.message}
          </p>
        ))}
        {/* Revealed on hover or keyboard focus where hovering is possible */}
        <div className="mt-1 flex flex-wrap items-center gap-0.5 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100">
          <LinkButton
            aria-label={`Move ${item.title} up`}
            disabled={index === 0}
            onClick={() => actions.moveItem(item.id, day.date, index - 1)}
          >
            ↑
          </LinkButton>
          <LinkButton
            aria-label={`Move ${item.title} down`}
            disabled={index === day.items.length - 1}
            onClick={() => actions.moveItem(item.id, day.date, index + 1)}
          >
            ↓
          </LinkButton>
          <select
            aria-label={`Move ${item.title} to another day`}
            value=""
            onChange={(e) => {
              if (e.target.value) actions.moveItem(item.id, e.target.value);
            }}
            className="rounded bg-transparent px-1 py-0.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            <option value="">Move to…</option>
            {trip.days
              .filter((d) => d.date !== day.date)
              .map((d) => (
                <option key={d.date} value={d.date}>
                  Day {trip.days.indexOf(d) + 1} ·{" "}
                  {formatDate(d.date, { day: "numeric", month: "short" })}
                </option>
              ))}
          </select>
          <LinkButton
            onClick={() => actions.setItemLocked(item.id, !item.locked)}
            title={
              item.locked
                ? "Let Trippy change this item again"
                : "Keep this item when Trippy re-plans"
            }
          >
            {item.locked ? "Unlock" : "Lock"}
          </LinkButton>
          <LinkButton onClick={() => setEditing(true)}>Edit</LinkButton>
          <LinkButton
            onClick={() =>
              askTrippy(
                `About "${item.title}" on ${formatDate(day.date, { day: "numeric", month: "short" })}: `
              )
            }
          >
            Ask Trippy
          </LinkButton>
          <LinkButton
            onClick={() => actions.removeItem(item.id)}
            className="hover:!text-red-600"
          >
            Delete
          </LinkButton>
        </div>
      </div>
    </li>
  );
}

const KINDS: ItemKind[] = [
  "activity",
  "meal",
  "transit",
  "free_time",
  "lodging"
];

/** Add or edit an item. Sends only the item fields; the server validates. */
function ItemForm({
  item,
  onSubmit,
  onCancel
}: {
  item?: Item;
  onSubmit: (fields: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const { trip } = useTrip();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const placeName = String(f.get("place")).trim();
    const costText = String(f.get("cost")).trim();
    const cost = costText === "" ? undefined : Number(costText);

    // When editing, empty optional fields are sent as null to clear them
    const empty = item ? null : undefined;
    const fields: Record<string, unknown> = {
      kind: f.get("kind"),
      title: String(f.get("title")).trim(),
      startTime: String(f.get("startTime")) || empty,
      endTime: String(f.get("endTime")) || empty,
      description: String(f.get("description")).trim() || empty,
      place: empty,
      cost: empty
    };
    if (placeName) {
      // Keep known coordinates if the place itself didn't change
      fields.place =
        item?.place && item.place.name === placeName
          ? item.place
          : { name: placeName };
    }
    if (cost !== undefined) {
      const unchanged = item?.cost && item.cost.amount === cost;
      fields.cost = unchanged ? item.cost : { amount: cost, estimated: false };
    }
    setBusy(true);
    await onSubmit(fields);
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-4">
      <Field label="Title" className="sm:col-span-3">
        <input
          name="title"
          required
          maxLength={160}
          defaultValue={item?.title}
        />
      </Field>
      <Field label="Type">
        <select name="kind" defaultValue={item?.kind ?? "activity"}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Start">
        <input name="startTime" type="time" defaultValue={item?.startTime} />
      </Field>
      <Field label="End">
        <input name="endTime" type="time" defaultValue={item?.endTime} />
      </Field>
      <Field label="Place" className="sm:col-span-2">
        <input name="place" maxLength={160} defaultValue={item?.place?.name} />
      </Field>
      <Field label={`Cost for the group (${trip.details.budget.currency})`}>
        <input
          name="cost"
          type="number"
          min={0}
          step="any"
          defaultValue={item?.cost?.amount}
        />
      </Field>
      <Field label="Notes" className="sm:col-span-3">
        <input
          name="description"
          maxLength={1000}
          defaultValue={item?.description}
        />
      </Field>
      <div className="flex gap-2 sm:col-span-4">
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? "Saving…" : item ? "Save" : "Add"}
        </PrimaryButton>
        <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
      </div>
    </form>
  );
}
