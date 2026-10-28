import { vi } from "vitest";

type Handler = (url: URL, init?: RequestInit) => unknown;

/**
 * Route fetches by hostname to handlers returning JSON bodies. Unhandled
 * hosts get a 503 like the default offline mock. Returns the spy so tests can
 * count calls.
 */
export function mockFetch(routes: Record<string, Handler>) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const handler = routes[url.hostname];
      if (!handler) return new Response("unmocked host", { status: 503 });
      return Response.json(handler(url, init));
    });
}

export const lisbonGeocoding = {
  results: [
    {
      name: "Lisbon",
      latitude: 40.772,
      longitude: -80.768,
      country: "United States",
      country_code: "US",
      timezone: "America/New_York",
      population: 2727
    },
    {
      name: "Lisbon",
      latitude: 38.72509,
      longitude: -9.1498,
      country: "Portugal",
      country_code: "PT",
      timezone: "Europe/Lisbon",
      population: 517802
    }
  ]
};

/** Daily weather for every date in the request's start..end range. */
export function dailyWeather(url: URL, code = 2) {
  const start = Date.parse(url.searchParams.get("start_date")!);
  const end = Date.parse(url.searchParams.get("end_date")!);
  const time: string[] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    time.push(new Date(t).toISOString().slice(0, 10));
  }
  const values: Record<string, number> = {
    weather_code: code,
    temperature_2m_max: 21.4,
    temperature_2m_min: 13.6,
    precipitation_probability_max: 10,
    precipitation_sum: 0
  };
  // Like the real API, only return the fields that were asked for
  const daily: Record<string, unknown> = { time };
  for (const field of url.searchParams.get("daily")!.split(",")) {
    daily[field] = time.map(() => values[field]);
  }
  return { daily };
}

export const weatherRoutes = {
  "api.open-meteo.com": (url: URL) => dailyWeather(url),
  "archive-api.open-meteo.com": (url: URL) => dailyWeather(url)
};
