import type { WeatherSummary } from "../shared/schema";
import { cached, fetchJson } from "./http";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
/** Open-Meteo forecasts up to 16 days ahead, counting today. */
export const FORECAST_DAYS = 16;
const DAY_MS = 86_400_000;

type Daily = {
  time: string[];
  weather_code: (number | null)[];
  temperature_2m_max: (number | null)[];
  temperature_2m_min: (number | null)[];
  precipitation_probability_max?: (number | null)[];
  precipitation_sum?: (number | null)[];
};

/**
 * Weather per trip date. Dates within the forecast window get a real
 * forecast; later dates get the weather on the same dates last year, marked
 * as "climate" so the UI can call it typical rather than a forecast.
 */
export async function getWeather(
  kv: KVNamespace,
  lat: number,
  lon: number,
  dates: string[],
  today: string
): Promise<Record<string, WeatherSummary>> {
  const lastForecastDate = addDays(today, FORECAST_DAYS - 1);
  const forecastDates = dates.filter(
    (d) => d >= today && d <= lastForecastDate
  );
  const climateDates = dates.filter((d) => d > lastForecastDate);
  const out: Record<string, WeatherSummary> = {};

  if (forecastDates.length) {
    const daily = await fetchDaily(kv, FORECAST_URL, lat, lon, forecastDates, [
      "precipitation_probability_max"
    ]);
    daily.time.forEach((date, i) => {
      out[date] = summarise(daily, i, "forecast");
    });
  }

  if (climateDates.length) {
    const lastYear = climateDates.map((d) => shiftYear(d, -1));
    const daily = await fetchDaily(kv, ARCHIVE_URL, lat, lon, lastYear, [
      "precipitation_sum"
    ]);
    const byDate = new Map(daily.time.map((t, i) => [t, i]));
    climateDates.forEach((date, k) => {
      const i = byDate.get(lastYear[k]);
      if (i !== undefined) out[date] = summarise(daily, i, "climate");
    });
  }
  return out;
}

async function fetchDaily(
  kv: KVNamespace,
  base: string,
  lat: number,
  lon: number,
  dates: string[],
  extra: string[]
): Promise<Daily> {
  const sorted = [...dates].sort();
  const start = sorted[0];
  const end = sorted[sorted.length - 1];
  const isForecast = base === FORECAST_URL;
  const key = `wx:v1:${isForecast ? "f" : "a"}:${lat.toFixed(2)},${lon.toFixed(2)}:${start}:${end}`;
  // Forecasts change; past weather doesn't
  const ttl = isForecast ? 3 * 3600 : 30 * 24 * 3600;

  return cached(kv, key, ttl, async () => {
    const url = new URL(base);
    url.searchParams.set("latitude", lat.toFixed(4));
    url.searchParams.set("longitude", lon.toFixed(4));
    url.searchParams.set("start_date", start);
    url.searchParams.set("end_date", end);
    url.searchParams.set("timezone", "auto");
    url.searchParams.set(
      "daily",
      [
        "weather_code",
        "temperature_2m_max",
        "temperature_2m_min",
        ...extra
      ].join(",")
    );
    const data = await fetchJson<{ daily: Daily }>("weather", url);
    return data.daily;
  });
}

function summarise(
  d: Daily,
  i: number,
  basis: WeatherSummary["basis"]
): WeatherSummary {
  const code = d.weather_code[i];
  const summary: WeatherSummary = {
    summary: code === null ? "Unknown" : describeWeatherCode(code),
    basis
  };
  const max = d.temperature_2m_max[i];
  const min = d.temperature_2m_min[i];
  if (max !== null && max !== undefined) summary.tempMaxC = Math.round(max);
  if (min !== null && min !== undefined) summary.tempMinC = Math.round(min);
  const chance = d.precipitation_probability_max?.[i];
  if (chance !== null && chance !== undefined) {
    summary.precipitationChance = chance;
  }
  return summary;
}

/** WMO weather interpretation codes, as used by Open-Meteo. */
export function describeWeatherCode(code: number): string {
  if (code === 0) return "Clear sky";
  if (code <= 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return code >= 65 ? "Heavy rain" : "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Rain showers";
  if (code === 85 || code === 86) return "Snow showers";
  if (code >= 95) return "Thunderstorms";
  return "Mixed";
}

/** Rainy, snowy or stormy, i.e. a bad day for outdoor plans. */
export function isWetWeather(w: WeatherSummary): boolean {
  if (w.precipitationChance !== undefined && w.precipitationChance >= 60) {
    return true;
  }
  return /rain|drizzle|snow|thunder/i.test(w.summary);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Same calendar date in another year; Feb 29 becomes Feb 28. */
export function shiftYear(date: string, years: number): string {
  const [y, m, d] = date.split("-");
  const day = m === "02" && d === "29" ? "28" : d;
  return `${Number(y) + years}-${m}-${day}`;
}
