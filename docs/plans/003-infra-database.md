# 003 — Infra: database (RDS PostgreSQL)

## Manual setup required BEFORE starting
- None beyond 002's credentials. (Choose the DB name and instance class in
  `infra/config.ts` — default `db.t4g.micro`, database name `clipper`.)

## Objective
Provision a private PostgreSQL instance whose master credentials live only
in Secrets Manager, reachable solely from the application security group.

## Context
ARCHITECTURE §2.3. The web/API tasks are the only DB clients (D3). The
schema itself is feature 004 — this feature is infrastructure only.

## Requirements
1. `DataStack` in the CDK app:
   - `rds.DatabaseInstance`, PostgreSQL 16, single-AZ, class/db name from
     config, storage 20 GB gp3, private subnets only, `publiclyAccessible:
     false`.
   - Credentials: CDK-generated secret in Secrets Manager
     (`Credentials.fromGeneratedSecret('clipper_db_admin')`) — never
     hardcoded, never in plaintext output.
   - Security group: ingress 5432 **only** from the app SG exported by
     NetworkStack (002).
   - Deletion protection off + `RemovalPolicy.DESTROY` behind the same
     `envName === 'dev'` flag as 002; no final snapshot in dev.
   - Automated backups: retention 1 day (dev) — enough to matter, cheap.
2. Stack outputs: secret ARN, endpoint address/port, DB name (as CfnOutput;
   also written into `infra/config.ts`-adjacent outputs file for later
   stacks).
3. Assertion tests: not publicly accessible, secret exists, SG rule
   references app SG only.

## Files/components likely affected
- New: `infra/lib/data-stack.ts`, `infra/test/data-stack.test.ts`;
  edits: `infra/bin/infra.ts` (add stack), `infra/config.ts` (db config).

## API changes
None.

## Database changes
The instance only. Tables arrive in 004.

## Dependencies
- 002 (VPC, app SG, CDK patterns).

## Edge cases
- Don't expose the endpoint publicly "temporarily" — verification happens
  from inside the VPC.
- Secret rotation: leave disabled in dev (note in plan; enabling is a
  one-line change for prod later).

## Security considerations
- No security group rule for 0.0.0.0/0 anywhere in this stack.
- Secret is the *only* copy of the password; the plan must not print it.
  Verification instructions use `aws secretsmanager get-secret-value`
  locally, never committed output.

## Tests
- CDK assertion tests (above).
- Manual verification (documented in runbook, agent walks user through):
  run a throwaway ECS Fargate task or EC2 instance connect endpoint in the
  VPC with `psql`, connect using credentials pulled from Secrets Manager.
  Simplest: wait until 006's service exists and `psql` via ECS Exec — if
  so, mark verification as deferred to 006 acceptance.

## Acceptance criteria
1. `cdk deploy` green; instance `available`.
2. Secret retrievable from Secrets Manager; contains working credentials.
3. Connection from inside VPC succeeds; any public connection path absent
   (no public IP, SG restrictive).
4. Assertion tests pass.

## Out of scope
- Schema/tables/Prisma (004), migration task wiring (006), read replicas,
  multi-AZ, rotation.
