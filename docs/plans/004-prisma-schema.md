# 004 — Prisma schema & migrations

## Manual setup required BEFORE starting
- None. (Local dev DB runs in Docker via the compose file this feature
  adds — Docker Desktop must be installed.)

## Objective
Define the `videos` and `video_jobs` schema in Prisma, with a working
local-dev database loop and a migration path that will run at deploy time.

## Context
ARCHITECTURE §2.3 + D6 (Prisma). The API (features 008/010) will import
the client wrapper written here. `deriveVideoState()` encodes the state
machine and is pure — test it hard here so 010 is mechanical.

## Requirements
1. `apps/web/prisma/schema.prisma` mirroring ARCHITECTURE §2.3 exactly:
   - `Video`: id (Uuid, PK), ownerSub, originalFilename, uploadKey
     (unique), state (enum VideoState), hlsMasterKey?, thumbnailKey?,
     error?, createdAt, updatedAt. Index on `(ownerSub, createdAt desc)`.
   - `VideoJob`: composite PK `(videoId, kind)`, kind enum
     (TRANSCODE/THUMBNAIL), state enum (PENDING/RUNNING/DONE/FAILED),
     attempts (default 0), error?, startedAt?, finishedAt?; FK to Video
     `onDelete: Cascade`.
   - Prisma enums named to match shared types from `packages/shared`;
     re-export shared types as the app-level vocabulary (single source).
2. `docker-compose.yml` at repo root: `postgres:16` service, port 5432,
   db/user/password `clipper` (dev-only, committed deliberately — document
   that this is local-only), volume for data.
3. `apps/web/lib/db.ts`: PrismaClient singleton (hot-reload-safe pattern).
   Reads `DATABASE_URL` via `packages/config` web schema — extend that
   schema with `DATABASE_URL`.
4. Scripts: `pnpm db:up` (compose up), `pnpm db:migrate` (prisma migrate
   dev), `pnpm db:deploy` (prisma migrate deploy — used by CI/CD later),
   `pnpm db:reset`.
5. `apps/web/lib/video-state.ts`: pure function
   `deriveVideoState(current: VideoState, jobs: {kind, state}[]): VideoState`
   implementing: any FAILED → FAILED; else if both kinds DONE → READY;
   else any RUNNING or any DONE (partial) → PROCESSING; else keep current
   (UPLOADING/QUEUED until jobs start).
6. Migration runbook section in README or `docs/runbooks/db-migrations.md`:
   local loop; how `migrate deploy` runs at release time (one-off ECS task
   — wired in 006/007, documented here).

## Files/components likely affected
- New: `apps/web/prisma/schema.prisma`,
  `apps/web/prisma/migrations/**`, `apps/web/lib/db.ts`,
  `apps/web/lib/video-state.ts`, `docker-compose.yml`,
  `docs/runbooks/db-migrations.md`; edits: `packages/config` env schema,
  `apps/web/package.json`, root `package.json` scripts.

## API changes
None yet (client/lib only).

## Database changes
Creates both tables + enums via the initial migration.

## Dependencies
- 001 (repo, shared types, config package). 003 only for the real
  environment — develop entirely against the compose DB.

## Edge cases
- `deriveVideoState` with jobs list missing a kind (e.g. only TRANSCODE
  row exists yet): treat missing as PENDING — must not jump to READY.
- Partial DONE + other RUNNING → PROCESSING (not READY).
- Partial DONE + other PENDING → still QUEUED? No: any job started
  (RUNNING/DONE/FAILED) means the pipeline is active → PROCESSING when no
  FAILED and not all DONE. Encode exactly this and test the full truth
  table.
- Enum drift: shared package string unions and Prisma enums must match —
  add a compile-time assertion type in shared.

## Security considerations
- Committed compose credentials are local-only; call this out loudly in
  compose file comments. Real credentials come from Secrets Manager (003).
- No `.env` committed; provide `.env.example` with `DATABASE_URL`
  pointing at localhost compose DB.

## Tests
- vitest truth-table tests for `deriveVideoState` covering every
  combination of 2 jobs × 4 states + missing rows.
- Migration smoke test: `db:up` → `db:migrate` → insert a Video +
  VideoJob via Prisma client in a test script → read back → `db:reset`.

## Acceptance criteria
1. Clean migrate against empty compose Postgres.
2. Truth-table tests green (all combinations enumerated).
3. Smoke script round-trips a record.
4. Runbook exists and matches the scripts' real names.

## Out of scope
- RDS deployment (003), running migrations in AWS (006/007), any API
  route, seed data beyond the smoke test.
