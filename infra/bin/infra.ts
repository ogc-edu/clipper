#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { appConfig, loadSynthEnv } from "../config.js";
import { DatabaseStack } from "../lib/database-stack.js";
import { MessagingStack } from "../lib/messaging-stack.js";
import { NetworkStack } from "../lib/network-stack.js";
import { StorageStack } from "../lib/storage-stack.js";

// Fail fast before any resource is created. `CDK_DEFAULT_ACCOUNT` and
// `OPS_ALERTS_EMAIL` live only in the operator's shell (docs/RUNBOOK.md).
const synthEnv = loadSynthEnv();
const app = new cdk.App();
const env: cdk.Environment = {
  account: synthEnv.account,
  region: synthEnv.region,
};

const network = new NetworkStack(app, "NetworkStack", {
  env,
  description:
    "Clipper network: 2-AZ VPC (no NAT), S3/SQS/SecretsManager/Logs VPC endpoints, app security group.",
  appConfig,
});

new DatabaseStack(app, "DatabaseStack", {
  env,
  description:
    "Clipper database: private single-AZ PostgreSQL 16 with credentials in Secrets Manager.",
  appConfig,
  vpc: network.vpc,
  appSecurityGroup: network.appSecurityGroup,
});

const storage = new StorageStack(app, "StorageStack", {
  env,
  description: "Clipper storage: private uploads and output S3 buckets.",
  appConfig,
});

new MessagingStack(app, "MessagingStack", {
  env,
  description:
    "Clipper messaging: S3→SNS→SQS fan-out, per-queue DLQs, and DLQ ops alarms.",
  appConfig,
  uploadsBucket: storage.uploadsBucket,
  opsAlertsEmail: synthEnv.opsAlertsEmail,
});
