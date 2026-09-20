# 010 — Internal status API & state derivation

## Manual setup required BEFORE starting
- None. (Creates one secret — `clipper/worker-api-token` — via the
  existing `scripts/create-secrets.sh` pattern; agent runs it with your
  credentials, value never printed.)

## Objective
The single writer to the job tables: an internal endpoint workers call
with results, plus the user-facing read endpoints the UI polls. After this
feature, 009's harness has a real counterpart.

## Context
ARCHITECTURE §3, §5, D3. Internal endpoint is protected in two layers:

1. **ALB:** the public listener (:80) gets a high-priority rule returning
   fixed **404** for path `/api/internal/*` (404, not 403 — don't confirm
   the path exists). A separate listener rule on the **test listener
   (:8080)** — whose security group allows the VPC CIDR only — forwards
   `/api/internal/*` to the app. Workers call `http://<alb-dns>:8080`.
2. **App:** bearer token from Secrets Manager, timing-safe comparison.
   The app check is the real boundary; the ALB rules are noise reduction
   and defense in depth.

Note: 006 created the test listener SG open enough for CodeDeploy
validation — this feature tightens it to VPC CIDR.

## Requirements
1. `POST /api/internal/videos/:id/status`:
   - Auth: `Authorization: Bearer <token>` compared (timing-safe) against
     `WORKER_API_TOKEN` from Secrets Manager; 403 otherwise. Middleware
     skip-list already covers auth for `/api/internal/*` (005) — verify.
   - Body: `JobStatusReport` zod schema from shared (009): `{ kind,
     state: RUNNING|DONE|FAILED, outputs?: { hlsMasterKey?, thumbnailKey? },
     error? }`.
   - Handler (transaction): find video (404 if unknown id — workers can
     only know real ids from keys); upsert `VideoJob` (increment
     `attempts` when state → RUNNING); on DONE merge provided output keys
     onto `Video`; derive new `videos.state` via `deriveVideoState` (004)
     and persist if changed; set `error` on FAILED.
   - Idempotent: DONE reported twice → same final state, 200 both times.
2. `GET /api/videos` (requireUser): caller's videos, newest first,
   derived per-job summary included. Pagination: naive `limit=50` cursor
   by createdAt — keep simple.
3. `GET /api/videos/:id/status` (requireUser, owner-scoped): full record
   + jobs array; 404 (not 403) for other users' ids — don't leak
   existence.
4. ALB rules (ComputeStack): public :80 listener — high-priority fixed
   **404** for `/api/internal/*`. Test listener :8080 — SG tightened to
   VPC CIDR; rule forwarding `/api/internal/*` to the app. Worker
   `API_BASE_URL` = `http://<alb-dns>:8080`.
5. Secret `clipper/worker-api-token` created (script), injected into both
   web and worker task definitions (worker side lands in 011/012's
   WorkerStack; add to web now).

## Files/components likely affected
- New: `apps/web/app/api/internal/videos/[id]/status/route.ts`,
  `apps/web/app/api/videos/route.ts` (GET — extends 008's file),
  `apps/web/app/api/videos/[id]/status/route.ts`,
  `apps/web/lib/worker-auth.ts`; edits: `infra/lib/compute-stack.ts`
  (listener rules, secret injection), `scripts/create-secrets.sh`,
  `packages/shared` (nothing — schema exists from 009).

## API changes
- Adds all three endpoints above.

## Database changes
None.

## Dependencies
- 007 (pipeline), consumes 004's derivation + 009's contract.

## Edge cases
- Status report for a video whose upload was never confirmed (still
  UPLOADING): accept — S3 event implies the object exists; transition
  normally. Log a warning (indicates client skipped `/uploaded`).
- Report referencing unknown videoId → 404 + log; worker treats 4xx as
  terminal-report (009) — ensures contract bugs are loud, not retried
  forever.
- DONE with missing/mismatched output keys (wrong prefix for the video)
  → 422; validate keys against shared helpers.
- Duplicate RUNNING reports increment attempts — fine; attempts is
  informational.

## Security considerations
- Timing-safe token comparison (`crypto.timingSafeEqual`).
- Owner-scoping tests must prove cross-user reads return 404.
- Internal token never logged; redact in error paths.
- ALB rule changes asserted in CDK tests (ordering matters: deny rule
  priority lower number than catch-all forward).

## Tests
- Unit/integration against compose DB: token required (403), full
  transition sequences (RUNNING→DONE ×2 → READY; FAILED → FAILED),
  idempotent re-report, 404/422 paths, ownership scoping on both GETs.
- CDK assertions for listener rules + secret wiring.

## Acceptance criteria
1. Simulated worker (curl with token via :8080 from inside VPC — or
   temporarily from a bastion/ECS Exec session) drives a record from
   QUEUED → READY.
2. Same call from the internet on :80 → 403.
3. `GET /api/videos` shows only the caller's videos.
4. Double-report DONE → still READY, attempts sane.

## Out of scope
- The workers' Fargate services (011/012), UI (013), rate limiting.
