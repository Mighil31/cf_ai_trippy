import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("worker", () => {
  it("responds to /api/health", async () => {
    const res = await exports.default.fetch("http://example.com/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "trippy" });
  });

  it("returns 404 for unknown API routes", async () => {
    const res = await exports.default.fetch("http://example.com/api/nope");
    expect(res.status).toBe(404);
  });
});
