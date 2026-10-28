import {
  datesBetween,
  type Destination,
  type Trip,
  type WeatherSummary
} from "../shared/schema";
import { geocode } from "../services/geocode";
import { getWeather } from "../services/weather";

export type Enrichment = {
  /** Set when the destination was geocoded in this run. */
  destination?: Destination;
  /** Weather by date, for dates that have data. */
  weather: Record<string, WeatherSummary>;
  /** Problems worth showing the user (e.g. destination not found). */
  warnings: string[];
};

/**
 * Fill in data the trip needs from outside services: destination coordinates
 * and timezone, then weather for each day. Pure with respect to the trip; the
 * agent merges the result into whatever the trip looks like by then.
 */
export async function enrichTrip(
  trip: Trip,
  kv: KVNamespace,
  today: string
): Promise<Enrichment> {
  const result: Enrichment = { weather: {}, warnings: [] };
  let { lat, lon } = trip.details.destination;

  if (lat === undefined || lon === undefined) {
    const place = await geocode(kv, trip.details.destination.name);
    if (!place) {
      result.warnings.push(
        `Couldn't find "${trip.details.destination.name}" on the map, so weather and place search are unavailable. Try a more specific destination name.`
      );
      return result;
    }
    result.destination = {
      name: trip.details.destination.name,
      country: place.country,
      lat: place.lat,
      lon: place.lon,
      timezone: place.timezone
    };
    ({ lat, lon } = place);
  }

  try {
    const dates = datesBetween(trip.details.startDate, trip.details.endDate);
    result.weather = await getWeather(kv, lat, lon, dates, today);
  } catch (err) {
    console.error("weather lookup failed", err);
    result.warnings.push("Weather is temporarily unavailable.");
  }
  return result;
}

/**
 * Apply an enrichment to the latest trip. Only fills a destination whose name
 * still matches (the user may have changed it meanwhile) and only updates
 * weather on days that still exist.
 */
export function applyEnrichment(trip: Trip, e: Enrichment): Trip {
  const next = structuredClone(trip);
  if (
    e.destination &&
    e.destination.name === next.details.destination.name &&
    next.details.destination.lat === undefined
  ) {
    next.details.destination = e.destination;
  }
  for (const day of next.days) {
    const w = e.weather[day.date];
    if (w) day.weather = w;
  }
  return next;
}

/** Destination or dates changed, so coordinates or weather may be stale. */
export function needsEnrichment(before: Trip | null, after: Trip): boolean {
  const d = after.details;
  if (d.destination.lat === undefined) return true;
  if (!before) return true;
  return (
    before.details.destination.name !== d.destination.name ||
    before.details.startDate !== d.startDate ||
    before.details.endDate !== d.endDate
  );
}
