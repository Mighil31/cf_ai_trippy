import { ServiceError, cached, fetchJson } from "./http";
import { distanceKm } from "./travel";

/**
 * Two keyless sources:
 * - Wikipedia geosearch for sights, museums, parks, viewpoints and markets.
 *   Reliable, and an article's existence is a good sign a place is notable.
 * - OpenStreetMap (Overpass) for food and nightlife, which Wikipedia rarely
 *   covers. Public Overpass servers are often overloaded, so queries are kept
 *   cheap and mirrors are tried in turn.
 */
const WIKIPEDIA_URL = "https://en.wikipedia.org/w/api.php";
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];
const TTL = 7 * 24 * 3600;
/** After Overpass fails, skip it for a while instead of waiting on timeouts. */
const OSM_DOWN_KEY = "places:osm-down";
const OSM_DOWN_TTL = 10 * 60;
export const MAX_PLACES = 15;

export const PlaceCategory = [
  "sights",
  "museums",
  "viewpoints",
  "parks",
  "markets",
  "food",
  "cafes",
  "nightlife"
] as const;
export type PlaceCategory = (typeof PlaceCategory)[number];

/** Matched against Wikipedia's short description, e.g. "Art museum in Lisbon". */
const WIKI_CATEGORIES: Partial<Record<PlaceCategory, RegExp>> = {
  sights:
    /\b(castle|palace|monastery|cathedral|church|basilica|chapel|tower|monument|memorial|fortress|fort|aqueduct|landmark|bridge|convent|square|plaza|ruins|statue|temple|shrine|mosque|synagogue|historic)\b/i,
  museums:
    /\b(museum|gallery|oceanarium|aquarium|science cent(er|re)|planetarium)\b/i,
  parks: /\b(park|garden|gardens|zoo|botanical|forest|beach)\b/i,
  viewpoints:
    /\b(viewpoint|miradouro|belvedere|lookout|observation|hill|summit)\b/i,
  markets: /\b(market|bazaar|souk|shopping|mall|arcade)\b/i
};

/** Excludes articles that match a keyword but aren't places to visit. */
const NOT_A_SIGHT =
  /\b(station|parish|school|university|company|agency|hospital|stadium|district|neighbou?rhood|street|avenue|road|railway accident|battle)\b/i;

const OSM_CATEGORIES: Partial<Record<PlaceCategory, string>> = {
  food: '["amenity"="restaurant"]',
  cafes: '["amenity"~"^(cafe|ice_cream)$"]',
  nightlife: '["amenity"~"^(bar|pub|nightclub)$"]'
};

export type FoundPlace = {
  name: string;
  kind: string;
  lat: number;
  lon: number;
  distanceKm: number;
  notable: boolean;
  cuisine?: string;
  website?: string;
};

/** Places of one category near a point. */
export async function findPlaces(
  kv: KVNamespace,
  category: PlaceCategory,
  lat: number,
  lon: number,
  cuisine?: string
): Promise<FoundPlace[]> {
  const key = `places:v2:${category}:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const places = await cached(kv, key, TTL, () =>
    category in OSM_CATEGORIES
      ? searchOsm(kv, category, lat, lon)
      : searchWikipedia(category, lat, lon)
  );
  const wanted = cuisine?.trim().toLowerCase();
  const filtered = wanted
    ? places.filter((p) => p.cuisine?.toLowerCase().includes(wanted))
    : places;
  return filtered.slice(0, MAX_PLACES);
}

// ── Wikipedia ─────────────────────────────────────────────────────────

type WikiPage = {
  title: string;
  description?: string;
  coordinates?: { lat: number; lon: number }[];
};

async function searchWikipedia(
  category: PlaceCategory,
  lat: number,
  lon: number
): Promise<FoundPlace[]> {
  const url = new URL(WIKIPEDIA_URL);
  for (const [k, v] of Object.entries({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "geosearch",
    ggscoord: `${lat}|${lon}`,
    ggsradius: "10000",
    ggslimit: "500",
    prop: "description|coordinates",
    colimit: "500"
  })) {
    url.searchParams.set(k, v);
  }
  const data = await fetchJson<{ query?: { pages?: WikiPage[] } }>(
    "places",
    url
  );
  return fromWikipedia(data.query?.pages ?? [], category, lat, lon);
}

export function fromWikipedia(
  pages: WikiPage[],
  category: PlaceCategory,
  lat: number,
  lon: number
): FoundPlace[] {
  const wanted = WIKI_CATEGORIES[category];
  if (!wanted) return [];
  const places: FoundPlace[] = [];
  for (const page of pages) {
    const description = page.description ?? "";
    const pos = page.coordinates?.[0];
    if (!pos || !wanted.test(description) || NOT_A_SIGHT.test(description)) {
      continue;
    }
    places.push({
      name: page.title.replace(/ \([^)]*\)$/, ""),
      kind: description,
      lat: round5(pos.lat),
      lon: round5(pos.lon),
      distanceKm: roundKm(lat, lon, pos),
      notable: true
    });
  }
  // Wikipedia's order roughly tracks prominence; keep it
  return places;
}

// ── OpenStreetMap ─────────────────────────────────────────────────────

type OverpassElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

/** Nodes only and a small radius: cheap enough for busy public servers. */
export function buildOverpassQuery(
  category: PlaceCategory,
  lat: number,
  lon: number
): string {
  const selector = OSM_CATEGORIES[category];
  if (!selector) throw new Error(`${category} is not an OSM category`);
  return `[out:json][timeout:10];node${selector}["name"](around:1500,${lat.toFixed(5)},${lon.toFixed(5)});out tags 100;`;
}

async function searchOsm(
  kv: KVNamespace,
  category: PlaceCategory,
  lat: number,
  lon: number
): Promise<FoundPlace[]> {
  if (await kv.get(OSM_DOWN_KEY).catch(() => null)) {
    throw new ServiceError("places", "OpenStreetMap search is unavailable");
  }
  const body = `data=${encodeURIComponent(buildOverpassQuery(category, lat, lon))}`;
  let lastError: unknown;
  for (const url of OVERPASS_URLS) {
    try {
      const data = await fetchJson<{ elements: OverpassElement[] }>(
        "places",
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          timeoutMs: 6_000
        }
      );
      return toPlaces(data.elements, lat, lon);
    } catch (err) {
      lastError = err;
    }
  }
  await kv
    .put(OSM_DOWN_KEY, "1", { expirationTtl: OSM_DOWN_TTL })
    .catch(() => {});
  throw lastError instanceof ServiceError
    ? lastError
    : new ServiceError("places", String(lastError));
}

export function toPlaces(
  elements: OverpassElement[],
  lat: number,
  lon: number
): FoundPlace[] {
  const seen = new Set<string>();
  const places: FoundPlace[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    const pos = el.center ?? (el.lat !== undefined ? el : undefined);
    const name = tags["name:en"] ?? tags.name;
    if (!name || !pos || pos.lat === undefined || pos.lon === undefined) {
      continue;
    }
    // The same place is often mapped as both a node and a building
    const dedupeKey = name.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    places.push({
      name,
      kind: tags.amenity ?? tags.tourism ?? tags.shop ?? "place",
      lat: round5(pos.lat),
      lon: round5(pos.lon),
      distanceKm: roundKm(lat, lon, { lat: pos.lat, lon: pos.lon }),
      notable: Boolean(tags.wikidata || tags.wikipedia),
      ...(tags.cuisine && { cuisine: tags.cuisine.replace(/;/g, ", ") }),
      ...(tags.website && { website: tags.website })
    });
  }
  // Places with more mapped detail (cuisine, website) tend to be established
  const detail = (p: FoundPlace) =>
    Number(p.notable) * 2 +
    Number(Boolean(p.cuisine)) +
    Number(Boolean(p.website));
  return places.sort(
    (a, b) => detail(b) - detail(a) || a.distanceKm - b.distanceKm
  );
}

function roundKm(lat: number, lon: number, pos: { lat: number; lon: number }) {
  return Math.round(distanceKm({ lat, lon }, pos) * 10) / 10;
}

function round5(n: number) {
  return Math.round(n * 1e5) / 1e5;
}
