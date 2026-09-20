# 012 — Transcode worker service (HLS)

## Manual setup required BEFORE starting
- None. Provide one real reference video (a 1080p clip, 30–120s,
  h.264) as the acceptance fixture — put it at
  `apps/worker/test/fixtures/reference.mp4` (≤ 20 MB; git-lfs not needed
  at that size) or supply an S3 location if larger.

## Objective
Each upload becomes an adaptive HLS bundle — master playlist plus 360p /
720p / 1080p renditions — in the output bucket, from a scale-to-zero
Fargate service. This completes the processing pipeline: after it lands,
records reach READY.

## Context
ARCHITECTURE §2.2, §4; PRD FR-3.3. Runs the 009 image with
`WORKER_MODE=transcode` against `transcode-queue` (15-min visibility +
heartbeats already handled by the loop). Bigger tasks: 2 vCPU / 4 GB.
Output layout (contract for 013/014):

```
outputs/{videoId}/hls/master.m3u8
outputs/{videoId}/hls/360p/index.m3u8, seg_000.ts, ...
outputs/{videoId}/hls/720p/...
outputs/{videoId}/hls/1080p/...
```

## Requirements
1. `apps/worker/src/modes/transcode.ts`:
   - Stream-download source to `/tmp/{videoId}/source` (10 GB ephemeral
     storage on the task — set in CDK; 2 GB cap leaves headroom).
   - `ffprobe`: width/height/duration. Unreadable → `TerminalJobError`.
   - **Rendition filter:** only renditions ≤ source height (480p source →
     360p only; never upscale). If source < 360p, produce one rendition
     at source height named `source/`. Record chosen renditions in the
     job's callback payload (`outputs.renditions` — extend
     `JobStatusReport` in shared).
   - One ffmpeg invocation, ladder into HLS (per-rendition
     `-vf scale=-2:{h} -b:v {rate} -preset veryfast -g 48
     -hls_time 4 -hls_playlist_type vod`), H.264 + AAC, `-movflags
     faststart` n/a for HLS; var_stream_map + master playlist written by
     ffmpeg's `-master_pl_name`.
   - Upload the whole `hls/` tree to S3 (parallel, content types:
     `application/vnd.apple.mpegurl` / `video/mp2t`).
   - Callback DONE with `{ hlsMasterKey, renditions }`.
2. `WorkerStack` additions: `transcode-worker` service — 2 vCPU / 4 GB,
   ephemeral storage 21 GB, max tasks 2 (transcodes are expensive; dev
   cap), same scaling pattern as 011 but scale-in cooldown 900s,
   heartbeat already 60s (loop) — visibility ceiling: assert
   15-min base + heartbeats cover p95 of a 2 GB transcode on 2 vCPU; if
   the reference video shows otherwise, raise queue visibility in
   MessagingStack and note the change.
3. IAM: transcode-queue only; same S3 shape as 011. CDK assertions.

## Files/components likely affected
- New: `apps/worker/src/modes/transcode.ts`, fixture; edits:
  `infra/lib/worker-stack.ts`, `packages/shared`
  (`outputs.renditions`), `apps/worker/src/index.ts`.

## API changes
- `JobStatusReport.outputs` gains optional `renditions: string[]`
  (backward compatible — 010 stores outputs JSON opaquely; verify no
  strict validation breaks, loosen if it does).

## Database changes
None.

## Dependencies
- 009, 010; 008 for real input.

## Edge cases
- Source with no audio track: `-map` must tolerate — use `?` stream
  selectors / generate silent audio (AAC required by strict HLS players;
  safest: `-f lavfi -i anullsrc` fallback when probe finds no audio).
  Test with a muted fixture.
- Non-square pixels / odd dimensions: `scale=-2:{h}` keeps aspect with
  even width.
- 4K source: capped at 1080p rendition (never upscale, never exceed
  ladder top).
- Portrait video: height-based ladder still correct.
- Partial upload of outputs then task dies: redelivery re-runs fully;
  same keys overwrite. Ensure no stale `master.m3u8` referencing a
  different rendition set can survive: upload master playlist LAST.
- Disk full (2 GB source + ~2-3 GB outputs in 21 GB): fine; assert temp
  cleanup in a finally-block.

## Security considerations
- ffmpeg command args are fully server-constructed — no user-controlled
  string ever reaches the shell (spawn with arg arrays, never string
  interpolation into a shell).
- Same IAM matrix as 011, asserted.

## Tests
- Unit: rendition-filter table (2160p→3, 1080p→3, 480p→[360p],
  240p→[source]); no-audio handling; corrupt → TerminalJobError.
- Integration (local container, dev queue): reference video → validate
  master playlist parses (parse with `m3u8-parser` or ffprobe each
  variant), correct rendition set, all segments present, master uploaded
  after segments (check timestamps or log order).
- Duration guard: assert job reports duration metric (EMF) for 015.

## Acceptance criteria
1. Reference upload through the UI → READY (thumbnail 011 + transcode
   both DONE), master playlist + expected renditions in output bucket.
2. Master playlist plays in Safari natively (quick manual check — Safari
   does HLS without hls.js).
3. Corrupt file → FAILED with error on record; queue clean; DLQ empty.
4. Force-kill a task mid-transcode (stop task in console) → message
   redelivers → job completes on retry → exactly one consistent output
   tree.
5. Idle → 0 tasks for both worker services.

## Out of scope
- Multi-codec (AV1/HEVC), per-title ladders, DRM, captions/subtitles,
  quality-based bitrate tuning beyond the fixed ladder.
