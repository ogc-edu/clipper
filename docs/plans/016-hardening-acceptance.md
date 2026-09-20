# 016 — Hardening & acceptance verification

## Manual setup required BEFORE starting
- Everything else complete. Set aside ~2 hours; several drills need your
  eyes on email/console. You co-sign the acceptance checklist.

## Objective
Prove every PRD §9 acceptance criterion in writing, close the known gaps,
and leave the project in a state where `cdk deploy` from a fresh clone
rebuilds the world.

## Context
This feature writes no product code unless a drill exposes a defect —
defects found here are reported and fixed in their owning feature's code
(with tests), not patched ad hoc. Per the skill rules: if a drill reveals
an *architectural* problem, stop and report rather than redesigning.

## Requirements

### Drill 1 — Fresh-environment rebuild
1. `cdk destroy` the full dev environment (confirm buckets empty first —
   note the auto-delete behavior) or deploy to a parallel stack set.
2. From a clean clone: `pnpm install`, fill `infra/config.ts`,
   `cdk deploy --all`, run 006's bootstrap script, let the pipeline
   deploy the rest.
3. Document every manual step actually required; any step not already in
   the IMPLEMENTATION_PLAN ledger gets added to it.

### Drill 2 — Failure paths
1. Upload a corrupt file (renamed .txt → .mp4): expect FAILED record with
   ffmpeg error, clean queues, **both DLQs empty** (terminal path).
2. Force a redrive failure (e.g., temporarily point a worker at a bad
   queue or send a message with a validly-shaped but nonexistent
   uploadKey referencing a deleted object — worker takes terminal path…
   for a true DLQ test: publish a message that parses but whose
   processing throws transiently — use a feature-flag env on the worker
   or a malformed-but-parseable fixture; simplest honest method: send a
   raw message with `uploadKey` pointing at an existing object owned by
   no video record — callback 404s → per 009 that's terminal-report…
   — **decision:** add a temporary env `CHAOS_FAIL_TRANSIENT=1` to the
   thumbnail task, send one message, watch it redrive ×3 → DLQ → alarm →
   email; then remove the flag. Document as the repeatable chaos knob.)
3. Kill a transcode task mid-job (console stop): redelivery → eventual
   READY; verify single consistent output tree.

### Drill 3 — Scale & cost
1. Soak: no uploads for 24h (or compress: 2h + metric history) → both
   worker services at 0 tasks; capture billing snapshot.
2. Burst: 5 concurrent uploads → observe scale-out, all five READY, queue
   drain.

### Drill 4 — Security spot checks
1. Direct S3 GET on output objects → 403. CloudFront without cookies →
   403. Foreign video status/playback → 404.
2. Oversized upload against the presigned policy → S3 403.
3. `/api/internal/*` from internet → 404 (010's rule).
4. `aws iam` access-analyzer or manual review of the four task roles
   against the ARCHITECTURE §6 matrix — table the results.

### Drill 5 — Acceptance checklist sign-off
- Walk PRD §9 item by item; write `docs/ACCEPTANCE.md` with
  pass/fail + evidence (screenshots, CLI output, metric graphs).
- Any fail → bug filed, fixed in owning code, drill re-run.

## Files/components likely affected
- New: `docs/ACCEPTANCE.md`, optional `CHAOS_FAIL_TRANSIENT` knob in
  worker (few lines, env-gated); edits: whatever defects the drills find
  (with regression tests), `docs/IMPLEMENTATION_PLAN.md` ledger if new
  manual steps surfaced.

## API changes
None (chaos knob is internal to the worker).

## Database changes
None.

## Dependencies
- All features 001–015.

## Edge cases
- Destroy ordering: pipeline deploys infra — destroy the CiStack LAST and
  expect to empty ECR/artifact buckets; document the exact destroy
  sequence that works.
- Don't leave the chaos flag enabled — drill checklist includes reverting
  it, and a test asserts the env var is absent in the deployed task
  definition at the end.

## Security considerations
- This feature *is* the security verification; results tabled in
  ACCEPTANCE.md including any accepted risks (e.g., HTTP-only ALB,
  pipeline role breadth) with their Part-B remediation notes.

## Tests
- Regression tests for every defect found.
- A `pnpm verify:env` script (CLI smoke: queues exist, buckets private,
  services healthy, alarms configured) that can be re-run any time.

## Acceptance criteria
1. `docs/ACCEPTANCE.md` signed: all PRD §9 items pass with evidence.
2. `pnpm verify:env` green on the rebuilt environment.
3. Ledger in IMPLEMENTATION_PLAN matches reality exactly.

## Out of scope
- Load testing beyond the 5-upload burst, chaos engineering beyond the
  documented knob, multi-region, prod hardening (Part B).
