# AGENTS.md

All coding agents working in this repository must follow this order:

1. Read `SOUL.md`.
2. Read `PRODUCT-PRINCIPLES-CHECKLIST.md`.
3. Then implement changes.

## Non-negotiables

- Privacy first. No new personal data without an entry in the data inventory. Profiles are never public. Nothing personal reaches logs or third parties.
- The principal comes from the session, never from a request body.
- Every list is filtered by visibility on the server.
- Use the shared design tokens. No new hex colors, no third-party fonts.
- Reliable over flashy. Smaller scope with tests beats larger scope without.
- Never commit secrets, `.env` files, `ios/`, `android/`, or infrastructure identifiers. `secretlint` runs on every commit; treat a finding as a stop.

## Before proposing completion

Run `npm run validate` and provide:

- What activist outcome improved.
- What privacy and trust checks were run.
- What metric or feedback signal should be monitored.

If uncertain, choose the smaller scope and ask for review.

## Commit and PR conventions

- Conventional commit subjects (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- Squash merges into `main`. The `validate` check must be green.
- Copy the PR summary block from `PRODUCT-PRINCIPLES-CHECKLIST.md` into every PR.

## This repository

**Purpose.** The Vegan Grove backend: Express 5 + Mongoose 9 in TypeScript (ESM, Node 24), serving `https://api.vegangrove.org/api/*` for the web and mobile clients. Sections 3, 4 and 5 of the scaffold spec (privacy rules, data model, API surface) are the contract this code implements.

**Run.** `npm ci`, copy `.env.example` to `.env` (at least `MONGODB_URI`), then `npm run dev`. `npm run validate` is lint + typecheck + tests + build and must be green before any PR. Tests spin up `mongodb-memory-server`; no external services are needed.

**Layout.** `src/app.ts` builds the app (`buildApp(deps)`) and `src/server.ts` runs it with Socket.IO, the reminder worker and graceful shutdown. `src/config/env.ts` is the only place environment variables are read. `src/models/` holds one schema per collection with its indexes; `src/routes/` one router per resource group, each a `<name>Router(deps)` factory; `src/services/` the logic those routers call; `src/middleware/` auth (`requireAuth`, `requireAdmin`), `validate`, rate limits and the error handler. `src/services/companion/prompt.ts` is Ivy's prompt; `src/services/companion/index.ts` is the only file that talks to Anthropic.

**Rules specific to this repo.**
- The principal is `req.auth.user`, loaded from the database by `requireAuth` on every request. Never read a user id, email, or role from a body, a query, or a token.
- Every route validates with zod through `validate()` and reads the result from `getValidated(req)`. Express 5 makes `req.query` read-only, so do not write to it.
- Throw `AppError(status, code, message)`; the error handler renders `{ error: { code, message } }`. Do not call `res.status(...).json({ error: '...' })` by hand.
- Lists are `{ items, nextCursor }` over `_id` via `src/lib/cursor.ts`. No page or skip parameters.
- Logging goes through `req.log` / `deps.logger`. The request serializer strips the query string on purpose (bounding boxes are locations). Never log a body, a token, or an email.
- Milestone-2 routes are stubs that validate and answer 501 with a `// TODO(m2)` comment. Implement the stub in place; do not add a parallel route.
- New collections go in `src/models/`, get added to `allModels`, and need a data-inventory entry in the docs repo before they ship.

**Do not touch.** `.env` (never committed), `LICENSE`, `SOUL.md`, `PRODUCT-PRINCIPLES-CHECKLIST.md`, and the shared `biome.json` (its schema is pinned to the installed Biome version). Do not change the Anthropic model id to a literal; it is `COMPANION_MODEL` in env. Do not run `scripts/seed-places-osm.ts` against production without `--dry-run` first.
