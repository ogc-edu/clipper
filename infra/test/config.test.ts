import { describe, expect, it } from "vitest";
import { appConfig, loadSynthEnv } from "../config.js";

describe("appConfig", () => {
  it("matches the agreed resource names", () => {
    expect(appConfig).toMatchObject({
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
      dbInstanceClass: "t4g.micro",
      dbSecretName: "clipper/dev/db-credentials",
      logGroupPrefix: "/ecs/clipper/",
      appOrigins: ["http://localhost:3000"],
      github: { owner: "ogc-edu", repo: "clipper", branch: "main" },
    });
  });

  it("contains no account id or email address (nothing personal is committed)", () => {
    const serialized = JSON.stringify(appConfig);
    expect(serialized).not.toMatch(/\b\d{12}\b/);
    expect(serialized).not.toMatch(/[^\s"]+@[^\s"]+\.[^\s"]+/);
    expect(serialized).not.toContain("OPS_ALERTS_EMAIL");
  });
});

describe("loadSynthEnv", () => {
  it("fails fast when the AWS account is missing", () => {
    expect(() =>
      loadSynthEnv({ OPS_ALERTS_EMAIL: "ops@example.com" }),
    ).toThrowError(/CDK_DEFAULT_ACCOUNT|account/);
  });

  it("fails fast when the ops alert email is missing", () => {
    expect(() =>
      loadSynthEnv({ CDK_DEFAULT_ACCOUNT: "123456789012" }),
    ).toThrowError(/OPS_ALERTS_EMAIL|email/);
  });

  it("returns the configured region and the shell-provided values", () => {
    expect(
      loadSynthEnv({
        CDK_DEFAULT_ACCOUNT: "123456789012",
        OPS_ALERTS_EMAIL: "ops@example.com",
      }),
    ).toEqual({
      account: "123456789012",
      region: appConfig.region,
      opsAlertsEmail: "ops@example.com",
    });
  });
});
