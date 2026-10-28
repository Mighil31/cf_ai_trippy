import { routeAgentRequest } from "agents";

export { TripAgent } from "./agents/trip-agent";
export { UserDirectory } from "./agents/user-directory";
export { PlanTripWorkflow } from "./workflows/plan-trip";
export { ValidateTripWorkflow } from "./workflows/validate-trip";

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "trippy" });
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
