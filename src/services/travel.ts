export type LatLon = { lat: number; lon: number };

export type TravelEstimate = {
  km: number;
  minutes: number;
  mode: "walk" | "transit" | "regional";
};

/** Straight-line distance (haversine). */
export function distanceKm(a: LatLon, b: LatLon): number {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Streets aren't straight: typical ratio of route length to crow-flies distance. */
const DETOUR = 1.3;
const WALK_KMH = 4.5;
const MAX_WALK_KM = 1.5;
/** Average door-to-door speed of city transit or taxi, including stops. */
const CITY_KMH = 18;
const CITY_OVERHEAD_MIN = 10;
/** Beyond this it's a regional train, bus or car trip. */
const REGIONAL_KM = 20;
const REGIONAL_KMH = 50;
const REGIONAL_OVERHEAD_MIN = 20;

/**
 * Rough travel time between two points. Deliberately simple and keyless: good
 * enough to flag gaps that can't work, not to plan exact connections.
 */
export function estimateTravel(a: LatLon, b: LatLon): TravelEstimate {
  const km = distanceKm(a, b) * DETOUR;
  let minutes: number;
  let mode: TravelEstimate["mode"];
  if (km <= MAX_WALK_KM) {
    mode = "walk";
    minutes = (km / WALK_KMH) * 60;
  } else if (km <= REGIONAL_KM) {
    mode = "transit";
    minutes = CITY_OVERHEAD_MIN + (km / CITY_KMH) * 60;
  } else {
    mode = "regional";
    minutes = REGIONAL_OVERHEAD_MIN + (km / REGIONAL_KMH) * 60;
  }
  return {
    km: Math.round(km * 10) / 10,
    minutes: Math.max(1, Math.round(minutes / 5) * 5),
    mode
  };
}
