import { z } from "zod";

/**
 * Every resource Clipper provisions with an explicit, user-chosen physical
 * name. Per `docs/IMPLEMENTATION_PLAN.md` and `docs/ARCHITECTURE.md` §11,
 * this file is the single source of truth for those names — stacks must
 * never rely on CDK auto-generated names for them.
 */

/** Non-empty identifier for a named AWS resource. */
const resourceName = z.string().min(1);

/** Environment-independent configuration, validated at synth time. */
export const appConfigSchema = z.object({
  /** Selects dev-only behavior such as `RemovalPolicy.DESTROY`. */
  envName: z.enum(["dev", "prod"]),
  /** Part A is single-region; the only value hardcoded in this file. */
  region: z.string().min(1),
  uploadsBucket: resourceName,
  outputBucket: resourceName,
  videoUploadedTopic: resourceName,
  opsAlertsTopic: resourceName,
  transcodeQueue: resourceName,
  transcodeDlq: resourceName,
  thumbnailQueue: resourceName,
  thumbnailDlq: resourceName,
  dbName: resourceName,
  dbUsername: resourceName,
  logGroupPrefix: z.string().min(1),
  /** Browser origins allowed to talk to the app and upload to S3. */
  appOrigins: z.array(z.url()).min(1),
  github: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    branch: z.string().min(1),
  }),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

/**
 * The agreed Clipper resource names. Ids/accounts/emails are deliberately
 * absent — nothing personal is committed to this repository.
 */
export const appConfig: AppConfig = appConfigSchema.parse({
  envName: "dev",
  region: "ap-southeast-1",
  uploadsBucket: "clipper-ogc-raw",
  outputBucket: "clipper-ogc-output",
  videoUploadedTopic: "clipper-video-uploaded",
  opsAlertsTopic: "clipper-ops-alerts",
  transcodeQueue: "clipper-transcode-queue",
  transcodeDlq: "clipper-transcode-dlq",
  thumbnailQueue: "clipper-thumbnail-queue",
  thumbnailDlq: "clipper-thumbnail-dlq",
  dbName: "clipper",
  dbUsername: "clipper_admin",
  logGroupPrefix: "/ecs/clipper/",
  appOrigins: ["http://localhost:3000"],
  github: { owner: "ogc-edu", repo: "clipper", branch: "main" },
});

/** Values that exist only in the operator's shell, never in git. */
export const synthEnvSchema = z.object({
  account: z.string().regex(/^\d{12}$/),
  opsAlertsEmail: z.email(),
});

export interface SynthEnv {
  /** AWS account id, from `CDK_DEFAULT_ACCOUNT`. */
  account: string;
  /** Always `appConfig.region`. */
  region: string;
  /** Ops alert recipient, from `OPS_ALERTS_EMAIL`. */
  opsAlertsEmail: string;
}

/** Anything shaped like `process.env`. */
export type EnvSource = Record<string, string | undefined>;

/**
 * Reads and validates the synth-time environment. Fails fast with a single
 * actionable message when the account or ops email is missing/invalid, so a
 * misconfigured deploy never reaches CloudFormation.
 */
export function loadSynthEnv(source: EnvSource = process.env): SynthEnv {
  const result = synthEnvSchema.safeParse({
    account: source.CDK_DEFAULT_ACCOUNT,
    opsAlertsEmail: source.OPS_ALERTS_EMAIL,
  });

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(env)"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Invalid CDK synth environment (${details}). Export CDK_DEFAULT_ACCOUNT ` +
        "and OPS_ALERTS_EMAIL before running cdk — see docs/RUNBOOK.md.",
    );
  }

  return {
    account: result.data.account,
    region: appConfig.region,
    opsAlertsEmail: result.data.opsAlertsEmail,
  };
}
