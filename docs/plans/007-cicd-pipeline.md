# 007 — CI/CD (CodeBuild + CodeDeploy)

## Manual setup required BEFORE starting
1. 006 complete: web service running on ECS via bootstrap image.
2. **GitHub connection (you, in the console, ~3 min):** after the agent
   deploys `CiStack`, the CodeConnections connection starts in `PENDING`.
   You must open the console → Developer Tools → Connections → *Update
   pending connection* → complete the GitHub OAuth handshake. The pipeline
   cannot run until the connection is `AVAILABLE`. Agent must verify state
   via CLI and stop to prompt you.
3. Repo is `https://github.com/ogc-edu/clipper` — set `github:
   { owner: 'ogc-edu', repo: 'clipper', branch: 'main' }` in
   `infra/config.ts`.
4. Trigger the **first** pipeline run manually (console or
   `aws codepipeline start-pipeline-execution`) to prove it; after that
   every push to `main` auto-triggers.

## Objective
Push to `main` → lint/typecheck/test → build & push both Docker images →
`prisma migrate deploy` → infra `cdk deploy` → web deployed blue/green via
CodeDeploy with automatic rollback; worker services (when they exist,
011/012) updated via rolling deployment.

## Context
ARCHITECTURE §9. The user explicitly wants CI/CD live before feature
code lands, so everything after 007 ships through the pipeline. Web uses
CodeDeploy blue/green (their stated service list + zero-downtime proof);
workers are stateless so ECS rolling is correct there. The pipeline
deploys infra via CDK, keeping one deployment path for everything.

## Requirements
1. Convert web service to CodeDeploy (in `ComputeStack`, done by this
   feature):
   - `deploymentController: { type: 'CODE_DEPLOY' }` on the web service.
   - ALB: production listener (:80) + test listener (:8080); two target
     groups (blue/green).
   - CodeDeploy application + deployment group (ECS): prod listener routes
     traffic, test listener for pre-prod validation; config
     `TimeBasedCanary` or all-at-once with 5-min bake — pick
     `CodeDeployDefault.ECSAllAtOnce` + `terminationWaitTime: 5` for dev
     speed, document the prod alternative.
   - Auto-rollback: on deployment failure and on a CloudWatch alarm
     (ALB 5xx alarm — add it).
2. `CiStack`:
   - CodeConnections connection + `codepipeline.Pipeline` (v2): Source
     (GitHub via connection, branch `main`) → Build (CodeBuild) → Deploy
     (CodeDeploy ECS for web; CodeBuild step for workers).
   - CodeBuild project: privileged (docker), compute small, image
     `aws/codebuild/standard:7.0`, cache pnpm store.
   - Artifact bucket (name from config, block public access).
3. `buildspec.yml` phases:
   - install: pnpm fetch/install (cached).
   - pre_build: lint, typecheck, unit tests (fail fast).
   - build: `next build` for web; `docker build` + push web image tagged
     `web-$CODEBUILD_RESOLVED_SOURCE_VERSION` **and** `web-latest`;
     same for worker (`worker-*`) — worker image build must tolerate
     `apps/worker` being a placeholder (it is, until 009).
   - post_build:
     a. Run DB migrations: one-off ECS task override
        (`pnpm db:deploy`), wait for completion, fail pipeline on
        non-zero exit (script `ci/run-migrations.sh`).
     b. `cdk deploy --require-approval never` (infra self-updates).
     c. Write `imagedefinitions.json` (web) → CodeDeploy action input.
     d. If worker services exist (describe-services check), trigger
        rolling `force-new-deployment` (script `ci/deploy-workers.sh`).
4. CDK assertion tests: pipeline stages ordered, connection ARN from
   config, artifact bucket private, CodeDeploy resources wired to the
   right listeners/target groups.
5. README runbook: how to watch a deployment, how to roll back manually,
   where build logs live.

## Files/components likely affected
- New: `infra/lib/ci-stack.ts`, `infra/test/ci-stack.test.ts`,
  `buildspec.yml`, `ci/run-migrations.sh`, `ci/deploy-workers.sh`;
  edits: `infra/lib/compute-stack.ts` (CodeDeploy conversion, listeners,
  5xx alarm), `infra/bin/infra.ts`, `infra/config.ts` (github
  owner/repo/branch), README.

## API changes
None.

## Database changes
None (but the pipeline now *runs* migrations — ordering matters: migrate
before web deploy).

## Dependencies
- 006.

## Edge cases
- `cdk deploy` inside the pipeline must be idempotent with your local
  deploys — same stack names from `config.ts`; document "don't edit
  resources in the console."
- CodeDeploy conversion of an existing ECS service requires replacing the
  service (deployment controller is immutable): expect one brief
  recreation during this feature's deploy; do it while nothing depends on
  the app. Call this out to the user before deploying.
- Buildspec must not fail when worker ECR image is pushed but no worker
  service exists yet (check before update).
- Migration task failure must block deploy — never deploy app code ahead
  of its schema.
- Pipeline role: least-privilege is genuinely hard here (it deploys CDK) —
  accept broad deploy permissions in dev, document the risk + the
  production hardening path (separate deploy role, permission boundaries).

## Security considerations
- No GitHub tokens in code or env — connection ARN only, in config.
- Build artifacts/logs contain no secrets (verify env masking on).
- CodeBuild role: ECR push, ECS update, SecretsManager read limited to
  app secrets, CloudFormation via CDK role assumption.

## Tests
- CDK assertions above.
- Real end-to-end test is the acceptance criteria (a live pipeline).

## Acceptance criteria
1. Connection `AVAILABLE` (manual OAuth done).
2. First manual pipeline run: green end-to-end, web service healthy.
3. Trivial commit (README typo) → auto-triggered → reaches production
   hands-free.
4. Rollback proof: commit breaking `/api/health` (test listener or
   post-shift alarm) → CodeDeploy rolls back automatically; service never
   serves broken version on prod listener. Revert commit; green again.
5. `git log` + pipeline history shown in README screenshot/notes as the
   working record.

## Out of scope
- Staging/prod multi-environment promotion, integration tests in the
  pipeline (016 adds e2e drills), Slack/email build notifications
  (nice-to-have; `ops-alerts` can be extended later), worker blue/green.
