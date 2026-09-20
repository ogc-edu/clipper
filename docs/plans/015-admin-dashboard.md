# 015 — Admin dashboard

## Manual setup required BEFORE starting
- None (your Cognito user is already in the `admin` group from 005).

## Objective
The admin page shows how the processing *system* performs: queue depths
and age, DLQ counts, running worker tasks, job durations/failures, and
stuck jobs — auto-refreshing.

## Context
PRD FR-6; ARCHITECTURE §8. Data sources: CloudWatch (SQS/ECS metrics +
the workers' EMF `JobDuration`/`JobFailure`) and RDS (stuck/old jobs).
`requireAdmin` exists from 005. Keep the page server-simple: one JSON
endpoint + a client component polling it.

## Requirements
1. `GET /api/admin/metrics` (requireAdmin):
   - CloudWatch `GetMetricData` (last 1h, 5-min periods) for, per queue
     (transcode/thumbnail + DLQs): `ApproximateNumberOfMessagesVisible`,
     `ApproximateAgeOfOldestMessage`; per ECS service (web, thumbnail,
     transcode): running task count (`ECS/ContainerInsights` —
     **enable Container Insights on the cluster** in ComputeStack) or
     fallback `ECS` service `RunningTaskCount`.
   - EMF aggregates: `JobDuration` avg/p90 per mode (1h, 24h),
     `JobFailure` count per mode (24h).
   - RDS: counts by state; jobs RUNNING > 30 min ("stuck") with videoId +
     kind + age; FAILED count (24h).
   - Response shape: one typed JSON object (`AdminMetrics` in shared).
   - Latency budget: CloudWatch calls parallelized; endpoint < 2s warm.
2. `/admin` page: stat cards (queue depths, DLQ counts with red styling
   when > 0, running tasks), small tables (stuck jobs, recent failures),
   poll every 10s, visible "last updated" timestamp. Link in header shown
   only to admins (`/api/auth/me` groups claim).
3. Web task role: `cloudwatch:GetMetricData` (+ `ListMetrics` for
   debugging) — read-only, no resource wildcard concerns for GetMetricData
   (it doesn't support resource scoping — note in plan, acceptable).
4. Nav/UX: 403 page for non-admins hitting `/admin` directly.

## Files/components likely affected
- New: `apps/web/app/api/admin/metrics/route.ts`,
  `apps/web/app/admin/page.tsx`, `apps/web/components/MetricCard.tsx`,
  `packages/shared` (`AdminMetrics` type); edits:
  `infra/lib/compute-stack.ts` (Container Insights, task role),
  header component.

## API changes
- Adds `GET /api/admin/metrics`.

## Database changes
None (read-only queries).

## Dependencies
- 011, 012 (worker services + EMF metrics exist), 005 (admin group).

## Edge cases
- Empty system (no jobs yet): metrics APIs return empty series — render
  zeros, never crash on missing datapoints.
- Container Insights cost note in plan (~small; flag to user it's
  enabled).
- Clock: all timestamps rendered relative ("3m ago") with absolute
  tooltip.

## Security considerations
- Endpoint strictly `requireAdmin`; test non-admin → 403 and anon → 401.
- Stuck-job table shows videoIds to admins only — acceptable (admins are
  operators); no user content exposed beyond ids/states.

## Tests
- Unit: CloudWatch client mocked — response assembly, empty-series
  handling, auth matrix; stuck-job SQL/Prisma query against compose DB.
- Component: red DLQ card rendering when count > 0.

## Acceptance criteria
1. Side-by-side with the AWS console during a live upload: queue depths,
   task counts, and durations match reality.
2. Force a message into a DLQ → card turns red on next poll; ops email
   also arrives (002 wiring still intact).
3. Non-admin user → 403 on API and `/admin`.
4. Page refreshes without user action; no request stacking.

## Out of scope
- Charts/graphs (tables + numbers suffice Part A), alerting config UI,
  per-user admin views, log viewer.
