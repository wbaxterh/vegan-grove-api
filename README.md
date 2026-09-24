# vegan-grove-api

The backend for Vegan Grove, a privacy-first vegan community and activism platform for Southern California. Every member is an activist; the API helps them find sanctuaries, vegan businesses, events, and each other, and gives away as little about them as possible while doing it.

Read `SOUL.md` and `PRODUCT-PRINCIPLES-CHECKLIST.md` before changing anything. The privacy rules there are binding on every route.

## Stack

TypeScript (ESM, Node 24), Express 5, Mongoose 9, zod at every route boundary, pino with redaction, helmet, express-rate-limit, Socket.IO (`/messages`), argon2id passwords, opaque hashed session tokens, `@anthropic-ai/sdk` for the companion (Ivy), presigned S3 uploads, nodemailer over SES SMTP.

## Run

```
nvm use            # Node 24, from .nvmrc
npm ci
cp .env.example .env   # fill in MONGODB_URI at minimum
npm run dev        # tsx watch, http://localhost:4000
```

`GET /healthz` answers `{ ok: true }` once the database responds. Every API route lives under `/api`.

## Environment

Every variable the process reads is listed in `.env.example` with a one-line comment, and validated at boot by `src/config/env.ts`. A bad or missing value fails the start with a list of problems instead of a runtime surprise. Production additionally requires `EMAIL_TRANSPORT=smtp`, `CORS_ORIGINS`, and `DM_ENCRYPTION_KEY`.

## Validate

```
npm run validate   # biome check, tsc --noEmit, vitest run, tsc build
```

This is the same check CI runs and the gate for every pull request. Tests use `mongodb-memory-server`, which downloads a MongoDB binary the first time (set `MONGOMS_VERSION` if the default has no build for your platform). `secretlint` runs on every commit through husky and lint-staged; a finding is a stop.

## Layout

```
src/
  app.ts            buildApp(deps): middleware, routes, 404, error handler; no listen
  server.ts         http server, Socket.IO, workers, graceful shutdown
  config/env.ts     zod-validated environment
  db/mongoose.ts    connect, pingDb, disconnect
  models/           one Mongoose schema per collection, indexes declared inline
  routes/           one router per resource group, each `<name>Router(deps)`
  services/         auth, sessions, magic links, email, places, stats, uploads, companion, DM crypto
  middleware/       requireAuth, requireAdmin, validate, rate limits, error handler
  socket/           /messages namespace (session token in handshake.auth.token)
  workers/          reminder sender (start/stop wired into shutdown)
  lib/              logger, AppError, cursor pagination, slugs, SSE
scripts/
  seed-places-osm.ts   Overpass importer for diet:vegan places in SoCal (--dry-run supported)
test/               vitest + supertest against an in-memory MongoDB
```

## API conventions

- Auth: `Authorization: Bearer <session token>`. The token is returned once at sign-in and stored only as a SHA-256 hash.
- Errors: `{ error: { code, message } }` everywhere; validation errors add `details`.
- Lists: `{ items, nextCursor }` with an opaque cursor. There is no page or skip.
- Not yet implemented routes answer `501 not_implemented` after validating their input, so clients can build against the final shapes now.
- The full surface is in the scaffold spec's section 5 and mirrored in the docs site.

## Seeding places

```
npm run seed:places:osm -- --dry-run   # fetch from Overpass and print counts
npm run seed:places:osm                # upsert as pending, by osmId
```

Re-running never resets an approved place to pending.

## Deploy

One small EC2 instance runs the built app under PM2 (`ecosystem.config.cjs`, app name `vegan-grove-api`) behind nginx with a Let's Encrypt certificate, in `us-east-1`. MongoDB Atlas holds the data, S3 holds media, SES sends magic links. Deploy is `npm ci && npm run build && pm2 reload ecosystem.config.cjs`. Hostnames, addresses and access details are intentionally not in this repository or the public docs.

## Related repos

- `vegan-grove-web`: Next.js site and authenticated web app
- `vegan-grove-mobile`: Expo app for iOS and Android
- `vegan-grove-docs`: public docs, ADRs, privacy data inventory

## License

Proprietary. See `LICENSE`: read and audit freely, redistribution is not permitted.
