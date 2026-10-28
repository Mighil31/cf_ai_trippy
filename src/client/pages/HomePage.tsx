import { useAgent } from "agents/react";
import { useState, type FormEvent } from "react";
import type {
  UserDirectory,
  UserDirectoryState
} from "../../agents/user-directory";
import type { Pace, TripDetails } from "../../shared/schema";
import { formatDate } from "../lib/format";
import { navigate } from "../lib/router";
import { getUserId } from "../lib/user";

export function HomePage() {
  const directory = useAgent<UserDirectory, UserDirectoryState>({
    agent: "UserDirectory",
    name: getUserId()
  });
  const trips = directory.state?.trips ?? [];

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Trippy</h1>
        <p className="mt-1 text-neutral-600 dark:text-neutral-400">
          Describe a trip and Trippy builds the itinerary with you.
        </p>
      </header>

      <NewTripForm
        onCreate={async (details) => {
          const summary = await directory.stub.createTrip(details);
          navigate(`/trips/${summary.id}`);
        }}
      />

      <section className="mt-10">
        <h2 className="mb-3 text-lg font-medium">My trips</h2>
        {trips.length === 0 ? (
          <p className="text-sm text-neutral-500">No trips yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {trips.map((t) => (
              <li key={t.id}>
                <a
                  href={`/trips/${t.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/trips/${t.id}`);
                  }}
                  className="flex items-baseline justify-between gap-4 px-4 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-900"
                >
                  <span className="font-medium">{t.title}</span>
                  <span className="shrink-0 text-sm text-neutral-500">
                    {t.destination} · {formatDate(t.startDate)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

const PACES: Pace[] = ["relaxed", "moderate", "packed"];

function NewTripForm({
  onCreate
}: {
  onCreate: (details: TripDetails) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const destination = String(f.get("destination")).trim();
    const details: TripDetails = {
      title: String(f.get("title")).trim() || `Trip to ${destination}`,
      destination: { name: destination },
      startDate: String(f.get("startDate")),
      endDate: String(f.get("endDate")),
      travellers: Number(f.get("travellers")),
      budget: {
        amount: Number(f.get("budget")),
        currency: String(f.get("currency")).trim().toUpperCase()
      },
      interests: String(f.get("interests"))
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      pace: f.get("pace") as Pace,
      notes: String(f.get("notes")).trim() || undefined
    };
    setBusy(true);
    setError(null);
    try {
      await onCreate(details);
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
      <Field label="Destination" className="sm:col-span-2">
        <input name="destination" required placeholder="Lisbon, Portugal" />
      </Field>
      <Field label="Trip name (optional)" className="sm:col-span-2">
        <input name="title" placeholder="Lisbon long weekend" />
      </Field>
      <Field label="Start date">
        <input name="startDate" type="date" required />
      </Field>
      <Field label="End date">
        <input name="endDate" type="date" required />
      </Field>
      <Field label="Travellers">
        <input
          name="travellers"
          type="number"
          min={1}
          max={20}
          defaultValue={2}
        />
      </Field>
      <Field label="Pace">
        <select name="pace" defaultValue="moderate">
          {PACES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Total budget">
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
        <input name="currency" required defaultValue="EUR" maxLength={3} />
      </Field>
      <Field label="Interests (comma separated)" className="sm:col-span-2">
        <input name="interests" placeholder="food, history, viewpoints" />
      </Field>
      <Field label="Anything else? (optional)" className="sm:col-span-2">
        <textarea
          name="notes"
          rows={2}
          placeholder="Vegetarian, no early mornings…"
        />
      </Field>
      {error && (
        <p
          role="alert"
          className="text-sm whitespace-pre-wrap text-red-600 sm:col-span-2"
        >
          {error}
        </p>
      )}
      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-orange-600 px-4 py-2 font-medium text-white hover:bg-orange-700 disabled:opacity-60"
        >
          {busy ? "Creating…" : "Create trip"}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  className = "",
  children
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`field flex flex-col gap-1 text-sm ${className}`}>
      <span className="text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
    </label>
  );
}
