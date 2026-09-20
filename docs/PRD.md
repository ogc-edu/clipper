# Clipper — Product Requirements Document

**Version:** 0.1 (Part A)
**Status:** Pending approval
**Last updated:** 2025

---

## 1. Problem

Creators need to upload raw video and watch it on the web. Raw uploads are
too large, in the wrong codecs/containers, and unsuitable for browser
playback. The work of converting video is slow (minutes), spiky (arrives
whenever users upload), and must not block or take down the web application.

Clipper solves this: a user signs in, uploads a video directly to cloud
storage, watches a live status bar while background workers convert it, and
then plays the result in the browser at adaptive quality.

## 2. Goals (Part A)

1. A signed-in user can upload a video file of typical size (up to 2 GB).
2. Uploaded videos are automatically converted into web-friendly adaptive
   streaming format at **360p, 720p, and 1080p**.
3. A thumbnail image is extracted from each video.
4. The user sees a live progress/status view of their video's processing.
5. When processing completes, the user can play the video in the browser
   with adaptive bitrate quality selection.
6. Videos are delivered through a CDN; the storage holding finished videos
   is never publicly writable or directly publicly readable.
7. An admin page shows the health and performance of the processing system
   (queue depths, worker activity, failures, processing latency).
8. The processing system scales to zero cost when idle.
9. Failed processing jobs are isolated (dead-letter queues) so a single bad
   upload cannot block the pipeline.

## 3. Non-Goals (Part A)

- Content moderation pipeline (worker and queue) — deferred to Part B.
  The messaging architecture must leave a clean extension point for it.
- Live streaming / real-time broadcast.
- Video editing, trimming, clipping, or re-upload of processed versions.
- Social features: sharing, comments, likes, public discovery.
- Multi-tenant/team permissions; videos are private to their owner.
- Infrastructure-as-code in Terraform (CDK only for this project).
- Resumable/multipart-chunked browser uploads beyond what S3 presigned
  URLs provide natively.
- Mobile apps.

## 4. Users

| Actor | Description |
|---|---|
| **User** | Signs up/in, uploads videos, watches processing status, plays their own finished videos. |
| **Admin** | A privileged user who can view the system performance dashboard. (Part A: admin = a designated Cognito group; no user-management UI.) |
| **System (workers)** | Unattended background processes that transcode and thumbnail videos. |

## 5. User Flows

### 5.1 Sign in
1. User opens the app, is redirected to the hosted sign-in page.
2. On success, user lands on their video library (empty state if new).

### 5.2 Upload
1. User clicks "Upload", selects a video file.
2. App requests an upload slot from the API; API returns a presigned
   upload URL and creates a video record (`status: UPLOADING`).
3. Browser uploads the file directly to cloud storage.
4. App marks the upload as sent; the record moves to `QUEUED`.
5. The video appears in the library with a live status bar.

### 5.3 Processing status
1. The library/status view polls the API for the video record.
2. The status bar reflects overall state and per-job state
   (transcode, thumbnail): pending → running → done/failed.
3. On failure of any job, the user sees a clear failed state
   (no partial playable output promised).

### 5.4 Playback
1. When all jobs are done, the video shows as playable.
2. User clicks the video; the app requests a playback URL from the API.
3. The player streams adaptively (360p/720p/1080p) with a poster thumbnail.

### 5.5 Admin dashboard
1. Admin opens the admin page.
2. Sees: queue depths and age of oldest message (per queue + DLQ),
   running worker counts, recent failures, and processing duration stats.

## 6. Functional Requirements

### FR-1 Authentication
- FR-1.1 Users sign up and sign in with email + password via the hosted auth UI.
- FR-1.2 All API endpoints except auth callbacks require a valid identity token.
- FR-1.3 An `admin` group membership grants access to the admin endpoints/page.

### FR-2 Upload
- FR-2.1 `POST /api/videos` — validates file metadata (type, size ≤ 2 GB),
  creates the video record, returns a presigned upload URL.
- FR-2.2 The browser uploads directly to the uploads bucket; the API never
  proxies video bytes.
- FR-2.3 The uploads bucket accepts writes only via presigned URLs issued
  by the API, and only under the owner's key prefix.

### FR-3 Processing pipeline
- FR-3.1 A new object in the uploads bucket publishes exactly one
  announcement message to the messaging topic.
- FR-3.2 Independent queues for **transcode** and **thumbnail** each receive
  their own copy of the announcement.
- FR-3.3 The transcode worker produces adaptive streaming output
  (HLS: master playlist + 360p/720p/1080p renditions) in the output bucket.
- FR-3.4 The thumbnail worker produces a JPEG poster image in the output bucket.
- FR-3.5 Workers are pure processors: they read the upload, write outputs
  to the output bucket, and report job status by calling an internal API
  endpoint (`POST /api/internal/videos/:id/status`, authenticated with a
  worker credential from the secrets manager). Only the API reads and
  writes the database; workers have no database access.
- FR-3.6 Each queue has a dead-letter queue; messages failing repeatedly
  (after the configured redrive count) land there and raise an alarm.
- FR-3.7 Worker fleets scale with queue depth and scale to zero when idle.
- FR-3.8 The API validates worker status updates and persists them to the
  database (per-job state, output locations, error detail).

### FR-4 Status & records
- FR-4.1 The relational database is the record of truth: owner, overall
  state, per-job state, output locations, timestamps, error info.
- FR-4.2 `GET /api/videos` — lists the caller's videos with states.
- FR-4.3 `GET /api/videos/:id/status` — returns the record; the frontend
  polls this for the status bar. The frontend never reads storage directly.

### FR-5 Playback
- FR-5.1 `GET /api/videos/:id/playback` — owner-only; returns a time-limited
  signed CDN URL for the video's HLS master playlist.
- FR-5.2 The output bucket is fully private; all access flows through the
  CDN with signed URLs.
- FR-5.3 The web player supports adaptive bitrate playback and shows the
  thumbnail as the poster frame.

### FR-6 Admin dashboard
- FR-6.1 `GET /api/admin/metrics` (admin-only) — queue depths, oldest
  message age, DLQ counts, running task counts, recent error rates.
- FR-6.2 Admin page renders the above with auto-refresh.

## 7. Non-Functional Requirements

- **NFR-1 Security:** least-privilege IAM per component; no public write to
  any bucket; output bucket has no public access at all; secrets (DB
  credentials, CDN signing key) in a secrets manager, never in code or
  task-definition plaintext; resource identifiers (queue URLs, bucket names)
  injected as plain environment configuration by the infra layer.
- **NFR-2 Scalability:** workers scale horizontally with queue depth;
  web tier runs ≥ 2 tasks behind a load balancer.
- **NFR-3 Reliability:** per-queue DLQs; worker failures leave the record in
  a failed state with error detail; retries via SQS redrive policy.
- **NFR-4 Cost:** Fargate spot or on-demand workers scale to zero when
  queues are empty; no always-on worker capacity in dev.
- **NFR-5 Observability:** all container logs in CloudWatch; metrics for
  queue depth, job duration, and failure counts; alarms on DLQ depth > 0.
- **NFR-6 Performance:** playback start ≤ ~3s on a normal broadband
  connection via the CDN; status polling interval ≤ 5s.

## 8. Constraints

- **Cloud:** AWS only. Required services: S3, SQS, SNS, RDS, ECS (Fargate),
  CloudFront, CloudWatch, CodeBuild, CodeDeploy, Cognito, IAM,
  Secrets Manager, ECR.
- **Infrastructure as code:** AWS CDK in TypeScript, in this repository.
  All resource names (buckets, queues, database, etc.) are explicitly
  defined in `infra/config.ts` — no CDK auto-generated names. `cdk deploy`
  provisions 100% of the system; no console-created resources.
- **Language:** TypeScript across web app, API, and workers.
- **Media tooling:** ffmpeg (and ffprobe) inside the worker container image.
- **Environments:** a real AWS dev account for development and testing;
  no local emulation of AWS messaging services.
- **Region:** single region for Part A (CDN provides global delivery).

## 9. Acceptance Criteria (Part A)

1. A new user can sign up, sign in, and land on an empty library.
2. Uploading a supported video file results — without further user action —
   in a playable HLS stream at three renditions plus a thumbnail.
3. The status bar reflects real per-job progress states end-to-end.
4. Playback works in a clean browser session via a signed CDN URL; direct
   S3 URLs to outputs are denied.
5. Uploading a corrupt/non-video file results in a failed state on the
   record, the message landing in the DLQ after redrive, and a CloudWatch
   alarm firing; other queued jobs are unaffected.
6. With no uploads for a period, worker task count is zero.
7. The admin page shows live queue/worker/failure metrics.
8. `cdk deploy` from a clean checkout provisions the entire system; nothing
   is manually created in the console.
9. CI builds and tests the code; CD deploys the web service blue/green.

## 10. Open Questions

_None outstanding for Part A — resolved during planning: HLS output format;
RDS (relational) as record of truth; moderation deferred to Part B; web
tier on ECS Fargate with CodeDeploy blue/green; CDK for IaC; real AWS dev
account._
