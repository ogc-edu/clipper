# 002 — Infra: network, storage & messaging (CDK)

## Manual setup required BEFORE starting
1. AWS account access: IAM user/role credentials configured for the AWS
   CLI (`aws sts get-caller-identity` must succeed). Sufficient privileges
   for CDK (AdministratorAccess is acceptable for a personal dev account).
2. `cdk bootstrap aws://ACCOUNT/REGION` run once (agent can run it with
   your credentials — confirm before it does).
3. **You choose every resource name**: fill `infra/config.ts` (bucket
   names must be globally unique; pick queue/topic/log-group names).
4. Pick region (single region for Part A) and your ops email address —
   both go in `infra/config.ts`.

## Manual setup required AFTER deploy
- Open the SNS `ops-alerts` confirmation email and click **Confirm
  subscription**. DLQ alarms are silent until you do.

## Objective
Stand up the network, storage, and messaging backbone so that dropping a
file into the uploads bucket delivers the raw S3 event to both SQS queues —
with no application code involved.

## Context
Per ARCHITECTURE §2.3–2.4 and D1: S3 events flow raw through SNS→SQS
(`rawMessageDelivery: true`); workers parse them. All names come from
`infra/config.ts` — never CDK auto-names. This is the first real CDK code,
so it also establishes stack layout and testing patterns
(`aws-cdk-lib/assertions`).

## Requirements
1. `infra/` CDK app (TypeScript), stacks: `NetworkStack`, `StorageStack`,
   `MessagingStack`. Environment (account/region) from `config.ts`.
2. `infra/config.ts` exports a typed const: region, bucket names, queue
   names, topic names, ops email, app domain placeholder (used later for
   CORS/callbacks; default `http://localhost:3000`).
3. NetworkStack: VPC (2 AZ, public + private subnets, 1 NAT gateway —
   note cost in plan output), `appSg` security group (exported for web
   tasks later).
4. StorageStack:
   - Uploads bucket: block all public access, CORS allowing PUT from the
     app origin (config), lifecycle: expire objects after 7 days,
     server-side encryption (S3-managed).
   - Output bucket: block all public access, no CORS, no lifecycle.
5. MessagingStack:
   - SNS topic `video-uploaded` (name from config).
   - SQS `transcode-queue` (visibility 900s) + `transcode-dlq`
     (redrive maxReceiveCount 3); `thumbnail-queue` (visibility 120s) +
     `thumbnail-dlq` (same redrive). Retention 4 days on main queues,
     14 days on DLQs.
   - SNS subscriptions to both queues with `rawMessageDelivery: true`.
   - Topic policy allowing `s3.amazonaws.com` Publish from the uploads
     bucket ARN; queue policies allowing the topic to SendMessage.
   - Uploads bucket notification → topic, filter prefix `uploads/`.
   - SNS topic `ops-alerts` with email subscription (address from config).
   - CloudWatch alarms: `ApproximateNumberOfMessagesVisible ≥ 1` for 1
     period (5 min) on each DLQ → publish to `ops-alerts`.
6. CDK outputs: bucket names, topic ARN, queue URLs (for later stacks).
7. Unit tests with `aws-cdk-lib/assertions`: buckets block public access,
   redrive policies present, subscriptions raw, alarm actions set,
   resource names match config exactly.

## Files/components likely affected
- New: `infra/bin/infra.ts`, `infra/lib/network-stack.ts`,
  `infra/lib/storage-stack.ts`, `infra/lib/messaging-stack.ts`,
  `infra/config.ts`, `infra/cdk.json`, `infra/test/*.test.ts`,
  root `package.json` scripts (`pnpm cdk:synth`, `pnpm cdk:deploy`).

## API changes
None.

## Database changes
None.

## Dependencies
- 001 (repo scaffold, shared TS config).

## Edge cases
- Bucket name collision: if deploy fails on name taken, that's the user's
  signal to change `config.ts` — do NOT work around with suffixes.
- `rawMessageDelivery` must be true or the worker parser (001) receives
  an SNS envelope — assert it in tests.
- Destroy-safety: buckets need `RemovalPolicy.DESTROY` + `autoDeleteObjects`
  in dev so `cdk destroy` works; add a config flag `envName: 'dev'` so
  this is a deliberate, visible choice (prod would flip to RETAIN).
- SNS→SQS cross-resource policies: deploy order matters; CDK handles it
  via dependencies — don't create circular deps between stacks
  (notification wiring lives in MessagingStack, which imports the bucket).

## Security considerations
- Output bucket: `blockPublicAccess: BLOCK_ALL`, enforce SSL
  (`enforceSSL: true`) on both buckets.
- Topic policy scoped to the one bucket ARN, not `s3.amazonaws.com` broadly
  with no condition.
- No public endpoints created in this feature.

## Tests
- Assertion tests as above (run in `pnpm test` / CI).
- Manual verification script (`infra/scripts/verify-messaging.sh`):
  `aws s3 cp` a dummy file to `uploads/test/{uuid}/source`, then
  `aws sqs receive-message` on both queues and print bodies.

## Acceptance criteria
1. `cdk synth` clean; `cdk deploy` green with config-defined names.
2. Verification script shows the same S3 event in both queues.
3. Both buckets deny any public access (console/CLI check).
4. Force-redrive: move a message to a DLQ
   (`aws sqs` receive/delete games or console "start DLQ redrive" reversed)
   — simplest: set redrive to 1 temporarily or use console to move — alarm
   fires and email arrives (after subscription confirmed).
5. `cdk destroy` removes everything cleanly (proves no manual resources
  snuck in). Redeploy after.

## Out of scope
- RDS, Cognito, ECS, CloudFront, CI/CD, any application code.
