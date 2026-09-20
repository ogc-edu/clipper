# 013 — Library & status UI

## Manual setup required BEFORE starting
- None.

## Objective
The user's real experience: a library of their videos and a per-video
status bar that reflects live processing state without manual refresh.

## Context
PRD §5.3, FR-4. Reads only 010's endpoints. Keep styling minimal
(Tailwind from create-next-app) — this is a functional dashboard, not a
design exercise. Playback page itself is 014; this feature links to it
behind a state check (link disabled unless READY).

## Requirements
1. `/` (library, signed-in):
   - Server-component fetch of `GET /api/videos`; empty state
   ("Upload your first video"); each card: filename, state badge,
   thumbnail img if `thumbnailKey` + READY (via 014's playback cookies —
   until 014 lands, render a placeholder box; wire behind a feature
   constant so 014 only flips it).
   - Cards link to `/videos/[id]`.
2. `/videos/[id]` (detail):
   - Client component polling `GET /api/videos/:id/status` every 3s while
   any job is PENDING/RUNNING or overall is UPLOADING/QUEUED/PROCESSING;
     stop polling on READY/FAILED (and after 30 min, with a "refresh"
     affordance).
   - Status bar: overall state + one row per job (TRANSCODE, THUMBNAIL)
     with icon per state (pending/running/done/failed), `attempts`
     shown when > 1, error text on FAILED.
   - READY → "Play" button linking to `/videos/[id]/play` (stub page
     until 014: shows master playlist URL fetched from the playback
     endpoint if available, else placeholder).
   - FAILED → clear banner + per-job error detail.
3. Polling hygiene: `document.visibilityState` — pause polling when tab
   hidden; single in-flight request (no overlap on slow networks);
   404 → redirect to library (deleted/foreign id).
4. Sign-out and signed-in-user display in a small header across pages.

## Files/components likely affected
- New: `apps/web/app/page.tsx` (replace placeholder),
  `apps/web/app/videos/[id]/page.tsx`, `apps/web/components/StatusBar.tsx`,
  `apps/web/components/VideoCard.tsx`, `apps/web/lib/usePoll.ts`;
  edits: `apps/web/app/upload/page.tsx` (route to detail on success),
  root layout (header).

## API changes
None.

## Database changes
None.

## Dependencies
- 010 (endpoints), 008 (upload entry point exists). 012 for the full
  happy path but can ship before it.

## Edge cases
- Poll during deploy (ALB brief 502): retry silently, don't kill the
  polling loop on transient 5xx (backoff 3s→10s→30s cap).
- State flapping: server is authoritative; render exactly what it says.
- Long filenames: truncate middle, keep extension visible.
- Direct visit to a foreign video id: 404 handling → library redirect.

## Security considerations
- All fetches same-origin; no tokens client-side (cookie session).
- Render error text as text (React escaping); job errors contain ffmpeg
  output — ensure no HTML injection path (React default suffices; don't
  use dangerouslySetInnerHTML).

## Tests
- Component tests (vitest + testing-library): state badge matrix, poll
  stops on terminal states, backoff on 5xx, visibility pause.
- Route handlers mocked at fetch boundary (msw).

## Acceptance criteria
1. Upload → land on detail → watch UPLOADING→QUEUED→PROCESSING→READY
   with zero refreshes (both job rows flipping independently).
2. Corrupt upload → FAILED banner with the worker's error message.
3. Tab hidden 5 min → no request storm (verify in network tab).
4. Non-owner URL visit → redirect, no data leaked.

## Out of scope
- The player (014), admin page (015), design system, skeleton loaders
  beyond basic spinners.
