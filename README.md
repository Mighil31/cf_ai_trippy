# cf_ai_trippy

**Trippy** is an AI agent that builds a personalised trip itinerary and revises it as plans change. Describe a destination, dates, budget and interests; Trippy assembles a day-by-day plan, tracks your constraints, flags conflicts, and updates the plan whenever you ask, either in chat or by editing it directly.

Built entirely on the Cloudflare free tier for the Cloudflare AI assignment.

> 🚧 Work in progress. See [`PROMPTS.md`](PROMPTS.md) for the AI prompts used to build it.

## How it meets the assignment

| Requirement | Implementation |
|---|---|
| LLM | Llama 3.3 70B on Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) |
| Workflow / coordination | Cloudflare Workflows (plan generation, validation, cost estimation) and Durable Objects |
| User input | Chat (WebSocket, streaming) plus direct itinerary editing in a React UI |
| Memory / state | One Durable Object (SQLite-backed) per trip: preferences, itinerary, chat history, undo snapshots |

## Stack

- **Worker**: API, static assets, agent routing (`src/server.ts`)
- **Agents SDK**: `TripAgent` (per trip) and `UserDirectory` (per anonymous user), both Durable Objects (`src/agents/`)
- **React + Vite + Tailwind**: SPA (`src/client/`)
- **Vitest** with `@cloudflare/vitest-plugin`: tests run inside the Workers runtime (`test/`)

## Running locally

Requirements: Node 22+, a Cloudflare account (free). Workers AI always runs remotely, even in local dev, so you need to log in.

```sh
npm install
npx wrangler login
npm run dev          # http://localhost:5173
```

Other scripts:

```sh
npm test             # unit + integration tests
npm run check        # format check, lint, typecheck
npm run deploy       # build and deploy to *.workers.dev
```

## Deployed

https://cf-ai-trippy.perfunctory.workers.dev
