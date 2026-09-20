# 008 — Upload flow

## Manual setup required BEFORE starting
- None beyond M1 being live (pipeline deploying, auth working). Ship every
  change below through the 007 pipeline.

## Objective
A signed-in user picks a video, gets a presigned upload slot, uploads
directly to S3 with live progress, and sees the record land in QUEUED —
with the S3 event demonstrably in both SQS queues.

## Context
ARCHITECTURE §2.5 (upload), FR-2. The browser never sends bytes through
the API. Key convention is law: `uploads/{ownerSub}/{videoId}/source`
(shared helpers from 001). **Mechanism note:** enforcement of size/type
requires S3 *POST policies* — use `@aws-sdk/s3-presigned-post`
(`createPresignedPost`) with conditions, not a presigned PUT (PUT presigns
can't enforce `content-length-range`). The browser then does a
multipart-form POST directly to the bucket.

## Requirements
1. `POST /api/videos` (requireUser):
   - Body: `{ filename, contentType, sizeBytes }` (zod-validated).
   - Reject: `contentType` not `video/*`; `sizeBytes` > 2 GB or ≤ 0 →
     422 with readable reason.
   - Create `Video` row (state UPLOADING, `uploadKey` from helper,
     `ownerSub` from token) + two `VideoJob` rows (PENDING) in one
     transaction.
   - `createPresignedPost`: exact key, `content-length-range`
     1..2 GB, `starts-with` `$Content-Type: video/`, expiry 15 min.
   - Response: `{ videoId, post: { url, fields } }`.
2. `POST /api/videos/:id/uploaded` (requireUser, owner-scoped):
   - Verify object exists + size > 0 (`HeadObject`), then state → QUEUED.
   - Idempotent: repeat call returns current state, 200.
   - 404 if record missing/not owned; 409 if already past QUEUED.
3. Upload UI (`/upload` page + library "Upload" button):
   - File input (`accept="video/*"`); client-side pre-check of size/type
     (UX only — server is authoritative).
   - XHR (not fetch — need upload progress events) multipart POST with
     the presigned fields; progress bar; on 204 → call
     `/uploaded` → route to the video detail page (stub until 013).
4. Web task role (CDK, ComputeStack): `s3:PutObject` on
   `uploads/uploads/*` (for presign — presigned POST needs the signer to
   hold the permission) + `s3:HeadObject`-equivalent (`s3:GetObject` on
   the prefix covers HeadObject) — scoped to the uploads bucket only.
5. Extend web env schema: uploads bucket name (already), region.

## Files/components likely affected
- New: `apps/web/app/api/videos/route.ts` (POST),
  `apps/web/app/api/videos/[id]/uploaded/route.ts`,
  `apps/web/app/upload/page.tsx`, `apps/web/lib/s3.ts`,
  `apps/web/lib/validate-upload.ts`; edits: `infra/lib/compute-stack.ts`
  (task role), `packages/config`, library page placeholder.

## API changes
- Adds `POST /api/videos`, `POST /api/videos/:id/uploaded`.

## Database changes
None (uses 004 schema).

## Dependencies
- 007 (everything ships via pipeline; auth/DB/ECS from M1).

## Edge cases
- Presigned post unused/expired → record stays UPLOADING (Part B sweep —
  document, don't build).
- User uploads a *different* file than declared: S3 enforces key + size
  range; content-type mismatch beyond `video/*` is caught at transcode
  time → FAILED path (012). Acceptable; note it.
- Double-click upload confirm → idempotent 200 (above).
- HeadObject raced against S3 consistency: S3 is strongly consistent for
  new PUTs — but retry once after 500ms anyway to be safe.
- Filenames with unicode/spaces: stored as metadata only; never used in
  keys.

## Security considerations
- Key is always server-constructed from `{token.sub, generated uuid}` —
  the client can never influence path or overwrite another user's object.
- Presign expiry 15 min; post conditions are the enforcement, not the
  client checks.
- Task role gains S3 on uploads bucket only — assert no output-bucket
  permission in CDK tests.

## Tests
- Unit: validation matrix (MIME, sizes, boundary 2 GB exactly);
  transaction creates exactly 3 rows; ownership scoping (other user's id →
  404).
- Integration (dev env): full flow via curl — create, post file with
  fields (must succeed), post with oversized file (S3 403), confirm,
  check both queues received the event.

## Acceptance criteria
1. UI upload of a real video → progress → QUEUED, no refresh hacks.
2. Oversized/wrong-type rejected at API *and* at S3 policy level.
3. Message visible in both `transcode-queue` and `thumbnail-queue`
   (console screenshot into PR notes).
4. Record shows correct `uploadKey`, PENDING×2 jobs.
5. All green through the pipeline, zero manual deploy steps.

## Out of scope
- Consuming the queue messages (009+), status UI (013), multipart
  S3 chunked uploads, resumability.
