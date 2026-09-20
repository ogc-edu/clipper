import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { appConfig } from "../config.js";
import { StorageStack } from "../lib/storage-stack.js";
import { testEnv } from "./helpers.js";

function synth(): Template {
  const app = new cdk.App();
  const stack = new StorageStack(app, "TestStorage", {
    env: testEnv,
    appConfig,
  });
  return Template.fromStack(stack);
}

const BLOCK_ALL = {
  BlockPublicAcls: true,
  BlockPublicPolicy: true,
  IgnorePublicAcls: true,
  RestrictPublicBuckets: true,
};

describe("StorageStack", () => {
  it("creates exactly two buckets with config-defined names", () => {
    const template = synth();
    template.resourceCountIs("AWS::S3::Bucket", 2);
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: appConfig.uploadsBucket,
    });
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: appConfig.outputBucket,
    });
  });

  it("blocks all public access on both buckets", () => {
    const template = synth();
    const buckets = template.findResources("AWS::S3::Bucket");
    expect(Object.keys(buckets)).toHaveLength(2);
    for (const bucket of Object.values(buckets)) {
      expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual(
        BLOCK_ALL,
      );
    }
  });

  it("encrypts both buckets with SSE-S3", () => {
    const template = synth();
    for (const bucket of Object.values(
      template.findResources("AWS::S3::Bucket"),
    )) {
      expect(bucket.Properties.BucketEncryption).toEqual({
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      });
    }
  });

  it("expires uploads/ after 7 days", () => {
    synth().hasResourceProperties("AWS::S3::Bucket", {
      BucketName: appConfig.uploadsBucket,
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: "expire-uploads",
            Status: "Enabled",
            Prefix: "uploads/",
            ExpirationInDays: 7,
          }),
        ]),
      },
    });
  });

  it("allows POST CORS from the configured app origins", () => {
    synth().hasResourceProperties("AWS::S3::Bucket", {
      BucketName: appConfig.uploadsBucket,
      CorsConfiguration: {
        CorsRules: Match.arrayWith([
          Match.objectLike({
            AllowedMethods: ["POST"],
            AllowedOrigins: appConfig.appOrigins,
          }),
        ]),
      },
    });
  });

  it("gives the output bucket no CORS configuration", () => {
    const template = synth();
    const output = template.findResources("AWS::S3::Bucket", {
      Properties: { BucketName: appConfig.outputBucket },
    });
    const bucket = Object.values(output)[0];
    expect(bucket?.Properties.CorsConfiguration).toBeUndefined();
  });

  it("enforces SSL-only access on both buckets", () => {
    const template = synth();
    template.resourceCountIs("AWS::S3::BucketPolicy", 2);
    for (const policy of Object.values(
      template.findResources("AWS::S3::BucketPolicy"),
    )) {
      expect(policy.Properties.PolicyDocument.Statement).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Effect: "Deny",
            Action: "s3:*",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      );
    }
  });
});
