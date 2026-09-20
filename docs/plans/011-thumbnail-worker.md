# 011 — Thumbnail worker service

## Manual setup required BEFORE starting
- None. (Ships through the pipeline; confirm the SNS ops email from 002
  is confirmed — failures here page you.)

## Objective
First real processing path: a scale-to-zero Fargate service that turns
each upload into a JPEG poster frame in the output bucket and reports
DONE via the API.

## Context
ARCHITECTURE §2.2, IAM matrix. Runs the 009 image with
`WORKER_MODE=thumbnail`. Small tasks (0.5 vCPU/1 GB). This feature
creates `WorkerStack`, which 012 reuses — get the patterns right here.

## Requirements
1. `apps/worker/src/modes/thumbnail.ts`:
   - Download source to `/tmp/{videoId}/source` (streamed — a 2 GB file
     must not buffer in memory; ephemeral storage default is fine).
   - `ffprobe` duration → seek target = min(10% of duration, 5s);
     single ffmpeg pass: `-ss {t} -i src -frames:v 1 -q:v 3` → JPEG.
   - Upload to `outputs/{videoId}/thumb.jpg` (content-type image/jpeg).
   - ffprobe/ffmpeg failure to read the file → `TerminalJobError`
     (corrupt input → FAILED + delete, per 009 semantics).
   - Callback DONE with `{ thumbnailKey }`.
2. `WorkerStack` (CDK):
   - Fargate service `thumbnail-worker`: the worker ECR image
     (`worker-latest`), 0.5 vCPU / 1 GB, private subnets, min 0.
   - Env: mode, queue URL (thumbnail-queue), bucket names, API base URL
     (ALB :8080 per 010); secret: `WORKER_API_TOKEN`.
   - Task role per IAM matrix: `sqs` consume on thumbnail-queue ONLY,
     `s3:GetObject` on `uploads/uploads/*`, `s3:PutObject` on
     `output/outputs/*`, secrets read on the token only, CloudWatch logs.
   - Auto scaling: target tracking on
     `ApproximateNumberOfMessagesVisible` (custom metric math or
     step scaling: 0 visible → 0 tasks; scale out +1 per message up to
     max 4). Scale-in cooldown ≥ 300s so in-flight jobs aren't killed —
     combined with SIGTERM semantics from 009.
   - Log group `/ecs/clipper/thumbnail-worker`.
3. DLQ alarm for thumbnail-dlq already exists (002) — verify wiring
  shows worker service name in alarm description (update alarm text if
  trivial).

## Files/components likely affected
- New: `infra/lib/worker-stack.ts`, `infra/test/worker-stack.test.ts`,
  `apps/worker/src/modes/thumbnail.ts`; edits: `infra/bin/infra.ts`,
  `apps/worker/src/index.ts` (register mode).

## API changes
None (consumes 010).

## Database changes
None.

## Dependencies
- 008 (real uploads arriving), 009 (harness), 010 (callback target).

## Edge cases
- Video shorter than 5s: seek target clamps to duration×0.1 ≥ 0 —
  ffmpeg handles tiny inputs; add fixture test with a 1s clip.
- Scale-in killing a task mid-job: 009's SIGTERM handling releases the
  message; cooldown reduces frequency. Document, accept.
- Queue message for a video whose source was already lifecycle-deleted
  (7-day rule): S3 GetObject 404 → TerminalJobError (FAILED), not retry.
- Output overwrite on redelivery: same key, PutObject overwrites — fine.

## Security considerations
- Assert in CDK tests: role has NO access to transcode-queue, no RDS,
  no delete permissions anywhere.
- `/tmp` only; no credentials in image.

## Tests
- Unit: seek-target calculation table; TerminalJobError classification
  (corrupt fixture vs simulated S3 timeout).
- Local integration: container against dev queue with a real uploaded
  fixture video → thumbnail appears in output bucket, callback observed
  against a stub API.
- CDK assertions: scaling config, IAM deny-by-absence checks, env/secrets.

## Acceptance criteria
1. Real upload through the UI → thumbnail in output bucket + record's
   thumbnail job DONE (overall state still PROCESSING until 012 exists —
   expected, verify it's not READY).
2. Queue empty ≥ 15 min → 0 running tasks (console metric).
3. IAM spot-check: from ECS Exec in the task, `aws s3 ls` on the
   transcode queue / output bucket root → denied.
4. Corrupt upload → record FAILED with ffmpeg error tail; message NOT in
   DLQ (deleted as terminal).

## Out of scope
- Transcode mode (012), multiple thumbnails/scrub strips, image resizing
  variants.
