import { cached, fetchJson } from "./http";
import { distanceKm } from "./travel";

/** Open-Meteo geocoding: free, no key, includes timezone. */
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const TTL = 30 * 24 * 3600;

export type GeoPlace = {
  name: string;
  country?: string;
  admin1?: string;
  lat: number;
  lon: number;
  timezone?: string;
  population?: number;
};

type OpenMeteoGeocoding = {
  results?: {
    name: string;
    latitude: number;
    longitude: number;
    country?: string;
    country_code?: string;
    admin1?: string;
    timezone?: string;
    population?: number;
  }[];
};

/**
 * Geocode free text like "Lisbon, Portugal" or "Sintra". Open-Meteo searches
 * by place name only, so the text after the first comma is used to pick the
 * best match (country or region), falling back to the most populous result.
 */
export async function geocode(
  kv: KVNamespace,
  query: string
): Promise<GeoPlace | null> {
  const [name, ...rest] = query.split(",").map((s) => s.trim());
  if (!name) return null;
  const hint = rest.join(" ").toLowerCase();

  const results = await cached(
    kv,
    `geo:v1:${name.toLowerCase()}`,
    TTL,
    async () => {
      const url = new URL(GEOCODING_URL);
      url.searchParams.set("name", name);
      url.searchParams.set("count", "10");
      url.searchParams.set("language", "en");
      url.searchParams.set("format", "json");
      const data = await fetchJson<OpenMeteoGeocoding>("geocoding", url);
      return data.results ?? [];
    }
  );
  if (results.length === 0) return null;

  const matchesHint = (r: (typeof results)[number]) =>
    !hint ||
    [r.country, r.country_code, r.admin1].some(
      (v) => v && hint.includes(v.toLowerCase())
    );
  const candidates = results.filter(matchesHint);
  const best = (candidates.length ? candidates : results).reduce((a, b) =>
    (b.population ?? 0) > (a.population ?? 0) ? b : a
  );

  return {
    name: best.name,
    country: best.country,
    admin1: best.admin1,
    lat: best.latitude,
    lon: best.longitude,
    timezone: best.timezone,
    population: best.population
  };
}

const WIKIPEDIA_URL = "https://en.wikipedia.org/w/api.php";

/**
 * Find coordinates for a named place (e.g. "São Jorge Castle") near a point,
 * using Wikipedia search. Only accepts a hit within `maxKm`, so a same-named
 * place elsewhere isn't picked. Returns null if nothing suitable is found.
 */
export async function locatePlace(
  kv: KVNamespace,
  name: string,
  near: { lat: number; lon: number; name: string },
  maxKm = 60
): Promise<{ lat: number; lon: number } | null> {
  const query = `${name} ${near.name}`;
  const pages = await cached(
    kv,
    `locate:v1:${query.toLowerCase()}`,
    TTL,
    async () => {
      const url = new URL(WIKIPEDIA_URL);
      for (const [k, v] of Object.entries({
        action: "query",
        format: "json",
        formatversion: "2",
        generator: "search",
        gsrsearch: query,
        gsrlimit: "3",
        prop: "coordinates"
      })) {
        url.searchParams.set(k, v);
      }
      const data = await fetchJson<{
        query?: {
          pages?: {
            index?: number;
            coordinates?: { lat: number; lon: number }[];
          }[];
        };
      }>("locate", url);
      return (data.query?.pages ?? [])
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((p) => p.coordinates?.[0] ?? null);
    }
  );
  for (const pos of pages) {
    if (pos && distanceKm(near, pos) <= maxKm) {
      return { lat: pos.lat, lon: pos.lon };
    }
  }
  return null;
}
