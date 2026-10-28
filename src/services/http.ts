/** Identifies Trippy to free public APIs, as their usage policies ask. */
export const USER_AGENT =
  "cf_ai_trippy/0.1 (+https://github.com/Mighil31/cf_ai_trippy)";

export class ServiceError extends Error {
  constructor(
    readonly service: string,
    message: string
  ) {
    super(`${service}: ${message}`);
    this.name = "ServiceError";
  }
}

export async function fetchJson<T>(
  service: string,
  url: string | URL,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 10_000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: { "User-Agent": USER_AGENT, ...rest.headers },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    throw new ServiceError(
      service,
      err instanceof Error ? err.message : String(err)
    );
  }
  if (!res.ok) {
    throw new ServiceError(service, `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * Read-through KV cache. Cache failures never fail the request: a broken or
 * rate-limited KV just means we call the upstream API.
 */
export async function cached<T>(
  kv: KVNamespace,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>
): Promise<T> {
  try {
    const hit = await kv.get<T>(key, "json");
    if (hit !== null) return hit;
  } catch {
    // fall through to load
  }
  const value = await load();
  try {
    // KV's minimum TTL is 60 seconds
    await kv.put(key, JSON.stringify(value), {
      expirationTtl: Math.max(ttlSeconds, 60)
    });
  } catch {
    // free-tier write limits etc.; the value is still returned
  }
  return value;
}
