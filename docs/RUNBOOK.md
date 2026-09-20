# Clipper Runbook — Infrastructure (feature 002)

Operational commands for the network, storage, and messaging backbone.
Everything here is provisioned by CDK; **never create these resources in
the AWS console.**

- Region: **ap-southeast-1** (hardcoded in `infra/config.ts`)
- Stacks: `NetworkStack`, `StorageStack`, `MessagingStack`
- All physical resource names come from `infra/config.ts`.

---

## 1. Prerequisites

- AWS CLI configured with credentials for the target account
  (`aws sts get-caller-identity` succeeds).
- Node ≥ 20 and pnpm installed; `pnpm install` run at the repo root.
- CDK CLI: `cdk --version` (install with `npm i -g aws-cdk` if missing).

### Required shell variables (never committed)

`infra/bin/infra.ts` fails fast at synth if these are unset or invalid:

| Variable | Meaning |
|---|---|
| `CDK_DEFAULT_ACCOUNT` | 12-digit AWS account id that owns the stacks |
| `OPS_ALERTS_EMAIL` | Recipient of DLQ alarm emails (SNS email subscription) |

Export them once per shell. `.env.example` is the placeholder template;
do **not** commit a real address.

```bash
export CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
export OPS_ALERTS_EMAIL="you@example.com"
```

---

## 2. Bootstrap (once per account/region)

```bash
cdk bootstrap "aws://${CDK_DEFAULT_ACCOUNT}/ap-southeast-1"
```

Verify the `CDKToolkit` stack appears:

```bash
aws cloudformation describe-stacks --region ap-southeast-1 \
  --stack-name CDKToolkit --query 'Stacks[0].StackStatus' --output text
```

---

## 3. Synth & deploy

```bash
pnpm install
pnpm cdk:synth                       # template review, no AWS changes
pnpm cdk:deploy                      # deploys all three stacks
```

`pnpm cdk:deploy` maps to `cdk deploy --all --require-approval never`.
Deploy order is handled by CDK: `MessagingStack` (topics/queues/alarms)
before `StorageStack` (the bucket notification imports the topic ARN).

### After deploy — confirm the email subscription (required)

Open the `AWS Notification - Subscription Confirmation` email sent by SNS
to `OPS_ALERTS_EMAIL` (check spam) and click **Confirm subscription**.
Until then, DLQ alarms publish but no email is delivered.

Confirm from the CLI:

```bash
aws sns list-subscriptions-by-topic --region ap-southeast-1 \
  --topic-arn "$(aws sns list-topics --region ap-southeast-1 \
    --query "Topics[?ends_with(TopicArn, ':clipper-ops-alerts')].TopicArn | [0]" \
    --output text)"
```

The subscription `SubscriptionArn` must not be `PendingConfirmation`.

---

## 4. Fan-out acceptance test

Dropping any object under `uploads/` must deliver the **raw** S3 event to
both queues. The helper script uploads one object and polls both queues,
returning each message to its queue afterwards.

```bash
infra/scripts/verify-messaging.sh
# or pin the owner/video id:
infra/scripts/verify-messaging.sh test-sub 11111111-1111-4111-8111-111111111111
```

Manual equivalent:

```bash
REGION=ap-southeast-1
BUCKET=clipper-ogc-raw
VIDEO_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
KEY="uploads/test-sub/${VIDEO_ID}/source"

echo "hello clipper" > /tmp/source
aws s3 cp /tmp/source "s3://${BUCKET}/${KEY}" --region "$REGION"

# Both should print the same raw S3 ObjectCreated JSON (no SNS envelope).
aws sqs receive-message --region "$REGION" \
  --queue-url "$(aws sqs get-queue-url --region "$REGION" \
    --queue-name clipper-transcode-queue --query QueueUrl --output text)" \
  --wait-time-seconds 10 --query 'Messages[0].Body' --output text

aws sqs receive-message --region "$REGION" \
  --queue-url "$(aws sqs get-queue-url --region "$REGION" \
    --queue-name clipper-thumbnail-queue --query QueueUrl --output text)" \
  --wait-time-seconds 10 --query 'Messages[0].Body' --output text
```

Expected body shape (raw, matching `packages/shared/src/s3-event.ts`):

```json
{
  "Records": [
    {
      "eventName": "ObjectCreated:Put",
      "s3": {
        "bucket": { "name": "clipper-ogc-raw" },
        "object": { "key": "uploads%2Ftest-sub%2F<uuid>%2Fsource" }
      }
    }
  ]
}
```

Return a received message to its queue without deleting it
(SQS does this automatically after the visibility timeout; to do it
immediately):

```bash
RECEIPT_HANDLE=$(aws sqs receive-message ... --query 'Messages[0].ReceiptHandle' --output text)
aws sqs change-message-visibility --region ap-southeast-1 \
  --queue-url "<queue-url>" --receipt-handle "$RECEIPT_HANDLE" \
  --visibility-timeout 0
```

---

## 5. DLQ alarms

Each DLQ has a CloudWatch alarm (`ApproximateNumberOfMessagesVisible ≥ 1`
for one 5-minute period) that publishes to `clipper-ops-alerts`, whose
email subscription pages the operator.

Inspect the alarms and their target:

```bash
aws cloudwatch describe-alarms --region ap-southeast-1 \
  --alarm-names clipper-transcode-dlq-not-empty clipper-thumbnail-dlq-not-empty \
  --query 'MetricAlarms[].{Name:AlarmName,Actions:AlarmActions,Metric:MetricName,Threshold:Threshold,Comparison:ComparisonOperator}'
```

### Force a DLQ + alarm drill

The fastest deterministic way is to send a message straight to a DLQ:

```bash
aws sqs send-message --region ap-southeast-1 \
  --queue-url "$(aws sqs get-queue-url --region ap-southeast-1 \
    --queue-name clipper-transcode-dlq --query QueueUrl --output text)" \
  --message-body '{"drill":"feature-002"}'
```

Within ~5 minutes the alarm transitions to `ALARM`, SNS publishes, and the
confirmed email subscription receives a notification. Purge afterwards:

```bash
aws sqs purge-queue --region ap-southeast-1 \
  --queue-url "$(aws sqs get-queue-url --region ap-southeast-1 \
    --queue-name clipper-transcode-dlq --query QueueUrl --output text)"
```

---

## 6. Destroy

`envName: "dev"` sets both buckets to `RemovalPolicy.DESTROY` with
`autoDeleteObjects`, so teardown is clean.

```bash
pnpm cdk:destroy
```

Then confirm no Clipper stacks remain:

```bash
aws cloudformation list-stacks --region ap-southeast-1 \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query 'StackSummaries[].StackName'
```

---

## 7. Database (feature 003)

The `DatabaseStack` owns the Clipper record-of-truth PostgreSQL instance:

- PostgreSQL **16**, `db.t4g.micro`, single-AZ, 20 GB gp3, encrypted at rest.
- Private subnets only, `publiclyAccessible: false`; its security group
  accepts **tcp/5432 from the app security group only**.
- Master credentials are CDK-generated into Secrets Manager under
  `clipper/dev/db-credentials`. **Rotate the value, never print it.**
- In dev it is `RemovalPolicy.DESTROY` + `deleteAutomatedBackups` with
  deletion protection off; prod retains and protects it.

The schema/tables arrive in feature 004 — this stack is infrastructure only.

### 7.1 Stack outputs

| Output export | Meaning |
|---|---|
| `dev-clipper-db-secret-arn` | Secrets Manager ARN for master credentials |
| `dev-clipper-db-endpoint-address` | RDS writer endpoint hostname (private) |
| `dev-clipper-db-endpoint-port` | RDS writer endpoint port (5432) |
| `dev-clipper-db-name` | Logical DB name (`clipper`) |

```bash
aws cloudformation describe-stacks --region ap-southeast-1 \
  --stack-name DatabaseStack \
  --query 'Stacks[0].Outputs[].{Key:OutputKey,Value:OutputValue}'
```

### 7.2 Reading the secret (never logs the value)

```bash
SECRET_ID=clipper/dev/db-credentials
aws secretsmanager get-secret-value --region ap-southeast-1 \
  --secret-id "$SECRET_ID" --query SecretString --output text > /tmp/db-cred.json
python3 -c "import json;d=json.load(open('/tmp/db-cred.json'));print(sorted(d))"  # keys only
rm -f /tmp/db-cred.json
```

Do **not** paste the value into a shell history, ticket, or report; redact it
if it must be shown. The RDS `SecretTargetAttachment` adds `host`, `port`,
`dbname`, and `engine` to the generated `username`/`password`.

### 7.3 In-VPC connectivity — acceptance **deferred to 006**

There is no jump box in feature 003 (zero NAT, private-only DB), so the
connection proof is deferred to feature 006's ECS Exec shell. The exact
procedure once the web service is running (`/api/health/db` is the cheap
alternative proof):

```bash
REGION=ap-southeast-1
CLUSTER=clipper-cluster          # ComputeStack name from 006
SERVICE=clipper-web              # web service from 006

# 1. Pick a running web task (must have enableExecuteCommand: true).
TASK_ARN=$(aws ecs list-tasks --region "$REGION" \
  --cluster "$CLUSTER" --service-name "$SERVICE" \
  --query 'taskArns[0]' --output text)

# 2. Open an interactive shell in the app container.
aws ecs execute-command --region "$REGION" \
  --cluster "$CLUSTER" --task "$TASK_ARN" --container web \
  --interactive --command "/bin/sh"
```

Inside the container (`DATABASE_URL` is injected from Secrets Manager in 006):

```sh
# node:20-alpine runner does not ship psql; install the v16 client once.
apk add --no-cache postgresql16-client
psql "$DATABASE_URL" -c 'select version();'
psql "$DATABASE_URL" -c '\conninfo'
```

A successful `select version()` showing PostgreSQL 16 (from inside the VPC,
with no public path to the instance) closes acceptance criterion 3 of the
003 plan. Optionally verify the runner host cannot reach the DB from outside
the VPC:

```bash
# From a workstation (expected: connection times out / refused).
pg_isready -h "$(aws cloudformation describe-stacks --region ap-southeast-1 \
  --stack-name DatabaseStack \
  --query 'Stacks[0].Outputs[?OutputKey==`DatabaseEndpointAddress`].OutputValue' \
  --output text)" -p 5432
```

---

## 8. Manual setup ledger (from `docs/IMPLEMENTATION_PLAN.md`)

| When | Action |
|---|---|
| Before 002 | AWS credentials configured; run `cdk bootstrap` |
| Before 002 deploy | Export `CDK_DEFAULT_ACCOUNT` and `OPS_ALERTS_EMAIL` |
| After 002 deploy | Click the confirmation link in the SNS `ops-alerts` email |
| Before 003 | None — reuses 002's VPC and app security group |

Later features own their own manual steps (Cognito admin user in 005,
first ECR image push in 006, GitHub connection handshake in 007,
CloudFront signing key in 014).
