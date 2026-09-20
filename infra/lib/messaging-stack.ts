import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import type { AppConfig } from "../config.js";

export interface MessagingStackProps extends cdk.StackProps {
  readonly appConfig: AppConfig;
  /** The uploads bucket whose `ObjectCreated` events start the pipeline. */
  readonly uploadsBucket: s3.IBucket;
  /** DLQ alarm recipient; comes from `OPS_ALERTS_EMAIL`, never from git. */
  readonly opsAlertsEmail: string;
}

/**
 * The pipeline's fan-out backbone: S3 → SNS → two SQS queues, plus DLQs and
 * operator alarms.
 *
 * Messages are delivered **raw** (`rawMessageDelivery: true`) so workers
 * receive the S3 `ObjectCreated` body directly — exactly what
 * `packages/shared/src/s3-event.ts` parses (architecture decision D1).
 */
export class MessagingStack extends cdk.Stack {
  public readonly videoUploadedTopic: sns.Topic;
  public readonly opsAlertsTopic: sns.Topic;
  public readonly transcodeQueue: sqs.Queue;
  public readonly transcodeDlq: sqs.Queue;
  public readonly thumbnailQueue: sqs.Queue;
  public readonly thumbnailDlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: MessagingStackProps) {
    super(scope, id, props);
    const { appConfig, uploadsBucket, opsAlertsEmail } = props;

    this.transcodeDlq = new sqs.Queue(this, "TranscodeDlq", {
      queueName: appConfig.transcodeDlq,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    this.thumbnailDlq = new sqs.Queue(this, "ThumbnailDlq", {
      queueName: appConfig.thumbnailDlq,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    // Visibility timeouts: transcode is slow (15 min), thumbnail is quick
    // (2 min). Workers heartbeat to extend while actively processing.
    this.transcodeQueue = new sqs.Queue(this, "TranscodeQueue", {
      queueName: appConfig.transcodeQueue,
      visibilityTimeout: cdk.Duration.seconds(900),
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: this.transcodeDlq, maxReceiveCount: 3 },
    });
    this.thumbnailQueue = new sqs.Queue(this, "ThumbnailQueue", {
      queueName: appConfig.thumbnailQueue,
      visibilityTimeout: cdk.Duration.seconds(120),
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: this.thumbnailDlq, maxReceiveCount: 3 },
    });

    this.videoUploadedTopic = new sns.Topic(this, "VideoUploadedTopic", {
      topicName: appConfig.videoUploadedTopic,
      displayName: "Clipper video uploaded",
      enforceSSL: true,
    });
    this.opsAlertsTopic = new sns.Topic(this, "OpsAlertsTopic", {
      topicName: appConfig.opsAlertsTopic,
      displayName: "Clipper ops alerts",
      enforceSSL: true,
    });

    // Raw delivery, no SNS envelope — see class doc.
    this.videoUploadedTopic.addSubscription(
      new subs.SqsSubscription(this.transcodeQueue, {
        rawMessageDelivery: true,
      }),
    );
    this.videoUploadedTopic.addSubscription(
      new subs.SqsSubscription(this.thumbnailQueue, {
        rawMessageDelivery: true,
      }),
    );

    // S3 → SNS. We bind a custom destination instead of CDK's
    // `SnsDestination`: that helper adds a topic policy scoped to
    // `bucket.bucketArn`, a cross-stack token that would make MessagingStack
    // depend on StorageStack — while StorageStack already depends on
    // MessagingStack for the notification, creating a cycle. The scoped
    // policy is added explicitly below from the configured (literal) bucket
    // ARN, so the dependency stays one-way: Storage → Messaging.
    const rawSnsDestination: s3.IBucketNotificationDestination = {
      bind: () => ({
        type: s3.BucketNotificationDestinationType.TOPIC,
        arn: this.videoUploadedTopic.topicArn,
      }),
    };
    uploadsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      rawSnsDestination,
      { prefix: "uploads/" },
    );

    // Explicit topic policy scoped to the one uploads bucket ARN. The S3
    // notification above also contributes a scoped statement via CDK.
    const uploadsBucketArn = `arn:${this.partition}:s3:::${appConfig.uploadsBucket}`;
    this.videoUploadedTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowUploadsBucketPublish",
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("s3.amazonaws.com")],
        actions: ["SNS:Publish"],
        resources: [this.videoUploadedTopic.topicArn],
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: { "aws:SourceArn": uploadsBucketArn },
        },
      }),
    );

    // A human must confirm the subscription before DLQ alarms can page them
    // (see docs/RUNBOOK.md, Gate C).
    this.opsAlertsTopic.addSubscription(
      new subs.EmailSubscription(opsAlertsEmail),
    );

    const alarmAction = new cwActions.SnsAction(this.opsAlertsTopic);
    const dlqs = [
      ["TranscodeDlqAlarm", this.transcodeDlq],
      ["ThumbnailDlqAlarm", this.thumbnailDlq],
    ] as const;
    for (const [id, dlq] of dlqs) {
      const alarm = new cloudwatch.Alarm(this, id, {
        alarmName: `${dlq.queueName}-not-empty`,
        alarmDescription: `${dlq.queueName} has visible messages (a job exhausted redrive).`,
        metric: dlq.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(5),
          statistic: "Maximum",
        }),
        threshold: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(alarmAction);
    }

    new cdk.CfnOutput(this, "VideoUploadedTopicArn", {
      value: this.videoUploadedTopic.topicArn,
      exportName: `${appConfig.envName}-clipper-video-uploaded-topic-arn`,
    });
    new cdk.CfnOutput(this, "OpsAlertsTopicArn", {
      value: this.opsAlertsTopic.topicArn,
      exportName: `${appConfig.envName}-clipper-ops-alerts-topic-arn`,
    });
    new cdk.CfnOutput(this, "TranscodeQueueUrl", {
      value: this.transcodeQueue.queueUrl,
      exportName: `${appConfig.envName}-clipper-transcode-queue-url`,
    });
    new cdk.CfnOutput(this, "ThumbnailQueueUrl", {
      value: this.thumbnailQueue.queueUrl,
      exportName: `${appConfig.envName}-clipper-thumbnail-queue-url`,
    });
    new cdk.CfnOutput(this, "TranscodeDlqUrl", {
      value: this.transcodeDlq.queueUrl,
      exportName: `${appConfig.envName}-clipper-transcode-dlq-url`,
    });
    new cdk.CfnOutput(this, "ThumbnailDlqUrl", {
      value: this.thumbnailDlq.queueUrl,
      exportName: `${appConfig.envName}-clipper-thumbnail-dlq-url`,
    });
  }
}
