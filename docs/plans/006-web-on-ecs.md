# 006 — Web service on ECS (walking skeleton)

## Manual setup required BEFORE starting
1. 003, 004, 005 complete (DB exists, schema migratable, auth works
   locally).
2. **One-time image bootstrap** (chicken-and-egg: the Fargate service
   can't start before an image exists in ECR — the pipeline takes over in
   007): after the agent builds the Dockerfile, you run once:
   ```bash
   aws ecr get-login-password | docker login --username AWS --password-stdin <acct>.dkr.ecr.<region>.amazonaws.com
   docker build -t <web-repo-uri>:bootstrap apps/web  # from repo root if context requires
   docker push <web-repo-uri>:bootstrap
   ```
   (Agent: script this as `infra/scripts/bootstrap-image.sh`; you only run it.)
3. Add the ALB origin to Cognito callback URLs — after deploy, when the
   ALB DNS name is known: update `infra/config.ts` `appOrigins` with the
   ALB URL and redeploy (AuthStack picks it up). Agent must prompt you.

## Objective
The Next.js app runs on ECS Fargate behind a public ALB, talking to RDS
with credentials from Secrets Manager, with auth working through the ALB —
a fully wired but feature-empty production shape.

## Context
ARCHITECTURE §2.1, §6. This is the first ComputeStack; CI/CD (007) will
build on it immediately, so keep deployment-Controller default (ECS
rolling) here — CodeDeploy blue/green converts it in 007. Prisma
migrations run as a one-off task before service update (documented
command; automated in 007).

## Requirements
1. `apps/web/Dockerfile`: multi-stage — deps → build
   (`next build`, standalone output) → distroless-ish slim runner
   (node:20-alpine), non-root user, `PORT=3000`, healthcheck. Prisma:
   copy schema + generated client; run `prisma generate` at build.
   `.dockerignore` (node_modules, .next/cache).
2. `next.config`: `output: 'standalone'`.
3. `GET /api/health` route: returns 200 `{ok:true}` plus a cheap DB check
   (`SELECT 1`) at `/api/health/db` (ALB uses the shallow one).
4. `ComputeStack` (CDK):
   - ECR repositories: web + worker (names from config; lifecycle: keep
     last 10 images).
   - ECS cluster (Fargate).
   - ALB (internet-facing, HTTP :80 — note HTTPS/cert as Part B),
     target group, health check `/api/health`.
   - Fargate service: desired 2, 0.5 vCPU/1 GB tasks in private subnets,
     app SG (from 002); ALB SG allows :80 from anywhere, app SG allows
     3000 from ALB SG only.
   - Task env: from `packages/config` web schema — Cognito vars,
     `APP_ORIGIN` (ALB DNS), bucket names, `NODE_ENV=production`.
   - Task secrets (Secrets Manager injection): `DATABASE_URL` constructed
     from the RDS secret (003), `SESSION_SECRET` (user creates this secret
     — see manual steps; generate via script `scripts/create-secrets.sh`).
   - Task role: `secretsmanager:GetSecretValue` on exactly those two
     secrets; CloudWatch logs. (S3 presign permission arrives in 008.)
   - Log group `/ecs/clipper/web` (name from config), 2-week retention.
5. Migration runbook update: one-off task command
   (`aws ecs run-task` with overrides running `pnpm db:deploy`) executed
   before service deployment when migrations change; document exact CLI.
6. Update `SESSION_SECRET` handling: `scripts/create-secrets.sh` creates
   `clipper/session-secret` in Secrets Manager if absent (random 64B).

## Files/components likely affected
- New: `apps/web/Dockerfile`, `apps/web/.dockerignore`,
  `infra/lib/compute-stack.ts`, `infra/test/compute-stack.test.ts`,
  `infra/scripts/bootstrap-image.sh`, `scripts/create-secrets.sh`;
  edits: `apps/web/next.config.*`, `apps/web/app/api/health/route.ts`,
  `infra/bin/infra.ts`, `infra/config.ts`, runbook.

## API changes
- Adds `/api/health`, `/api/health/db` (both public — health must bypass
  auth middleware; add to middleware skip list).

## Database changes
- First real migrations run against RDS (via the one-off task).

## Dependencies
- 003 (RDS+secret), 004 (schema + migrate deploy), 005 (auth deployed).

## Edge cases
- Cold-start before migration: `/api/health/db` must fail cleanly (503),
  not crash the container — ALB health check uses `/api/health` (shallow)
  so the service still stabilizes.
- Standalone output + Prisma: ensure the engine binary and schema are
  copied into the runner stage (common breakage — test the image locally).
- Graceful shutdown: handle SIGTERM (Fargate sends it on deploy) — close
  HTTP server + Prisma before exit.

## Security considerations
- Task role has exactly two secret ARNs — no wildcard.
- App SG ingress: ALB SG only, port 3000 only.
- Container runs as non-root; no shell in final stage if practical.
- `/api/health/db` exposes no error detail beyond ok/fail.

## Tests
- CDK assertions: SG rules exact, task role policy scoped, desired count,
  health check path, log retention.
- Local: `docker build` + `docker run` with env → `/api/health` 200;
  sign-in redirect reachable.

## Acceptance criteria
1. Bootstrap image pushed (manual step) → `cdk deploy` → service stable,
   2/2 healthy.
2. ALB URL serves the app; full Cognito sign-in round trip through ALB.
3. `/api/health/db` returns ok after migration task runs.
4. New image (manual rebuild/push + `update-service
   --force-new-deployment`) rolls without downtime.
5. Deferred 003 verification closes here: `psql` via ECS Exec or app DB
   health proves RDS connectivity.

## Out of scope
- CodeDeploy/blue/green (007), HTTPS + custom domain (Part B), upload
  API, autoscaling policies (defaults fine for dev; CPU target tracking is
  acceptable if trivial to add).
