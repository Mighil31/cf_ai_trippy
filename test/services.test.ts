import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { geocode } from "../src/services/geocode";
import {
  buildOverpassQuery,
  findPlaces,
  fromWikipedia,
  toPlaces
} from "../src/services/places";
import { distanceKm, estimateTravel } from "../src/services/travel";
import {
  addDays,
  describeWeatherCode,
  getWeather,
  isWetWeather,
  shiftYear
} from "../src/services/weather";
import { lisbonGeocoding, mockFetch, weatherRoutes } from "./mock-fetch";

/** Each test gets fresh KV storage, but keys are namespaced anyway. */
const kv = () => env.CACHE;

describe("geocode", () => {
  it("prefers the most populous match", async () => {
    mockFetch({ "geocoding-api.open-meteo.com": () => lisbonGeocoding });
    expect(await geocode(kv(), "Lisbon")).toMatchObject({
      country: "Portugal",
      timezone: "Europe/Lisbon"
    });
  });

  it("uses the text after the comma to pick the country", async () => {
    mockFetch({ "geocoding-api.open-meteo.com": () => lisbonGeocoding });
    expect(await geocode(kv(), "Lisbon, United States")).toMatchObject({
      country: "United States"
    });
  });

  it("searches by the name before the comma and caches it", async () => {
    const spy = mockFetch({
      "geocoding-api.open-meteo.com": () => lisbonGeocoding
    });
    await geocode(kv(), "Lisbon, Portugal");
    await geocode(kv(), "lisbon");
    expect(spy).toHaveBeenCalledTimes(1);
    const url = new URL(String(spy.mock.calls[0][0]));
    expect(url.searchParams.get("name")).toBe("Lisbon");
  });

  it("returns null when nothing matches", async () => {
    mockFetch({ "geocoding-api.open-meteo.com": () => ({}) });
    expect(await geocode(kv(), "Atlantis")).toBeNull();
  });

  it("throws a ServiceError when the API is down", async () => {
    await expect(geocode(kv(), "Lisbon")).rejects.toThrow(
      /geocoding: HTTP 503/
    );
  });
});

describe("weather", () => {
  it("uses forecasts within 16 days and last year's weather beyond", async () => {
    const spy = mockFetch(weatherRoutes);
    const today = "2026-11-01";
    const dates = ["2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18"];
    const weather = await getWeather(kv(), 38.7, -9.1, dates, today);

    expect(weather["2026-11-15"]).toMatchObject({
      basis: "forecast",
      summary: "Partly cloudy",
      tempMinC: 14,
      tempMaxC: 21,
      precipitationChance: 10
    });
    expect(weather["2026-11-16"].basis).toBe("forecast");
    expect(weather["2026-11-17"].basis).toBe("climate");
    expect(weather["2026-11-17"].precipitationChance).toBeUndefined();

    const archiveCall = spy.mock.calls
      .map(([u]) => new URL(String(u)))
      .find((u) => u.hostname === "archive-api.open-meteo.com")!;
    expect(archiveCall.searchParams.get("start_date")).toBe("2025-11-17");
    expect(archiveCall.searchParams.get("end_date")).toBe("2025-11-18");
  });

  it("skips dates in the past", async () => {
    const spy = mockFetch(weatherRoutes);
    expect(
      await getWeather(kv(), 38.7, -9.1, ["2026-10-01"], "2026-11-01")
    ).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });

  it("describes WMO codes and spots wet days", () => {
    expect(describeWeatherCode(0)).toBe("Clear sky");
    expect(describeWeatherCode(63)).toBe("Rain");
    expect(describeWeatherCode(95)).toBe("Thunderstorms");
    expect(isWetWeather({ summary: "Rain", basis: "forecast" })).toBe(true);
    expect(
      isWetWeather({
        summary: "Overcast",
        precipitationChance: 70,
        basis: "forecast"
      })
    ).toBe(true);
    expect(isWetWeather({ summary: "Clear sky", basis: "climate" })).toBe(
      false
    );
  });

  it("date helpers handle month ends and leap days", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(shiftYear("2028-02-29", -1)).toBe("2027-02-28");
  });
});

describe("places", () => {
  const center = { lat: 38.71, lon: -9.14 };

  it("keeps Wikipedia articles whose description fits the category", () => {
    const pages = [
      {
        title: "São Jorge Castle",
        description: "Historic castle in Lisbon, Portugal",
        coordinates: [{ lat: 38.7139, lon: -9.1335 }]
      },
      {
        title: "Anjos Station",
        description: "Metro station in Lisbon, Portugal",
        coordinates: [{ lat: 38.72, lon: -9.13 }]
      },
      {
        title: "Navy Museum (Portugal)",
        description: "Maritime museum in Lisbon",
        coordinates: [{ lat: 38.6975, lon: -9.2063 }]
      },
      { title: "No coordinates", description: "Palace in Lisbon" }
    ];
    expect(
      fromWikipedia(pages, "sights", center.lat, center.lon).map((p) => p.name)
    ).toEqual(["São Jorge Castle"]);
    expect(
      fromWikipedia(pages, "museums", center.lat, center.lon)
    ).toMatchObject([
      { name: "Navy Museum", kind: "Maritime museum in Lisbon", notable: true }
    ]);
  });

  it("searches Wikipedia for sights and caches the result", async () => {
    const spy = mockFetch({
      "en.wikipedia.org": () => ({
        query: {
          pages: [
            {
              title: "Belém Tower",
              description: "Fortified tower in Lisbon, Portugal",
              coordinates: [{ lat: 38.6916, lon: -9.2161 }]
            }
          ]
        }
      })
    });
    const first = await findPlaces(kv(), "sights", center.lat, center.lon);
    await findPlaces(kv(), "sights", center.lat, center.lon);
    expect(first[0].name).toBe("Belém Tower");
    expect(first[0].distanceKm).toBeGreaterThan(6.5);
    expect(first[0].distanceKm).toBeLessThan(7.5);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("uses a cheap nodes-only OSM query for food", () => {
    const q = buildOverpassQuery("food", center.lat, center.lon);
    expect(q).toContain('node["amenity"="restaurant"]["name"](around:1500,');
    expect(() => buildOverpassQuery("sights", 0, 0)).toThrow();
  });

  it("falls back to the next Overpass server", async () => {
    const spy = mockFetch({
      "overpass.private.coffee": () => ({
        elements: [
          {
            type: "node",
            id: 1,
            lat: 38.71,
            lon: -9.14,
            tags: { name: "Tasca", amenity: "restaurant" }
          }
        ]
      })
    });
    const places = await findPlaces(kv(), "food", center.lat, center.lon);
    expect(places.map((p) => p.name)).toEqual(["Tasca"]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("dedupes, prefers English names, and ranks detailed and near first", () => {
    const places = toPlaces(
      [
        {
          type: "node",
          id: 1,
          lat: 38.75,
          lon: -9.14,
          tags: { name: "Far Café", amenity: "cafe" }
        },
        {
          type: "node",
          id: 2,
          lat: 38.72,
          lon: -9.14,
          tags: {
            name: "Cervejaria Ramiro",
            "name:en": "Ramiro",
            amenity: "restaurant",
            wikidata: "Q1"
          }
        },
        {
          type: "node",
          id: 3,
          lat: 38.71,
          lon: -9.14,
          tags: {
            name: "Near Café",
            amenity: "cafe",
            cuisine: "coffee_shop;cake"
          }
        },
        {
          type: "node",
          id: 4,
          lat: 38.72,
          lon: -9.14,
          tags: { name: "Ramiro", amenity: "restaurant" }
        },
        {
          type: "node",
          id: 5,
          lat: 38.7,
          lon: -9.1,
          tags: { amenity: "bench" }
        }
      ],
      center.lat,
      center.lon
    );
    expect(places.map((p) => p.name)).toEqual([
      "Ramiro",
      "Near Café",
      "Far Café"
    ]);
    expect(places[1]).toMatchObject({
      cuisine: "coffee_shop, cake",
      distanceKm: 0,
      notable: false
    });
  });

  it("skips Overpass for a while after it fails", async () => {
    const spy = mockFetch({});
    await expect(
      findPlaces(kv(), "food", center.lat, center.lon)
    ).rejects.toThrow(/places/);
    expect(spy).toHaveBeenCalledTimes(2);
    await expect(
      findPlaces(kv(), "nightlife", center.lat, center.lon)
    ).rejects.toThrow(/unavailable/);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("filters by cuisine after caching the full result", async () => {
    mockFetch({
      "overpass-api.de": () => ({
        elements: [
          {
            type: "node",
            id: 1,
            lat: 38.71,
            lon: -9.14,
            tags: {
              name: "Tasca",
              amenity: "restaurant",
              cuisine: "portuguese"
            }
          },
          {
            type: "node",
            id: 2,
            lat: 38.71,
            lon: -9.141,
            tags: {
              name: "Green",
              amenity: "restaurant",
              cuisine: "vegetarian"
            }
          }
        ]
      })
    });
    const veg = await findPlaces(
      kv(),
      "food",
      center.lat,
      center.lon,
      "Vegetarian"
    );
    expect(veg.map((p) => p.name)).toEqual(["Green"]);
    expect(await findPlaces(kv(), "food", center.lat, center.lon)).toHaveLength(
      2
    );
  });
});

describe("travel estimates", () => {
  const baixa = { lat: 38.7107, lon: -9.1365 };

  it("measures distance", () => {
    // Lisbon to Porto is ~274 km in a straight line
    expect(distanceKm(baixa, { lat: 41.1496, lon: -8.611 })).toBeCloseTo(
      274,
      -1
    );
  });

  it("walks short hops", () => {
    const castle = { lat: 38.7139, lon: -9.1335 };
    expect(estimateTravel(baixa, castle)).toMatchObject({ mode: "walk" });
    expect(estimateTravel(baixa, castle).minutes).toBeLessThanOrEqual(10);
  });

  it("uses transit across town and regional transport for day trips", () => {
    const belem = { lat: 38.6916, lon: -9.2157 };
    const sintra = { lat: 38.7979, lon: -9.3881 };
    const toBelem = estimateTravel(baixa, belem);
    expect(toBelem.mode).toBe("transit");
    expect(toBelem.minutes).toBeGreaterThanOrEqual(20);
    expect(toBelem.minutes).toBeLessThanOrEqual(45);

    const toSintra = estimateTravel(baixa, sintra);
    expect(toSintra.mode).toBe("regional");
    expect(toSintra.minutes).toBeGreaterThanOrEqual(45);
    expect(toSintra.minutes).toBeLessThanOrEqual(90);
  });

  it("never estimates zero minutes", () => {
    expect(estimateTravel(baixa, baixa).minutes).toBe(1);
  });
});
