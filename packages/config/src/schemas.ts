import { z } from "zod";
import { loadEnv, type EnvSource } from "./env.js";

function requiredString(name: string) {
  return z.string().min(1, `${name} is required`);
}

/** Runtime environment. Optional; defaults to `development`. */
export const nodeEnvSchema = z
  .enum(["development", "test", "production"])
  .default("development");

/** AWS region shared by every component. */
export const awsRegionSchema = requiredString("AWS_REGION");

/**
 * Environment for `apps/web` (UI + API route handlers) per
 * `docs/ARCHITECTURE.md` §2.1/§2.5/§2.6. Secrets are referenced by ARN and
 * resolved at runtime from Secrets Manager; they are never env values.
 */
export const webEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  AWS_REGION: awsRegionSchema,
  /** PostgreSQL connection string for Prisma. */
  DATABASE_URL: requiredString("DATABASE_URL"),
  UPLOADS_BUCKET: requiredString("UPLOADS_BUCKET"),
  OUTPUTS_BUCKET: requiredString("OUTPUTS_BUCKET"),
  COGNITO_USER_POOL_ID: requiredString("COGNITO_USER_POOL_ID"),
  COGNITO_CLIENT_ID: requiredString("COGNITO_CLIENT_ID"),
  COGNITO_CLIENT_SECRET: requiredString("COGNITO_CLIENT_SECRET"),
  COGNITO_DOMAIN: requiredString("COGNITO_DOMAIN"),
  COGNITO_REDIRECT_URI: requiredString("COGNITO_REDIRECT_URI"),
  CLOUDFRONT_DOMAIN: requiredString("CLOUDFRONT_DOMAIN"),
  CLOUDFRONT_KEY_PAIR_ID: requiredString("CLOUDFRONT_KEY_PAIR_ID"),
  CLOUDFRONT_PRIVATE_KEY_SECRET_ARN: requiredString(
    "CLOUDFRONT_PRIVATE_KEY_SECRET_ARN",
  ),
  WORKER_TOKEN_SECRET_ARN: requiredString("WORKER_TOKEN_SECRET_ARN"),
  /** Queue URLs used by the admin metrics endpoint. */
  TRANSCODE_QUEUE_URL: requiredString("TRANSCODE_QUEUE_URL"),
  THUMBNAIL_QUEUE_URL: requiredString("THUMBNAIL_QUEUE_URL"),
});

export type WebEnv = z.infer<typeof webEnvSchema>;

/**
 * Environment for `apps/worker` per `docs/ARCHITECTURE.md` §2.2. One image
 * is deployed twice with a different `WORKER_MODE`.
 */
export const workerModeSchema = z.enum(["transcode", "thumbnail"]);

export const workerEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  AWS_REGION: awsRegionSchema,
  WORKER_MODE: workerModeSchema,
  UPLOADS_BUCKET: requiredString("UPLOADS_BUCKET"),
  OUTPUTS_BUCKET: requiredString("OUTPUTS_BUCKET"),
  /** URL of the queue this worker long-polls. */
  SQS_QUEUE_URL: requiredString("SQS_QUEUE_URL"),
  /** Base URL of the web API for status callbacks. */
  API_BASE_URL: requiredString("API_BASE_URL"),
  WORKER_TOKEN_SECRET_ARN: requiredString("WORKER_TOKEN_SECRET_ARN"),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** Validates and returns the web environment. */
export function loadWebEnv(source: EnvSource = process.env): WebEnv {
  return loadEnv(webEnvSchema, source);
}

/** Validates and returns the worker environment. */
export function loadWorkerEnv(source: EnvSource = process.env): WorkerEnv {
  return loadEnv(workerEnvSchema, source);
}
