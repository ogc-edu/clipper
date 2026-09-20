import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  loadEnv,
  loadWebEnv,
  loadWorkerEnv,
  webEnvSchema,
} from "../src/index.js";

const validWebEnv = {
  AWS_REGION: "us-east-1",
  DATABASE_URL: "postgresql://clipper:clipper@localhost:5432/clipper",
  UPLOADS_BUCKET: "clipper-uploads-dev",
  OUTPUTS_BUCKET: "clipper-outputs-dev",
  COGNITO_USER_POOL_ID: "us-east-1_EXAMPLE",
  COGNITO_CLIENT_ID: "exampleclientid",
  COGNITO_CLIENT_SECRET: "exampleclientsecret",
  COGNITO_DOMAIN: "clipper-dev.auth.us-east-1.amazoncognito.com",
  COGNITO_REDIRECT_URI: "http://localhost:3000/api/auth/callback",
  CLOUDFRONT_DOMAIN: "d111111abcdef8.cloudfront.net",
  CLOUDFRONT_KEY_PAIR_ID: "K2JCJMDEHXQW5F",
  CLOUDFRONT_PRIVATE_KEY_SECRET_ARN:
    "arn:aws:secretsmanager:us-east-1:123456789012:secret:cloudfront-key",
  WORKER_TOKEN_SECRET_ARN:
    "arn:aws:secretsmanager:us-east-1:123456789012:secret:worker-token",
  TRANSCODE_QUEUE_URL:
    "https://sqs.us-east-1.amazonaws.com/123456789012/transcode-queue",
  THUMBNAIL_QUEUE_URL:
    "https://sqs.us-east-1.amazonaws.com/123456789012/thumbnail-queue",
};

const validWorkerEnv = {
  AWS_REGION: "us-east-1",
  WORKER_MODE: "transcode",
  UPLOADS_BUCKET: "clipper-uploads-dev",
  OUTPUTS_BUCKET: "clipper-outputs-dev",
  SQS_QUEUE_URL:
    "https://sqs.us-east-1.amazonaws.com/123456789012/transcode-queue",
  API_BASE_URL: "http://localhost:3000",
  WORKER_TOKEN_SECRET_ARN:
    "arn:aws:secretsmanager:us-east-1:123456789012:secret:worker-token",
};

describe("loadEnv", () => {
  const schema = z.object({
    HOST: z.string().min(1, "HOST is required"),
    PORT: z.coerce.number().int().positive("PORT must be a positive integer"),
  });

  it("returns typed, coerced values for valid input", () => {
    expect(loadEnv(schema, { HOST: "localhost", PORT: "8080" })).toEqual({
      HOST: "localhost",
      PORT: 8080,
    });
  });

  it("throws an error listing every missing variable", () => {
    let caught: unknown;
    try {
      loadEnv(schema, {});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("Invalid environment configuration");
    expect(message).toContain("HOST");
    expect(message).toContain("PORT");
  });

  it("lists invalid values alongside missing ones", () => {
    let caught: unknown;
    try {
      loadEnv(schema, { HOST: "", PORT: "not-a-number" });
    } catch (error) {
      caught = error;
    }

    const message = (caught as Error).message;
    expect(message).toContain("HOST");
    expect(message).toContain("PORT");
  });
});

describe("webEnvSchema", () => {
  it("parses a complete web environment and defaults NODE_ENV", () => {
    const env = loadWebEnv(validWebEnv);
    expect(env.AWS_REGION).toBe("us-east-1");
    expect(env.NODE_ENV).toBe("development");
  });

  it("rejects an incomplete web environment, naming every missing var", () => {
    let caught: unknown;
    try {
      loadWebEnv({});
    } catch (error) {
      caught = error;
    }

    const message = (caught as Error).message;
    for (const key of Object.keys(webEnvSchema.shape)) {
      if (key === "NODE_ENV") continue;
      expect(message).toContain(key);
    }
  });
});

describe("workerEnvSchema", () => {
  it("parses a complete worker environment", () => {
    const env = loadWorkerEnv(validWorkerEnv);
    expect(env.WORKER_MODE).toBe("transcode");
    expect(env.NODE_ENV).toBe("development");
  });

  it("rejects an unknown worker mode", () => {
    let caught: unknown;
    try {
      loadWorkerEnv({ ...validWorkerEnv, WORKER_MODE: "moderation" });
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).toContain("WORKER_MODE");
  });

  it("rejects an incomplete worker environment", () => {
    expect(() => loadWorkerEnv({ AWS_REGION: "us-east-1" })).toThrow(
      /Invalid environment configuration/,
    );
  });
});
