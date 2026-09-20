# 009 — Worker base image & poll loop

## Manual setup required BEFORE starting
- None. Local testing uses LocalStack? **No** — per project constraint,
  test against the real dev queues from 002 using your AWS credentials
  (a throwaway message in the thumbnail queue is the fixture).

## Objective
The shared worker runtime: one Docker image (Node + ffmpeg) that
long-polls an SQS queue, heartbeats visibility while processing, reports
results to the internal API, and shuts down cleanly. Mode-specific logic
(011/012) plugs into a `process(job)` seam.

## Context
ARCHITECTURE §2.2, D4 (one image, `WORKER_MODE` env), D3 (API callback;
on callback failure the message is NOT deleted so redelivery retries the
report). This feature delivers the harness with a no-op mode; real modes
follow. Parser comes from `packages/shared` (001).

## Requirements
1. `apps/worker` structure:
   - `src/index.ts` — entrypoint: load env (worker schema from
     `packages/config`: `WORKER_MODE`, `QUEUE_URL`, `UPLOADS_BUCKET`,
     `OUTPUT_BUCKET`, `API_BASE_URL`, `WORKER_API_TOKEN`,
     `AWS_REGION`), resolve mode module, run loop.
   - `src/loop.ts` — poll loop (below).
   - `src/modes/noop.ts` — placeholder `process()` (logs + returns).
   - `src/callback.ts` — status client (below).
   - `src/ffmpeg.ts` — thin wrappers around `ffmpeg`/`ffprobe` binaries
     (spawn, stream stderr to logger, promise exit code) — used by 011/012.
2. Poll loop semantics:
   - `ReceiveMessage`: long-poll 20s, `MaxNumberOfMessages: 1`,
     `WaitTimeSeconds: 20`.
   - On message: parse via shared parser; typed `InvalidUploadKeyError` →
     report nothing (no videoId to report against), delete? **No** —
     malformed messages can't be fixed by retry: log + **delete** to keep
     the queue clean (they're not our contract's messages). Document.
   - Start visibility heartbeat: `ChangeMessageVisibility` +60s every 60s
     while `process()` runs; stop heartbeat on completion.
   - Success path: `process()` ok → callback `DONE` (with outputs) →
     delete message. Callback fails after retries → do NOT delete;
     exit loop iteration (message redelivers later; re-processing is
     idempotent).
   - Failure path: `process()` throws `TerminalJobError` (bad input —
     ffmpeg can't read file) → callback `FAILED` with error → delete
     message. Any other throw (transient: S3 timeout etc.) → don't
     delete; message redelivers up to redrive → DLQ.
   - SIGTERM: stop polling; if mid-job, stop heartbeat and let the
     message redeliver (Fargate gives ~30s stop grace — do NOT try to
     finish a transcode); exit 0.
3. Callback client (`callback.ts`): POST
   `{API_BASE_URL}/api/internal/videos/{videoId}/status` with
   `Authorization: Bearer {WORKER_API_TOKEN}`, body
   `{ kind, state, outputs?, error? }`. Retry: 3 attempts, exponential
   backoff (1s/4s/16s), classify 4xx (except 429) as terminal for that
   report (log loudly — means contract bug or auth break).
4. `apps/worker/Dockerfile`: `node:20-alpine` + `apk add ffmpeg`
   (includes ffprobe), non-root, tini as PID 1 (signal handling),
   built workspace deps only.
5. Metrics: emit CloudWatch embedded-metric-format lines to stdout for
   `JobDuration{mode}`, `JobFailure{mode}` (used by 015's dashboard).
6. Pipeline check: 007's buildspec already builds/pushes this image —
   verify `worker-<sha>` appears in ECR after merge.

## Files/components likely affected
- New: `apps/worker/src/**`, `apps/worker/Dockerfile`,
  `apps/worker/test/**`; edits: `packages/config` (worker env schema),
  `packages/shared` (callback payload type `JobStatusReport`).

## API changes
- Consumes (does not add) `POST /api/internal/videos/:id/status` —
  contract defined here, implemented in 010. Add the
  `JobStatusReport` zod schema to `packages/shared` now so 010 imports it.

## Database changes
None.

## Dependencies
- 001; integration-tested against 002's queues and a stub HTTP server
  standing in for 010.

## Edge cases
- Duplicate delivery (SQS at-least-once): whole design is idempotent —
  same output keys, callback upserts. Add a test that runs `process`
  twice for the same event.
- Heartbeat failure (network blip): log and continue; worst case the
  message redelivers and duplicate work happens — acceptable, idempotent.
- Empty queue long-poll returns cleanly; loop must not hot-spin
  (it naturally waits 20s; assert no busy loop in tests).
- Batch size 1 deliberately: transcode is long; don't hold messages hostage.

## Security considerations
- Worker env contains NO database credentials — assert in a test that
  env schema rejects `DATABASE_URL` present (guard rail).
- `WORKER_API_TOKEN` arrives via Secrets Manager injection (wired in
  011/012's WorkerStack); locally read from env.
- Least privilege wired per-service in 011/012; base image itself needs
  no AWS creds baked in (task role only).

## Tests
- Unit (mocked SQS client + stub callback server): happy path, terminal
  vs transient classification, callback-failure → no delete, heartbeat
  calls observed, SIGTERM behavior, malformed message → delete + log.
- Local integration (documented script): send real test message to dev
  thumbnail-queue → run container locally with your credentials → observe
  noop processing + (stubbed) callback attempt + message deletion.

## Acceptance criteria
1. Unit suite green; image builds in pipeline and lands in ECR.
2. Local container drains a real test message from the dev queue.
3. Crash test: kill -9 mid-`process()` on a real queue → message
   redelivers after visibility expiry (observed via console/CLI).
4. Env-schema guard test proves no DB creds can be configured.

## Out of scope
- Real transcode/thumbnail logic (011/012), Fargate service definitions
  and scaling (011/012), the API endpoint itself (010).
