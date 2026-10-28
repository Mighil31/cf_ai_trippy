# Prompt Log

Every prompt given to the coding agent while building Trippy, in order, verbatim.

---

## 1 — 2026-10-28 — Project kickoff

```
Trippy is the name of the AI agent, built to help create a perfect personalized itinerary for a user's trip.
The user describes a trip, budget, interests, and travel dates. The agent assembles an itinerary, tracks constraints, and revises the plan whenever the user changes something.

The entire application should be built on cloudflare on the free tier

Llama 3.3 on Workers AI - the heart of the application. Interprets user preferences, proposes itinerary, changes, suggestions etc
Cloudflare workers - use available APIs like maps, weather, hotels etc
Durable objects - maintain the itinerary, user preferences, budgets etc
workflows - validate schedule, estimate costs, flag issues and conflicts, generate day by day plan, iterate etc.

Reat UI - allow user to create a trip, chat with AI. View the trip details planned so far, easily suggest modifications, show trip details, day by day itinerary etc. Keep minimum viable features for now, note down future planned features and good to haves

From this prompt onwards, all prompts should be noted down in a file.

Firstly confirm the details of the plans with me, clarify ambiguities, offer suggestions
```

---

## 2 — 2026-10-28 — Answers to clarifying questions; request phased plan

```
1. yes this is the cloudflare assinment
2. ok
3. one destination + day trips
4. fine
5. Map is not required
6. both
7. yes

Create a phased step by step implementation plan
```

---

## 3 — 2026-10-28 — Start Phase 0 (and repo rename)

```
go ahead
```

---

## 4 — 2026-10-28 — Shell command (Cloudflare login)

```
! npx wrangler login
```

---

## 5 — 2026-10-28 — workers.dev subdomain registered

```
perfunctory.workers.dev
```

---

## 6 — 2026-10-28 — Commit Phase 0, start Phase 1, keep plan out of git

```
commit and start phase 1. Add the plan to gitignore
```

---

## 7 — 2026-10-29 — Explain the schema

```
Explain schema.ts
```

---

## 8 — 2026-10-29 — Commit, push, start Phase 2

```
commit, push and continue to the next phase
```
