import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import type { AppConfig } from "../config.js";

export interface StorageStackProps extends cdk.StackProps {
  readonly appConfig: AppConfig;
}

/**
 * The two Clipper buckets.
 *
 * - `uploadsBucket` receives raw browser uploads (presigned POST, feature
 *   008). It is private, SSE-S3 encrypted, SSL-only, and expires uploads
 *   after 7 days.
 * - `outputBucket` holds processed HLS/thumbnails. It is fully private;
 *   CloudFront OAC access arrives in feature 014.
 *
 * In dev (`envName: "dev"`) both buckets are `DESTROY` + `autoDeleteObjects`
 * so `cdk destroy` is clean. Prod keeps them (`RETAIN`).
 */
export class StorageStack extends cdk.Stack {
  public readonly uploadsBucket: s3.Bucket;
  public readonly outputBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);
    const { appConfig } = props;
    const isDev = appConfig.envName === "dev";
    const removalPolicy = isDev
      ? cdk.RemovalPolicy.DESTROY
      : cdk.RemovalPolicy.RETAIN;

    this.uploadsBucket = new s3.Bucket(this, "UploadsBucket", {
      bucketName: appConfig.uploadsBucket,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      cors: [
        {
          // Presigned POST from the browser (feature 008).
          allowedMethods: [s3.HttpMethods.POST],
          allowedOrigins: appConfig.appOrigins,
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          id: "expire-uploads",
          enabled: true,
          prefix: "uploads/",
          expiration: cdk.Duration.days(7),
        },
      ],
      removalPolicy,
      autoDeleteObjects: isDev,
    });

    this.outputBucket = new s3.Bucket(this, "OutputBucket", {
      bucketName: appConfig.outputBucket,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: isDev,
    });

    new cdk.CfnOutput(this, "UploadsBucketName", {
      value: this.uploadsBucket.bucketName,
      exportName: `${appConfig.envName}-clipper-uploads-bucket`,
    });
    new cdk.CfnOutput(this, "OutputBucketName", {
      value: this.outputBucket.bucketName,
      exportName: `${appConfig.envName}-clipper-output-bucket`,
    });
  }
}
