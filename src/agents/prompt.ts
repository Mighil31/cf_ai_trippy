import { estimatedTotal } from "../shared/budget";
import type { Item, Trip, WeatherSummary } from "../shared/schema";

/**
 * Compact plain-text rendering of a trip for the model. Cheaper in tokens than
 * JSON and easier for the model to quote ids back from.
 */
export function renderTrip(trip: Trip): string {
  const d = trip.details;
  const { currency } = d.budget;
  const lines = [
    `Title: ${d.title}`,
    `Destination: ${d.destination.name}${d.destination.country ? `, ${d.destination.country}` : ""}`,
    `Dates: ${d.startDate} to ${d.endDate} (${trip.days.length} days)`,
    `Travellers: ${d.travellers}`,
    `Budget: ${d.budget.amount} ${currency} total for the group`,
    `Pace: ${d.pace}`,
    `Interests: ${d.interests.join(", ") || "none given"}`
  ];
  if (d.notes) lines.push(`Notes: ${d.notes}`);

  lines.push("", "Constraints:");
  if (trip.constraints.length === 0) lines.push("  (none)");
  for (const c of trip.constraints) {
    lines.push(`  [${c.id}] ${c.kind}: ${c.text}`);
  }

  lines.push(
    "",
    "Lodging:",
    trip.lodging
      ? `  ${trip.lodging.area}${
          trip.lodging.nightlyPrice
            ? ` (${trip.lodging.nightlyPrice.min}-${trip.lodging.nightlyPrice.max} ${currency}/night, estimated)`
            : ""
        }`
      : "  (not set)"
  );

  lines.push("", "Itinerary:");
  trip.days.forEach((day, i) => {
    const extras = [
      day.theme && `theme: ${day.theme}`,
      day.dayTrip && `day trip to ${day.dayTrip.destination}`,
      day.weather && `weather: ${renderWeather(day.weather)}`
    ].filter(Boolean);
    lines.push(
      `Day ${i + 1} ${day.date}${extras.length ? ` (${extras.join("; ")})` : ""}`
    );
    if (day.items.length === 0) lines.push("  (empty)");
    for (const item of day.items) lines.push(`  ${renderItem(item, currency)}`);
  });

  const spent = estimatedTotal(trip);
  lines.push(
    "",
    `Estimated cost so far: ${spent} ${currency} of ${d.budget.amount} ${currency}`
  );
  return lines.join("\n");
}

function renderWeather(w: WeatherSummary): string {
  const temps =
    w.tempMinC !== undefined && w.tempMaxC !== undefined
      ? ` ${w.tempMinC}-${w.tempMaxC}°C`
      : "";
  const rain =
    w.precipitationChance !== undefined
      ? `, ${w.precipitationChance}% rain`
      : "";
  const basis = w.basis === "climate" ? " (typical, not a forecast)" : "";
  return `${w.summary}${temps}${rain}${basis}`;
}

function renderItem(item: Item, currency: string): string {
  const time =
    item.startTime && item.endTime
      ? `${item.startTime}-${item.endTime}`
      : (item.startTime ?? "untimed");
  const parts = [`[${item.id}] ${time} ${item.kind}: ${item.title}`];
  if (item.place) parts.push(`@ ${item.place.name}`);
  if (item.cost) {
    parts.push(
      `(${item.cost.amount} ${currency}${item.cost.estimated ? " est." : ""})`
    );
  }
  if (item.locked) parts.push("[LOCKED]");
  return parts.join(" ");
}

export function systemPrompt(trip: Trip, today: string): string {
  return `You are Trippy, a friendly, practical travel-planning assistant. You help the user build and refine a day-by-day itinerary for one trip.

Today is ${today}.

# How you work
- The trip below is the single source of truth. It is refreshed every turn.
- Change the trip ONLY by calling tools. Never claim a change you did not make with a tool.
- Make every change the user asked for, then reply with a short summary of what changed.
- Ids are the 6 characters inside [brackets], e.g. for "[a1b2c3] 10:00 activity: Castle" the itemId is a1b2c3 (no brackets). Never invent ids.
- To change an existing item, use update_item or move_item with its id. Don't remove and re-add it.
- If a tool returns ok: false, read the error, fix the input and retry once, or explain the problem to the user.
- Items marked [LOCKED] were pinned by the user: do not change, move or remove them. Tell the user to unlock them if needed.
- When the user states a lasting preference or rule ("no museums", "we're vegetarian", "must see the Eiffel Tower"), save it with add_constraint as well as acting on it.
- If a request is ambiguous and the choice matters, ask one short question instead of guessing.

# Planning rules
- Times are local, 24h HH:MM. Leave realistic gaps for travel between places.
- Respect the pace: relaxed ≈ 2-3 activities/day, moderate ≈ 3-4, packed ≈ 5+. Meals are extra.
- A day trip is a whole day spent at a nearby destination; set it with set_day_info. Search places there with search_places area=<town>.
- Check each day's weather: put outdoor plans on dry days and indoor ones (museums, markets) on wet days.
- Costs are estimates for the whole group in the trip currency (${trip.details.budget.currency}). Say they are estimates. Never present them as real prices or bookings.
- Before adding sights, restaurants or other specific places, call search_places and pick from its results. Copy the place's name into placeName and its lat/lon into placeLat/placeLon. Search once per category per turn, not once per item.
- Use specific, real, well-known places with their actual names in title and placeName (e.g. "Castelo de São Jorge", not "castle"). If unsure a place exists, say so instead of inventing one.
- Estimate realistic costs for the whole group, including entry tickets, meals and local transport. Free places cost 0.
- Keep replies concise and use plain language. Don't repeat the whole itinerary back unless asked.

# Current trip
${renderTrip(trip)}`;
}
