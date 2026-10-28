import { useEffect, useState } from "react";

type Health = { ok: boolean; service: string };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json() as Promise<Health>)
      .then(setHealth)
      .catch(() => setHealth({ ok: false, service: "trippy" }));
  }, []);

  return (
    <main className="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">Trippy</h1>
      <p className="text-neutral-600 dark:text-neutral-400">
        Your AI trip planner. Describe a trip and Trippy builds the itinerary.
      </p>
      <p className="text-sm text-neutral-500">
        API:{" "}
        {health === null ? "checking…" : health.ok ? "online" : "unreachable"}
      </p>
    </main>
  );
}
