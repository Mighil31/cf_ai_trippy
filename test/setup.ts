import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";

// KV isn't reset between tests; start each one with an empty cache
beforeEach(async () => {
  const { keys } = await env.CACHE.list();
  await Promise.all(keys.map((k) => env.CACHE.delete(k.name)));
});

// No test talks to real APIs. Tests that need responses use mockFetch().
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    return new Response(`offline in tests: ${String(input)}`, { status: 503 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
