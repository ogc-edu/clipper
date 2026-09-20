# Clipper — Architecture

**Version:** 0.1 (Part A)
**Status:** Pending approval
**Source of truth for:** system design. Requirements live in `docs/PRD.md`.

---

## 1. System Overview

```
                          ┌─────────────┐
        sign in (JWT)     │   Cognito   │
   ┌──────────────────────│  Hosted UI  │◄──────┐
   │                      └─────────────┘       │
   ▼                                            │
┌─────────┐   HTTPS    ┌──────────────────────┐ │ verify JWT
│ Browser │◄──────────►│  ALB → Next.js app   │─┘
│ (React) │            │  (ECS Fargate ×2+,   │
└────┬────┘            │   blue/green deploy) │
     │                 └──┬────┬────┬─────────┘
     │                    │    │    │
     │ presigned PUT      │    │    ├──────────────► RDS PostgreSQL
     │ (direct, browser   │    │    │                (record of truth)
     │  → S3, API never   │    │    └──────────────► Secrets Manager
     │  touches bytes)    │    │                     (DB creds, CF key,
     ▼                    │    │                      worker token)
┌──────────────┐  event   │    │
│ uploads      │────────► SNS topic "video-uploaded"
│ bucket (S3)  │          └──┬──────────────┬─────────────► (Part B: moderation queue)
└──────────────┘             │              │
                        ┌────▼───┐      ┌───▼────┐
                        │ SQS    │      │ SQS    │      each with DLQ + alarm
                        │transcode      │thumbnail
                        └───┬────┘      └───┬────┘
                            │ poll          │ poll
                     ┌──────▼──────┐ ┌──────▼──────┐
                     │ transcode   │ │ thumbnail   │   same image, WORKER_MODE env
                     │ workers     │ │ workers     │   scale-to-zero on queue depth
                     │ (Fargate)   │ │ (Fargate)   │
                     └──┬───────┬──┘ └──┬───────┬──┘
                        │       │       │       │
              read uploads      │       │       └────────┐
              write outputs ────┼───────┼──► ┌───────────▼──┐      ┌────────────┐
              status callback ──┴───────┘    │ output bucket│◄─────│ CloudFront │
              (worker token, to API)         │  (private)   │ OAC  │ + signed   │
                                             └──────────────┘      │ cookies    │
                                                                   └─────┬──────┘
                                                                         │ HLS
                                                                   ┌─────▼──────┐
                                                                   │  Browser    │
                                                                   │  (hls.js)   │
                                                                   └────────────┘
```

## 2. Components

### 2.1 Web app / API — `apps/web`
- Next.js (App Router, TypeScript). UI pages + Route Handlers as the API.
- Runs on ECS Fargate behind an Application Load Balancer, min 2 tasks,
  deployed blue/green via CodeDeploy.
- Responsibilities: auth session handling, issuing presigned upload URLs,
  video record CRUD (the **only** RDS reader/writer), status endpoints,
  playback authorization + signed-cookie issuance, admin metrics endpoint,
  internal worker status callback endpoint.
- Never reads or writes video bytes.

### 2.2 Workers — `apps/worker`
- One Docker image (Node.js + ffmpeg/ffprobe), three runtime modes via
  `WORKER_MODE` env var. Part A deploys two services: `transcode`,
  `thumbnail`. Part B adds `moderation` with no other changes.
- Long-poll their SQS queue (20s), process, delete message on success.
- Pure processors: read uploads bucket, write output bucket, report status
  to the API. **No database credentials exist in the worker environment.**
- Scale-to-zero via ECS Service Auto Scaling on
  `ApproximateNumberOfMessagesVisible` (target tracking).

### 2.3 Data stores

**RDS PostgreSQL (record of truth)** — single-AZ in dev.

```sql
CREATE TABLE videos (
  id               UUID PRIMARY KEY,
  owner_sub        TEXT NOT NULL,            -- Cognito user sub
  original_filename TEXT NOT NULL,
  upload_key       TEXT NOT NULL UNIQUE,     -- uploads/{owner_sub}/{id}/source
  state            TEXT NOT NULL             -- UPLOADING | QUEUED | PROCESSING
                   CHECK (state IN ('UPLOADING','QUEUED','PROCESSING',
                                    'READY','FAILED')),
  hls_master_key   TEXT,                     -- outputs/{id}/hls/master.m3u8
  thumbnail_key    TEXT,                     -- outputs/{id}/thumb.jpg
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX videos_owner_idx ON videos (owner_sub, created_at DESC);

CREATE TABLE video_jobs (                    -- one row per (video, job kind)
  video_id   UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('TRANSCODE','THUMBNAIL')),
  state      TEXT NOT NULL CHECK (state IN ('PENDING','RUNNING','DONE','FAILED')),
  attempts   INT NOT NULL DEFAULT 0,
  error      TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (video_id, kind)
);
```

- Overall `videos.state` is derived by the API from `video_jobs` rows:
  all DONE → READY; any FAILED → FAILED; any RUNNING → PROCESSING.
- Data access via **Prisma** (schema at `apps/web/prisma/schema.prisma`,
  `prisma migrate` for schema changes, run as a one-off deploy task).

**S3** — two buckets (names from `infra/config.ts`):
- *uploads bucket*: private; CORS limited to the app's origin; lifecycle
  rule deletes objects after 7 days (processed source is reclaimable).
- *output bucket*: private, no public access block at max; only CloudFront
  OAC and the workers/API roles can touch it.

### 2.4 Messaging

- **SNS topic** `video-uploaded`: receives S3 `ObjectCreated` events from
  the uploads bucket (filtered to `uploads/` prefix). Fan-out only;
  carries no business logic.
- **SQS queues** (each `contentBasedDeduplication` n/a — standard queues):
  - `transcode-queue` — visibility timeout **15 min** (transcode is slow),
    redrive `maxReceiveCount: 3` → `transcode-dlq`
  - `thumbnail-queue` — visibility timeout **2 min**,
    redrive `maxReceiveCount: 3` → `thumbnail-dlq`
- Long-running workers extend visibility timeout ("heartbeat") every 60s
  while actively processing, so a slow 2 GB transcode isn't redelivered.

**Message contract:** S3 `ObjectCreated` events are delivered raw through
SNS → SQS (see Decision D1 — no enricher Lambda). Workers extract the
business fields from the event's object key, which follows the convention:

```
uploads/{ownerSub}/{videoId}/source
```

The parsed contract every worker consumes (defined in `packages/shared`):

```json
{
  "videoId": "uuid",
  "ownerSub": "cognito-sub",
  "uploadKey": "uploads/{sub}/{videoId}/source",
  "bucket": "<uploads-bucket>",
  "eventId": "s3-event-id"
}
```

### 2.5 CDN & playback

- CloudFront distribution in front of the output bucket via **Origin
  Access Control**; bucket policy allows only the distribution.
- **Signed cookies, not signed URLs** — see Decision D2. API endpoint
  `POST /api/videos/:id/playback` (owner-only, video must be READY) sets
  three `CloudFront-*` cookies scoped to path `/outputs/{id}/*`,
  TTL 4 hours. The player then fetches `master.m3u8`, variant playlists,
  and all segments without per-request signing.
- Signing key pair: generated once, public key registered as a CloudFront
  trusted key group, private key in Secrets Manager.

### 2.6 AuthN/AuthZ

- Cognito User Pool + Hosted UI; Next.js handles the OAuth code flow,
  stores the ID token in an `HttpOnly; Secure; SameSite=Lax` cookie.
- Middleware verifies the JWT (issuer, audience, expiry) on every
  `/api/*` route except `/api/auth/*`.
- Authorization rules:
  - Video records are owner-scoped: every query filters on
    `owner_sub = token.sub`. No shared/public videos in Part A.
  - `/api/admin/*` requires membership in the Cognito `admin` group.
  - `/api/internal/*` requires the worker bearer token (Secrets Manager),
    and is additionally restricted at the ALB to traffic from the VPC
    (internal listener rule / path rule), so it is not internet-reachable.

## 3. API Surface (Route Handlers)

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/auth/callback` | public | Cognito code exchange |
| `POST /api/videos` | user | Validate metadata → create record (state UPLOADING) → presigned PUT URL |
| `POST /api/videos/:id/uploaded` | user | Client confirms bytes are in S3 → state QUEUED (jobs PENDING) |
| `GET /api/videos` | user | List caller's videos + derived states |
| `GET /api/videos/:id/status` | user | Full record + per-job states (polled ≤5s) |
| `POST /api/videos/:id/playback` | user (owner) | Set CloudFront signed cookies, return master playlist URL |
| `GET /api/admin/metrics` | admin | Queue depths, oldest message age, DLQ counts, task counts, recent failures (CloudWatch API) |
| `POST /api/internal/videos/:id/status` | worker | Body: `{kind, state, outputs?, error?}` — validates + persists |

## 4. Data Flows

**Upload → processing:**
1. `POST /api/videos` → RDS row (UPLOADING) → presigned PUT for
   `uploads/{sub}/{videoId}/source` with content-length + content-type
   conditions.
2. Browser PUTs direct to S3 → S3 event → SNS → both queues get a copy.
3. Transcode worker: downloads source, runs ffmpeg → three HLS renditions
   + master playlist under `outputs/{id}/hls/`, uploads, calls
   `POST /api/internal/.../status {kind: TRANSCODE, state: DONE}`.
4. Thumbnail worker: seeks to 10% or 5s (whichever first), grabs one
   frame → `outputs/{id}/thumb.jpg`, reports DONE.
5. API derives videos.state → READY once both jobs are DONE.

**Playback:**
`POST playback` → signed cookies → `<video>` + hls.js pointed at the
CloudFront master playlist URL; thumbnail as `poster`.

## 5. Failure Handling

| Failure | Behavior |
|---|---|
| Corrupt/non-video upload | ffmpeg exits non-zero → worker reports FAILED with stderr tail to API → message deleted (job is terminally failed, retrying identical bytes won't help). Record shows FAILED + reason. |
| Worker crash / task killed mid-job | Visibility timeout expires → message redelivered (idempotent: outputs overwrite by deterministic key) → after 3 receives → DLQ → CloudWatch alarm. |
| API unreachable from worker | Worker retries callback with backoff; if still failing, does **not** delete the SQS message → redelivery covers it. |
| Stuck job (RUNNING > 30 min) | Admin dashboard surfaces it via job age query; no automatic reaper in Part A. |
| Presigned URL unused | Record stays UPLOADING; a nightly sweep is a Part B nicety — noted, not built. |
| RDS unavailable | API returns 503; workers unaffected (they only need the API *after* processing; redelivery covers gaps). |

Workers are idempotent by construction: deterministic output keys,
`INSERT .. ON CONFLICT` in the API's status handler.

## 6. Security Boundaries (IAM matrix)

| Identity | Can | Cannot |
|---|---|---|
| Web/API task role | S3: sign PUTs on uploads, sign nothing on output; RDS via Secrets Manager creds; CloudWatch read (admin metrics); Secrets Manager read (DB, CF key, worker token) | Delete buckets/objects; read uploads content; manage IAM |
| Transcode worker role | S3 GetObject on uploads, PutObject on output; SQS consume on transcode-queue only | RDS, Secrets Manager (no DB creds exist), other queues, uploads write |
| Thumbnail worker role | Same shape, thumbnail-queue only | Same |
| CloudFront OAC | GetObject on output bucket | Anything else |
| Users | Presigned PUT to own prefix only | Direct reads of either bucket |

Presigned PUT conditions: exact key, `content-length-range` ≤ 2 GB,
expected content-type prefix `video/`.

## 7. Scalability

- Web: ALB + min 2 Fargate tasks, CPU target tracking.
- Workers: 0→N on queue depth. Transcode gets larger task size
  (2 vCPU / 4 GB baseline); thumbnail small (0.5 vCPU / 1 GB).
- SQS standard queues = effectively unlimited throughput; SNS fan-out adds
  queues at zero cost to existing paths (moderation in Part B).
- RDS single-AZ dev; the schema's only hot path is status polling, indexed
  by `(owner_sub, created_at)` and by PK for worker updates.

## 8. Observability

- All containers → CloudWatch Logs (`/ecs/clipper/<service>`).
- Custom metrics (worker emits via CloudWatch embedded metric format):
  `JobDuration{kind}`, `JobFailure{kind}`, plus SQS/ECS native metrics.
- Alarms: any DLQ depth > 0; transcode p90 duration > 20 min. All alarms
  publish to an SNS `ops-alerts` topic with an **email subscription**, so
  DLQ arrivals page the operator directly.
- Admin dashboard composes CloudWatch metrics + a DB query for
  stuck/old jobs.

## 9. CI/CD

- **CodeBuild**: install → typecheck → unit tests → build → docker build →
  push to ECR (one repo, tags `web-<sha>`, `worker-<sha>`) →
  `cdk deploy` infra changes.
- **CodeDeploy**: blue/green for the web service (ALB listener swap,
  5-min bake, auto-rollback on alarm). Workers use native ECS rolling
  deployment (stateless, safe).
- Pipeline trigger: push to `main`.

## 10. Key Decisions & Alternatives

- **D1 — No Lambda between S3 and workers.** S3 event → SNS → SQS
  delivers the raw S3 event; workers parse `videoId`/`ownerSub` from the
  key convention. *Alternative:* an enricher Lambda building the clean
  message contract above. Rejected for Part A: one more moving part; key
  convention carries all needed data. Contract documented anyway so Part B
  can introduce enrichment without worker changes.
- **D2 — Signed cookies over signed URLs.** HLS playback chains dozens of
  requests (master → variants → segments); signing each URL is fragile and
  cache-hostile. One cookie set scoped to `/outputs/{id}/*` covers the
  whole tree. *Alternative rejected:* per-playlist URL rewriting.
- **D3 — Worker status via API callback, not direct RDS.** Per PRD
  FR-3.5: DB has exactly one client; workers stay pure and hold no DB
  credentials. *Alternative rejected:* a separate status queue consumed by
  the API — more reliable in theory, but callback + SQS redelivery already
  covers API downtime, and one fewer queue/consumer in Part A.
- **D4 — One worker image, mode via env.** One Dockerfile/pipeline;
  per-service config is just env + task size. *Alternative:* three images —
  no benefit at this scale.
- **D5 — Next.js route handlers instead of separate Express API.** The API
  is thin (auth, presign, CRUD, signing); a second service adds deploy and
  CORS complexity for no isolation benefit. Revisit if the API grows
  compute-heavy endpoints.
- **D6 — Prisma as the data layer.** Type-safe client, migrations as code,
  and the schema stays readable in one file. *Alternative rejected:* raw
  SQL + `pg` — fine at this size, but Prisma's migration tooling is the
  more transferable skill and keeps RDS changes reviewable.

## 11. Repository Layout

```
clipper/
├── apps/
│   ├── web/            # Next.js (UI + API route handlers)
│   └── worker/         # Node + ffmpeg image; WORKER_MODE=transcode|thumbnail
├── packages/
│   ├── shared/         # message/job types, key-convention helpers, SQS payload parser
│   └── config/         # zod-validated env loading
├── infra/
│   ├── config.ts       # ALL resource names — owned by the user
│   └── lib/            # CDK stacks: storage, messaging, data, compute, cdn, ci
├── docs/               # PRD, ARCHITECTURE, IMPLEMENTATION_PLAN, plans/
└── package.json        # pnpm workspaces
```
