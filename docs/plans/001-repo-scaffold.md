# 001 — Repository & workspace scaffold

## Manual setup required BEFORE starting
- None. (Local only: Node.js ≥ 20, pnpm ≥ 9 installed.)

## Objective
Create the pnpm monorepo skeleton that every other feature builds in.
Nothing deploys to AWS in this feature.

## Context
Greenfield repo at the project root. Layout is fixed by
`docs/ARCHITECTURE.md` §11. All code is TypeScript. The two packages that
matter here are `shared` (types + S3 key convention) and `config` (env
validation) — every app and worker will depend on them.

## Requirements
1. pnpm workspaces covering `apps/*` and `packages/*`.
2. Base `tsconfig.base.json` (strict mode, NodeNext resolution for
   non-Next packages); per-package tsconfigs extend it.
3. ESLint (flat config) + Prettier at root; `pnpm lint`, `pnpm format`.
4. vitest for unit tests in packages; `pnpm test` runs all.
5. `packages/shared`:
   - Types: `VideoState` ('UPLOADING'|'QUEUED'|'PROCESSING'|'READY'|'FAILED'),
     `JobKind` ('TRANSCODE'|'THUMBNAIL'), `JobState`
     ('PENDING'|'RUNNING'|'DONE'|'FAILED'),
     `ParsedUploadEvent` ({videoId, ownerSub, uploadKey, bucket, eventId}).
   - Key helpers: `uploadKey(ownerSub, videoId)` →
     `uploads/{ownerSub}/{videoId}/source`;
     `parseUploadKey(key)` → {ownerSub, videoId} or throw;
     `outputHlsPrefix(videoId)` → `outputs/{videoId}/hls/`;
     `outputThumbnailKey(videoId)` → `outputs/{videoId}/thumb.jpg`.
   - S3 event parser: `parseS3EventFromSqs(body: string): ParsedUploadEvent`
     — parses the raw S3 `ObjectCreated:Put` event delivered via SNS→SQS
     (raw delivery), extracts bucket + key, applies `parseUploadKey`.
6. `packages/config`: zod schemas + `loadEnv(schema)` helper that throws a
   readable error listing every missing/invalid variable. Define (but don't
   wire yet) schemas for web and worker env per ARCHITECTURE.
7. `apps/web`: `create-next-app` (App Router, TS, src/ dir optional — pick
   none for simplicity), ESLint wired to root config, placeholder page.
8. `apps/worker`: empty TS package with `src/index.ts` placeholder and
   build via `tsup` or `tsc`.
9. Root README: setup instructions, scripts table, link to docs/.

## Files/components likely affected
- New: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`,
  `eslint.config.mjs`, `.prettierrc`, `.gitignore` (node, .next, dist,
  .env*, cdk.out), `packages/shared/**`, `packages/config/**`,
  `apps/web/**`, `apps/worker/**`, `README.md`.

## API changes
None.

## Database changes
None.

## Dependencies
None.

## Edge cases
- `parseUploadKey` must reject keys that don't match the convention
  (wrong prefix, missing segments, extra path depth, non-UUID videoId) —
  these become DLQ-bound messages in production, so throw a typed error
  (`InvalidUploadKeyError`) the worker can distinguish.
- `parseS3EventFromSqs` must handle URL-encoded keys in S3 events
  (`+` and `%XX` decoding) and S3 "test events" gracefully (throw typed
  error, don't crash parse of batch).
- UUID validation: accept any RFC-4122 UUID, not just v4.

## Security considerations
- `.gitignore` must exclude `.env*` and `cdk.out` from day one.
- No secrets anywhere in this feature; config package only *validates*.

## Tests
- `packages/shared`: key round-trip (build → parse → equal), rejection
  table for malformed keys, S3 event parsing with a real captured
  ObjectCreated event JSON fixture (incl. URL-encoded key), test-event
  handling.
- `packages/config`: schema passes with valid env, throws listing all
  missing vars with invalid env.

## Acceptance criteria
- `pnpm install && pnpm build && pnpm lint && pnpm test` all green from a
  clean clone.
- `apps/web` dev server starts and renders placeholder.
- Fixture-based parser test passes.

## Out of scope
- Any AWS resource, Dockerfile, CI config, Prisma, auth, UI beyond the
  placeholder page.
