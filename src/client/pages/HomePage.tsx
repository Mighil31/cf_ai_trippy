import { useAgent } from "agents/react";
import { useState, type FormEvent } from "react";
import type {
  UserDirectory,
  UserDirectoryState
} from "../../agents/user-directory";
import {
  MAX_TRIP_DAYS,
  tripLength,
  type Pace,
  type TripDetails,
  type TripSummary
} from "../../shared/schema";
import {
  ErrorText,
  Field,
  InterestPicker,
  LinkButton,
  PrimaryButton
} from "../components/form";
import { formatDate } from "../lib/format";
import { navigate } from "../lib/router";
import { getUserId } from "../lib/user";

export function HomePage() {
  const directory = useAgent<UserDirectory, UserDirectoryState>({
    agent: "UserDirectory",
    name: getUserId()
  });
  const trips = directory.state?.trips;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Trippy</h1>
        <p className="mt-1 text-neutral-600 dark:text-neutral-400">
          Tell Trippy where you're going. It drafts a day-by-day plan around
          your interests, budget and the weather, then keeps it up to date as
          you change things.
        </p>
      </header>

      <NewTripForm
        onCreate={async (details, autoPlan) => {
          const summary = await directory.stub.createTrip(details, {
            autoPlan
          });
          navigate(`/trips/${summary.id}`);
        }}
      />

      <section className="mt-10">
        <h2 className="mb-3 text-lg font-medium">My trips</h2>
        {trips === undefined ? (
          <p className="text-sm text-neutral-500">Loading…</p>
        ) : trips.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No trips yet. Trips are saved in this browser.
          </p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {trips.map((t) => (
              <TripRow
                key={t.id}
                trip={t}
                onDelete={() => directory.stub.deleteTrip(t.id)}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function TripRow({
  trip,
  onDelete
}: {
  trip: TripSummary;
  onDelete: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex items-center gap-2 pr-2 hover:bg-neutral-50 dark:hover:bg-neutral-900">
      <a
        href={`/trips/${trip.id}`}
        onClick={(e) => {
          e.preventDefault();
          navigate(`/trips/${trip.id}`);
        }}
        className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-4 px-4 py-3"
      >
        <span className="font-medium">{trip.title}</span>
        <span className="text-sm text-neutral-500">
          {trip.destination} · {formatDate(trip.startDate)}
        </span>
      </a>
      {confirming ? (
        <span className="flex shrink-0 items-center gap-1 text-sm">
          Delete?
          <LinkButton
            onClick={() => onDelete()}
            className="!text-red-600"
            aria-label={`Confirm deleting ${trip.title}`}
          >
            Yes
          </LinkButton>
          <LinkButton onClick={() => setConfirming(false)}>No</LinkButton>
        </span>
      ) : (
        <LinkButton
          onClick={() => setConfirming(true)}
          aria-label={`Delete ${trip.title}`}
        >
          Delete
        </LinkButton>
      )}
    </li>
  );
}

const PACES: { value: Pace; label: string }[] = [
  { value: "relaxed", label: "Relaxed (2–3 things a day)" },
  { value: "moderate", label: "Moderate (3–4 a day)" },
  { value: "packed", label: "Packed (5+ a day)" }
];

function NewTripForm({
  onCreate
}: {
  onCreate: (details: TripDetails, autoPlan: boolean) => Promise<void>;
}) {
  const [interests, setInterests] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const destination = String(f.get("destination")).trim();
    const startDate = String(f.get("startDate"));
    const endDate = String(f.get("endDate"));

    // Quick checks here; the server validates everything again
    const days = tripLength(startDate, endDate);
    if (days < 1)
      return setError("The end date must be on or after the start date.");
    if (days > MAX_TRIP_DAYS)
      return setError(`Trips can be at most ${MAX_TRIP_DAYS} days.`);

    const details: TripDetails = {
      title: String(f.get("title")).trim() || `Trip to ${destination}`,
      destination: { name: destination },
      startDate,
      endDate,
      travellers: Number(f.get("travellers")),
      budget: {
        amount: Number(f.get("budget")),
        currency: String(f.get("currency")).trim().toUpperCase()
      },
      interests,
      pace: f.get("pace") as Pace,
      notes: String(f.get("notes")).trim() || undefined
    };
    setBusy(true);
    setError(null);
    try {
      await onCreate(details, f.get("autoPlan") === "on");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="grid gap-4 rounded-lg border border-neutral-200 p-5 sm:grid-cols-2 dark:border-neutral-800"
    >
      <h2 className="text-lg font-medium sm:col-span-2">Plan a new trip</h2>
      <Field label="Where to?" className="sm:col-span-2">
        <input
          name="destination"
          required
          maxLength={120}
          placeholder="Lisbon, Portugal"
        />
      </Field>
      <Field label="From">
        <input name="startDate" type="date" required />
      </Field>
      <Field label="To">
        <input name="endDate" type="date" required />
      </Field>
      <Field label="Travellers">
        <input
          name="travellers"
          type="number"
          min={1}
          max={20}
          required
          defaultValue={2}
        />
      </Field>
      <Field label="Pace">
        <select name="pace" defaultValue="moderate">
          {PACES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Total budget for the group">
        <input
          name="budget"
          type="number"
          min={0}
          step={1}
          required
          defaultValue={1500}
        />
      </Field>
      <Field label="Currency">
        <input
          name="currency"
          required
          defaultValue="EUR"
          maxLength={3}
          pattern="[A-Za-z]{3}"
          title="3-letter currency code, e.g. EUR"
        />
      </Field>
      <div className="sm:col-span-2">
        <InterestPicker value={interests} onChange={setInterests} />
      </div>
      <Field
        label="Anything else Trippy should know?"
        className="sm:col-span-2"
      >
        <textarea
          name="notes"
          rows={2}
          maxLength={2000}
          placeholder="We're vegetarian, no early mornings, one of us uses a wheelchair…"
        />
      </Field>
      <Field label="Trip name (optional)" className="sm:col-span-2">
        <input name="title" maxLength={120} placeholder="Lisbon long weekend" />
      </Field>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="autoPlan" defaultChecked />
        Draft a day-by-day itinerary for me right away
      </label>
      {error && (
        <div className="sm:col-span-2">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      <div className="sm:col-span-2">
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create trip"}
        </PrimaryButton>
      </div>
    </form>
  );
}
