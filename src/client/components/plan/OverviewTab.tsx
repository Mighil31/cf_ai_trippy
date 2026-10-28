import { useState, type FormEvent } from "react";
import type { ConstraintKind, Pace, Trip } from "../../../shared/schema";
import { formatDate, formatMoney } from "../../lib/format";
import { useTrip } from "../../lib/trip-context";
import {
  Field,
  InterestPicker,
  LinkButton,
  PrimaryButton,
  SecondaryButton
} from "../form";

export function OverviewTab() {
  return (
    <div className="space-y-6">
      <DetailsCard />
      <RulesCard />
      <LodgingCard />
    </div>
  );
}

function Card({
  title,
  action,
  children
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function DetailsCard() {
  const { trip } = useTrip();
  const [editing, setEditing] = useState(false);
  const d = trip.details;

  if (editing) {
    return (
      <Card title="Trip details">
        <DetailsForm trip={trip} onDone={() => setEditing(false)} />
      </Card>
    );
  }
  return (
    <Card
      title="Trip details"
      action={
        <SecondaryButton onClick={() => setEditing(true)}>Edit</SecondaryButton>
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-neutral-500">Destination</dt>
        <dd>
          {d.destination.name}
          {d.destination.timezone && (
            <span className="text-neutral-500">
              {" "}
              · {d.destination.timezone}
            </span>
          )}
        </dd>
        <dt className="text-neutral-500">Dates</dt>
        <dd>
          {formatDate(d.startDate)} – {formatDate(d.endDate)} (
          {trip.days.length} {trip.days.length === 1 ? "day" : "days"})
        </dd>
        <dt className="text-neutral-500">Travellers</dt>
        <dd>{d.travellers}</dd>
        <dt className="text-neutral-500">Budget</dt>
        <dd>{formatMoney(d.budget.amount, d.budget.currency)} in total</dd>
        <dt className="text-neutral-500">Pace</dt>
        <dd className="capitalize">{d.pace}</dd>
        <dt className="text-neutral-500">Interests</dt>
        <dd>{d.interests.join(", ") || "—"}</dd>
        {d.notes && (
          <>
            <dt className="text-neutral-500">Notes</dt>
            <dd className="whitespace-pre-wrap">{d.notes}</dd>
          </>
        )}
      </dl>
    </Card>
  );
}

function DetailsForm({ trip, onDone }: { trip: Trip; onDone: () => void }) {
  const { actions } = useTrip();
  const d = trip.details;
  const [interests, setInterests] = useState(d.interests);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const destination = String(f.get("destination")).trim();
    const patch = {
      title: String(f.get("title")).trim(),
      ...(destination !== d.destination.name && {
        // A new destination is geocoded again on the server
        destination: { name: destination }
      }),
      startDate: String(f.get("startDate")),
      endDate: String(f.get("endDate")),
      travellers: Number(f.get("travellers")),
      budget: {
        amount: Number(f.get("budget")),
        currency: String(f.get("currency")).trim().toUpperCase()
      },
      pace: f.get("pace") as Pace,
      interests,
      notes: String(f.get("notes")).trim() || undefined
    };
    setBusy(true);
    const ok = await actions.updateDetails(patch);
    setBusy(false);
    if (ok) onDone();
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <Field label="Trip name" className="sm:col-span-2">
        <input name="title" required defaultValue={d.title} maxLength={120} />
      </Field>
      <Field label="Destination" className="sm:col-span-2">
        <input name="destination" required defaultValue={d.destination.name} />
      </Field>
      <Field label="Start date">
        <input
          name="startDate"
          type="date"
          required
          defaultValue={d.startDate}
        />
      </Field>
      <Field label="End date">
        <input name="endDate" type="date" required defaultValue={d.endDate} />
      </Field>
      <Field label="Travellers">
        <input
          name="travellers"
          type="number"
          min={1}
          max={20}
          required
          defaultValue={d.travellers}
        />
      </Field>
      <Field label="Pace">
        <select name="pace" defaultValue={d.pace}>
          <option value="relaxed">relaxed</option>
          <option value="moderate">moderate</option>
          <option value="packed">packed</option>
        </select>
      </Field>
      <Field label="Total budget">
        <input
          name="budget"
          type="number"
          min={0}
          required
          defaultValue={d.budget.amount}
        />
      </Field>
      <Field label="Currency">
        <input
          name="currency"
          required
          maxLength={3}
          defaultValue={d.budget.currency}
        />
      </Field>
      <div className="sm:col-span-2">
        <InterestPicker value={interests} onChange={setInterests} />
      </div>
      <Field label="Notes" className="sm:col-span-2">
        <textarea name="notes" rows={2} defaultValue={d.notes ?? ""} />
      </Field>
      <p className="text-xs text-neutral-500 sm:col-span-2">
        Changing dates removes plans on days that are no longer in the trip (you
        can undo).
      </p>
      <div className="flex gap-2 sm:col-span-2">
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </PrimaryButton>
        <SecondaryButton onClick={onDone}>Cancel</SecondaryButton>
      </div>
    </form>
  );
}

const KIND_HELP: Record<ConstraintKind, string> = {
  must: "Must",
  avoid: "Avoid",
  preference: "Prefer"
};

function RulesCard() {
  const { trip, actions } = useTrip();
  const [kind, setKind] = useState<ConstraintKind>("avoid");
  const [text, setText] = useState("");

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    if (await actions.addConstraint(kind, text.trim())) setText("");
  }

  return (
    <Card title="Your rules">
      <p className="mb-3 text-sm text-neutral-600 dark:text-neutral-400">
        Trippy follows these when planning and checks the plan against them.
      </p>
      {trip.constraints.length > 0 && (
        <ul className="mb-3 space-y-1 text-sm">
          {trip.constraints.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2">
              <span>
                <span className="text-neutral-500">{KIND_HELP[c.kind]}:</span>{" "}
                {c.text}
              </span>
              <LinkButton
                onClick={() => actions.removeConstraint(c.id)}
                aria-label={`Remove rule: ${c.text}`}
              >
                Remove
              </LinkButton>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="field flex flex-wrap gap-2">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as ConstraintKind)}
          aria-label="Rule type"
        >
          <option value="avoid">Avoid</option>
          <option value="must">Must</option>
          <option value="preference">Prefer</option>
        </select>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='e.g. "nothing before 9:30" or "vegetarian food"'
          aria-label="Rule"
          maxLength={300}
          className="min-w-0 flex-1"
        />
        <SecondaryButton type="submit" disabled={!text.trim()}>
          Add rule
        </SecondaryButton>
      </form>
    </Card>
  );
}

function LodgingCard() {
  const { trip, actions, askTrippy } = useTrip();
  const [editing, setEditing] = useState(false);
  const { currency } = trip.details.budget;
  const lodging = trip.lodging;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const min = f.get("min") ? Number(f.get("min")) : undefined;
    const max = f.get("max") ? Number(f.get("max")) : undefined;
    const ok = await actions.setLodging({
      area: String(f.get("area")).trim(),
      description: String(f.get("description")).trim() || undefined,
      ...(min !== undefined &&
        max !== undefined && {
          nightlyPrice: { min, max }
        }),
      // Prices typed by the user are theirs, not estimates
      estimated: false
    });
    if (ok) setEditing(false);
  }

  return (
    <Card
      title="Where to stay"
      action={
        !editing && (
          <SecondaryButton onClick={() => setEditing(true)}>
            {lodging ? "Edit" : "Set"}
          </SecondaryButton>
        )
      }
    >
      {editing ? (
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <Field label="Area or neighbourhood" className="sm:col-span-2">
            <input name="area" required defaultValue={lodging?.area ?? ""} />
          </Field>
          <Field label={`Nightly from (${currency})`}>
            <input
              name="min"
              type="number"
              min={0}
              defaultValue={lodging?.nightlyPrice?.min}
            />
          </Field>
          <Field label={`Nightly to (${currency})`}>
            <input
              name="max"
              type="number"
              min={0}
              defaultValue={lodging?.nightlyPrice?.max}
            />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <textarea
              name="description"
              rows={2}
              defaultValue={lodging?.description ?? ""}
            />
          </Field>
          <div className="flex gap-2 sm:col-span-2">
            <PrimaryButton type="submit">Save</PrimaryButton>
            <SecondaryButton onClick={() => setEditing(false)}>
              Cancel
            </SecondaryButton>
          </div>
        </form>
      ) : lodging ? (
        <div className="text-sm">
          <p>
            {lodging.area}
            {lodging.nightlyPrice && (
              <span className="text-neutral-500">
                {" "}
                · {formatMoney(lodging.nightlyPrice.min, currency)}–
                {formatMoney(lodging.nightlyPrice.max, currency)} per night
                {lodging.estimated && " (estimated)"}
              </span>
            )}
          </p>
          {lodging.description && (
            <p className="mt-1 text-neutral-600 dark:text-neutral-400">
              {lodging.description}
            </p>
          )}
          <a
            className="mt-2 inline-block text-orange-700 underline dark:text-orange-400"
            href={`https://www.google.com/travel/hotels/${encodeURIComponent(
              `${lodging.area}, ${trip.details.destination.name}`
            )}`}
            target="_blank"
            rel="noreferrer"
          >
            Search hotels in {lodging.area} ↗
          </a>
        </div>
      ) : (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Not set yet.{" "}
          <LinkButton
            className="!text-sm underline"
            onClick={() => askTrippy("Where should we stay?")}
          >
            Ask Trippy
          </LinkButton>
        </p>
      )}
    </Card>
  );
}
