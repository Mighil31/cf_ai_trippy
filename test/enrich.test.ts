import { getAgentByName } from "agents";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createTripTools } from "../src/agents/tools";
import { details } from "./fixtures";
import { lisbonGeocoding, mockFetch, weatherRoutes } from "./mock-fetch";

const sintraGeocoding = {
  results: [
    {
      name: "Sintra",
      latitude: 38.8029,
      longitude: -9.3817,
      country: "Portugal",
      country_code: "PT",
      timezone: "Europe/Lisbon",
      population: 30000
    }
  ]
};

function mockServices() {
  return mockFetch({
    "geocoding-api.open-meteo.com": (url) =>
      url.searchParams.get("name") === "Sintra"
        ? sintraGeocoding
        : url.searchParams.get("name") === "Lisbon"
          ? lisbonGeocoding
          : {},
    ...weatherRoutes,
    "en.wikipedia.org": () => ({
      query: {
        pages: [
          {
            title: "Pena Palace",
            description: "Palace in Sintra, Portugal",
            coordinates: [{ lat: 38.7876, lon: -9.3906 }]
          }
        ]
      }
    })
  });
}

async function newTrip(overrides = {}) {
  const directory = await getAgentByName(
    env.UserDirectory,
    crypto.randomUUID()
  );
  const { id } = await directory.createTrip(details(overrides));
  const stub = await getAgentByName(env.TripAgent, id);
  // Creation starts a refresh in the background; joining it waits for it
  await stub.refreshExternalData();
  return stub;
}

describe("external data", () => {
  it("geocodes the destination and adds weather after creation", async () => {
    mockServices();
    // Far-future dates exercise the "last year's weather" path deterministically
    const stub = await newTrip({
      startDate: "2027-06-01",
      endDate: "2027-06-02"
    });
    const trip = (await stub.getTrip())!;
    expect(trip.details.destination).toMatchObject({
      name: "Lisbon",
      country: "Portugal",
      lat: 38.72509,
      timezone: "Europe/Lisbon"
    });
    expect(trip.days.map((d) => d.weather?.basis)).toEqual([
      "climate",
      "climate"
    ]);

    const state = await runInDurableObject(stub, (a) => a.state);
    expect(state.enrichedAt).not.toBeNull();
    expect(state.warnings).toEqual([]);
    // Outside data is not an undoable edit
    expect(state.canUndo).toBe(false);
  });

  it("warns when the destination can't be found", async () => {
    mockServices();
    const stub = await newTrip({ destination: { name: "Atlantis" } });
    const state = await runInDurableObject(stub, (a) => a.state);
    expect(state.warnings[0]).toMatch(/Couldn't find "Atlantis"/);
    expect(state.trip?.details.destination.lat).toBeUndefined();
  });

  it("keeps the trip usable when outside services are down", async () => {
    const stub = await newTrip();
    const trip = (await stub.getTrip())!;
    expect(trip.details.destination.lat).toBeUndefined();
    expect(trip.days.every((d) => !d.weather)).toBe(true);
  });

  it("re-geocodes when the destination changes", async () => {
    mockServices();
    const stub = await newTrip();
    await stub.updateDetails({ destination: { name: "Sintra" } });
    await stub.refreshExternalData();
    expect((await stub.getTrip())?.details.destination).toMatchObject({
      name: "Sintra",
      lat: 38.8029
    });
  });

  it("search_places returns compact rows near a day-trip town", async () => {
    mockServices();
    const stub = await newTrip();
    const result = await runInDurableObject(stub, async (agent) =>
      createTripTools(agent).search_places.execute!(
        { category: "sights", area: "Sintra" },
        { toolCallId: "t", messages: [] }
      )
    );
    expect(result).toMatchObject({
      ok: true,
      near: "Sintra",
      places: [{ name: "Pena Palace", notable: true, lat: 38.7876 }]
    });
  });

  it("search_places tells the model not to retry when a service is down", async () => {
    mockServices();
    const stub = await newTrip();
    const result = await runInDurableObject(stub, async (agent) =>
      createTripTools(agent).search_places.execute!(
        { category: "food" },
        { toolCallId: "t", messages: [] }
      )
    );
    expect(result).toMatchObject({
      ok: false,
      error: /HTTP 503.*do not call search_places again/
    });
  });

  it("search_places reports when the area can't be located", async () => {
    mockServices();
    const stub = await newTrip();
    const result = await runInDurableObject(stub, async (agent) =>
      createTripTools(agent).search_places.execute!(
        { category: "food", area: "Nowhere" },
        { toolCallId: "t", messages: [] }
      )
    );
    expect(result).toEqual({
      ok: false,
      error: "Couldn't locate Nowhere on the map"
    });
  });
});
