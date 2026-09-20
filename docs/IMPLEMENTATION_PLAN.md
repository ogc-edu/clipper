# Clipper — Master Implementation Plan

**Version:** 0.2 — CI/CD moved to feature 007 (right after the ECS
skeleton); manual-setup ledger added.
**Status:** Approved
**Depends on:** `docs/PRD.md` (approved), `docs/ARCHITECTURE.md` (approved)

Features are numbered in build order. Dependencies are hard: do not start
a feature before its deps are done. **Every feature plan begins with a
"Manual setup required BEFORE starting" section — read it before handing
the plan to a coding agent.**

---

## Manual setup ledger (things only you can do, by feature)

| Before feature | What you must do manually |
|---|---|
| **002** | AWS account ready; IAM credentials for CDK (CLI configured); choose all resource names in `infra/config.ts`; run `cdk bootstrap` once per account/region |
| **002** (after deploy) | Click the confirmation link in the SNS `ops-alerts` subscription email |
| **005** (after deploy) | Create your own user in the Cognito console; add yourself to the `admin` group |
| **006** | One-time manual `docker build` + `docker push` of the web image to ECR (chicken-and-egg: the service can't start before an image exists; the pipeline takes over from 007 on) |
| **007** | Authorize the AWS CodeConnections GitHub connection in the console (one-time OAuth handshake); trigger the first pipeline run manually. Repo: `github.com/ogc-edu/clipper`, branch `main` |
| **014** | Generate the CloudFront signing key pair locally (script provided) and upload the private key to Secrets Manager |

Everything else — buckets, queues, RDS, ECS services, IAM, alarms — is
created by CDK. If a feature plan assumes a console-created resource that
isn't listed here, that's a plan bug: stop and report it.

---

## Milestone view

| Milestone | Features | Exit criteria |
|---|---|---|
| **M1 — Skeleton & pipeline** | 001–007 | Repo builds; storage/messaging/RDS/Cognito deployed; Next.js app live on ECS; sign-in works; **push-to-deploy CI/CD live (web blue/green)** |
| **M2 — Upload & pipeline** | 008–012 | Direct-to-S3 upload; worker base + status API; thumbnail and HLS transcode services processing for real |
| **M3 — User experience** | 013–015 | Status bar live; CloudFront signed-cookie playback; admin dashboard |
| **M4 — Proof** | 016 | PRD §9 acceptance checklist verified end-to-end |

---

## Feature index

### 001 — Repository & workspace scaffold
- **Goal:** Buildable pnpm monorepo matching the agreed layout.
- **Scope:** workspaces, TS base configs, ESLint/Prettier, vitest;
  `packages/shared` (types + `uploadKey()/parseUploadKey()` key-convention
  helpers); `packages/config` (zod env schemas); minimal `apps/web`
  (create-next-app) and `apps/worker` (plain TS package); README.
- **Deps:** none
- **Acceptance:** `pnpm install && pnpm build && pnpm test` green;
  key helpers unit-tested.

### 002 — Infra: network, storage & messaging (CDK)
- **Goal:** The event pipeline exists in AWS with user-chosen names.
- **Scope:** CDK app + `infra/config.ts`; VPC + app security group;
  uploads bucket (CORS, 7-day lifecycle) + output bucket (fully private);
  SNS `video-uploaded`; SQS transcode (15min visibility) + thumbnail
  (2min) queues + DLQs (redrive 3); S3→SNS→SQS wiring (raw message
  delivery) incl. all resource policies; SNS `ops-alerts` + email
  subscription; DLQ alarms → `ops-alerts`.
- **Deps:** 001 — **Manual:** see ledger
- **Acceptance:** dropping a file under `uploads/` delivers the raw S3
  event to both queues; buckets deny public access; force-redrive a
  message → DLQ alarm fires → email arrives.

### 003 — Infra: database
- **Goal:** Private RDS PostgreSQL, credentials in Secrets Manager.
- **Scope:** PostgreSQL (single-AZ, smallest class), auto-generated secret,
  SG ingress only from the app SG (from 002), CDK outputs.
- **Deps:** 002
- **Acceptance:** connectable from inside the VPC only; secret present.

### 004 — Prisma schema & migrations
- **Goal:** `videos` + `video_jobs` per ARCHITECTURE §2.3.
- **Scope:** `apps/web/prisma/schema.prisma`; initial migration;
  `lib/db.ts` client singleton; docker-compose Postgres for local dev;
  `deriveVideoState()` helper + tests; migration runbook
  (`prisma migrate deploy` in deploy flow).
- **Deps:** 001 (003 for the real environment)
- **Acceptance:** clean migrate on empty DB; derivation unit-tested.

### 005 — Auth (Cognito + Next.js)
- **Goal:** Hosted-UI sign-in, JWT middleware, admin group.
- **Scope:** `AuthStack` (user pool, domain, app client, `admin` group);
  `/api/auth/login|callback|logout`; HttpOnly session cookie; JWT verify
  via JWKS (`jose`); middleware on `/api/*`; `requireUser`/`requireAdmin`.
- **Deps:** 001, 002 — **Manual:** create your user + group after deploy
- **Acceptance:** 401 unauthenticated; sign-in round trip; non-admin
  rejected from admin route; forged token rejected.

### 006 — Web service on ECS (walking skeleton)
- **Goal:** App serving on Fargate behind an ALB.
- **Scope:** standalone Dockerfile; ECR repos (web + worker);
  `ComputeStack`: cluster, ALB, Fargate service (desired 2), task role
  (secrets read only — S3 perms arrive in 008), env/secrets wiring,
  `/api/health`; DB migration run as one-off task (documented command).
- **Deps:** 003, 004, 005 — **Manual:** one-time image build+push first
- **Acceptance:** ALB URL serves app; sign-in works through ALB; health
  green; rolling update keeps service up.

### 007 — CI/CD (CodeBuild + CodeDeploy)
- **Goal:** Push to `main` → tested → built → deployed.
- **Scope:** `CiStack`: CodeConnections GitHub source; CodeBuild project
  (install, lint, typecheck, test, docker build+push **both** images,
  `cdk deploy` infra); CodeDeploy blue/green for web (prod+test ALB
  listeners, 5-min bake, auto-rollback on alarm); workers deploy via
  rolling `force-new-deployment` (no-op until 011/012 create services);
  migration step runs `prisma migrate deploy` before web deploy.
- **Deps:** 006 — **Manual:** authorize GitHub connection; trigger first run
- **Acceptance:** trivial commit reaches production hands-free; failed
  health check rolls back.

### 008 — Upload flow
- **Goal:** Presigned direct-to-S3 upload end-to-end.
- **Scope:** `POST /api/videos` (validate, create row + PENDING jobs,
  presigned PUT with conditions), `POST /api/videos/:id/uploaded`;
  upload UI with progress; web task role gains S3 presign permission.
- **Deps:** 007
- **Acceptance:** 2 GB cap enforced; exact key convention; after confirm,
  event lands in both queues; record QUEUED.

### 009 — Worker base image & poll loop
- **Goal:** Shared worker runtime.
- **Scope:** worker Dockerfile (Node + ffmpeg/ffprobe); SQS long-poll
  loop, 60s visibility heartbeat, delete-on-success; shared S3-event
  parser; status callback client (backoff; don't delete message if
  callback fails); SIGTERM handling; runs locally against a test queue.
- **Deps:** 001 (integration-tested against 002's queues)
- **Acceptance:** mocked-SQS unit tests green; crash mid-job → message
  redelivered; image pushes through the 007 pipeline.

### 010 — Internal status API & state derivation
- **Goal:** Workers report; users read.
- **Scope:** `POST /api/internal/videos/:id/status` (worker bearer token
  from Secrets Manager; ALB rule blocks `/api/internal/*` from the
  internet); job upsert + `videos.state` derivation;
  `GET /api/videos`, `GET /api/videos/:id/status` (owner-scoped).
- **Deps:** 007
- **Acceptance:** 403 without token; internal path unreachable publicly;
  DONE×2 → READY; any FAILED → FAILED.

### 011 — Thumbnail worker service
- **Goal:** First real processing path.
- **Scope:** thumbnail mode (frame at min(10% duration, 5s) → JPEG →
  `outputs/{id}/thumb.jpg` → callback); `WorkerStack`: Fargate 0.5 vCPU /
  1 GB, scale 0→N on queue depth; IAM per matrix.
- **Deps:** 008, 009, 010
- **Acceptance:** real upload → correct thumbnail in output bucket; idle →
  0 tasks; IAM denial spot-checks pass.

### 012 — Transcode worker service (HLS)
- **Goal:** Adaptive HLS at 360p/720p/1080p.
- **Scope:** transcode mode (ffmpeg → 3 renditions + master playlist under
  `outputs/{id}/hls/`; skip renditions above source height, noted on job);
  Fargate 2 vCPU / 4 GB, scale 0→N; corrupt input → FAILED + message
  deleted (not DLQ'd).
- **Deps:** 009, 010 (008 for real input)
- **Acceptance:** reference video yields playable master playlist;
  idempotent redelivery; corrupt-file path verified.

### 013 — Library & status UI
- **Goal:** Live progress visible to the user.
- **Scope:** library page; video detail with per-job status bar
  (poll ≤5s, stop on READY/FAILED); clear failure display.
- **Deps:** 010 (012 for full happy path)
- **Acceptance:** upload → transitions visible without refresh; failure
  renders with error detail.

### 014 — CDN & playback
- **Goal:** Private-bucket HLS playback.
- **Scope:** `CdnStack` (CloudFront + OAC + bucket policy + trusted key
  group); signed-cookie issuance in `POST /api/videos/:id/playback`
  (owner-only, READY-only, path `/outputs/{id}/*`, 4h); hls.js player page
  (`withCredentials`), poster = thumbnail.
- **Deps:** 011, 012 — **Manual:** generate key pair, upload private key
  to Secrets Manager (script provided)
- **Acceptance:** clean-session playback works; direct S3 → 403;
  cookie-less CloudFront → 403; adaptive switching verified.

### 015 — Admin dashboard
- **Goal:** System performance page (PRD FR-6).
- **Scope:** `GET /api/admin/metrics` (CloudWatch: depths, oldest age, DLQ
  counts, task counts, durations; RDS: stuck jobs); auto-refreshing admin
  page; admin group enforcement.
- **Deps:** 011, 012
- **Acceptance:** values match console; non-admin 403; DLQ > 0 surfaced.

### 016 — Hardening & acceptance verification
- **Goal:** Prove PRD §9.
- **Scope:** corrupt-upload drill (FAILED record + DLQ + email); scale-to-
  zero soak; presigned-condition abuse tests; fresh-checkout `cdk deploy`
  drill; written acceptance checklist sign-off.
- **Deps:** all
- **Acceptance:** every PRD §9 item checked off.

---

## Dependency graph (condensed)

```
001 ─► 002 ─► 003 ─┐
  │    └─► 005 ────┤
  ├────► 004 ──────┴─► 006 ─► 007 ─► 008 ─► 011 ─► 015
  │                            │      ▲
  └────► 009 ──────────────────┼──────┘
                               ▼
                     010 ─► 012 ─► 014
                      └────► 013
                       all ─► 016
```

Parallelizable: 004 ∥ 005; 009 right after 002; 011 ∥ 012 ∥ 013 once
009+010 land.
