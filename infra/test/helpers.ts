import * as cdk from "aws-cdk-lib";
import { appConfig } from "../config.js";

/** A fixed, fake environment so synthesized templates are deterministic. */
export const testEnv: cdk.Environment = {
  account: "123456789012",
  region: appConfig.region,
};

/** Placeholder ops address; the real one only ever lives in the shell. */
export const testOpsAlertsEmail = "ops@example.com";
