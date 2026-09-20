import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { appConfig } from "../config.js";
import { MessagingStack } from "../lib/messaging-stack.js";
import { StorageStack } from "../lib/storage-stack.js";
import { testEnv, testOpsAlertsEmail } from "./helpers.js";

function synth(): { messaging: Template; storage: Template } {
  const app = new cdk.App();
  const storage = new StorageStack(app, "TestStorage", {
    env: testEnv,
    appConfig,
  });
  const messaging = new MessagingStack(app, "TestMessaging", {
    env: testEnv,
    appConfig,
    uploadsBucket: storage.uploadsBucket,
    opsAlertsEmail: testOpsAlertsEmail,
  });
  return {
    messaging: Template.fromStack(messaging),
    storage: Template.fromStack(storage),
  };
}

describe("MessagingStack", () => {
  it("names both topics from config", () => {
    const { messaging } = synth();
    messaging.resourceCountIs("AWS::SNS::Topic", 2);
    messaging.hasResourceProperties("AWS::SNS::Topic", {
      TopicName: appConfig.videoUploadedTopic,
    });
    messaging.hasResourceProperties("AWS::SNS::Topic", {
      TopicName: appConfig.opsAlertsTopic,
    });
  });

  it("creates both queues and DLQs with config-defined names", () => {
    const { messaging } = synth();
    messaging.resourceCountIs("AWS::SQS::Queue", 4);
    for (const name of [
      appConfig.transcodeQueue,
      appConfig.transcodeDlq,
      appConfig.thumbnailQueue,
      appConfig.thumbnailDlq,
    ]) {
      messaging.hasResourceProperties("AWS::SQS::Queue", { QueueName: name });
    }
  });

  it("uses the agreed visibility timeouts (900s transcode, 120s thumbnail)", () => {
    const { messaging } = synth();
    messaging.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: appConfig.transcodeQueue,
      VisibilityTimeout: 900,
    });
    messaging.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: appConfig.thumbnailQueue,
      VisibilityTimeout: 120,
    });
  });

  it("keeps main messages 4 days and DLQ messages 14 days", () => {
    const { messaging } = synth();
    messaging.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: appConfig.transcodeQueue,
      MessageRetentionPeriod: 4 * 24 * 60 * 60,
    });
    messaging.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: appConfig.thumbnailQueue,
      MessageRetentionPeriod: 4 * 24 * 60 * 60,
    });
    messaging.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: appConfig.transcodeDlq,
      MessageRetentionPeriod: 14 * 24 * 60 * 60,
    });
    messaging.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: appConfig.thumbnailDlq,
      MessageRetentionPeriod: 14 * 24 * 60 * 60,
    });
  });

  it("redrives to a DLQ after maxReceiveCount 3", () => {
    const { messaging } = synth();
    messaging.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: appConfig.transcodeQueue,
      RedrivePolicy: { maxReceiveCount: 3 },
    });
    messaging.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: appConfig.thumbnailQueue,
      RedrivePolicy: { maxReceiveCount: 3 },
    });
  });

  it("subscribes both queues with raw message delivery", () => {
    const { messaging } = synth();
    const subscriptions = Object.values(
      messaging.findResources("AWS::SNS::Subscription"),
    );
    const sqsSubscriptions = subscriptions.filter(
      (sub) => sub.Properties.Protocol === "sqs",
    );
    expect(sqsSubscriptions).toHaveLength(2);
    for (const sub of sqsSubscriptions) {
      expect(sub.Properties.RawMessageDelivery).toBe(true);
    }
  });

  it("subscribes the ops alert email from the synth environment", () => {
    const { messaging } = synth();
    const emailSubscriptions = Object.values(
      messaging.findResources("AWS::SNS::Subscription"),
    ).filter((sub) => sub.Properties.Protocol === "email");
    expect(emailSubscriptions).toHaveLength(1);
    expect(emailSubscriptions[0]?.Properties.Endpoint).toBe(testOpsAlertsEmail);
  });

  it("scopes the video-uploaded topic policy to s3.amazonaws.com", () => {
    const { messaging } = synth();
    messaging.hasResourceProperties("AWS::SNS::TopicPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: "SNS:Publish",
            Principal: { Service: "s3.amazonaws.com" },
            Condition: { ArnLike: { "aws:SourceArn": Match.anyValue() } },
          }),
        ]),
      },
    });
  });

  it("lets the topic send to both queues", () => {
    const { messaging } = synth();
    const policies = Object.values(
      messaging.findResources("AWS::SQS::QueuePolicy"),
    );
    const snsPolicies = policies.filter((policy) =>
      JSON.stringify(policy).includes("sns.amazonaws.com"),
    );
    expect(snsPolicies).toHaveLength(2);
    for (const policy of snsPolicies) {
      expect(policy.Properties.PolicyDocument.Statement).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Effect: "Allow",
            Action: "sqs:SendMessage",
            Principal: { Service: "sns.amazonaws.com" },
          }),
        ]),
      );
    }
  });

  it("wires one DLQ-depth alarm per DLQ to the ops alerts topic", () => {
    const { messaging } = synth();
    const alarms = messaging.findResources("AWS::CloudWatch::Alarm");
    expect(Object.keys(alarms)).toHaveLength(2);

    const opsTopics = messaging.findResources("AWS::SNS::Topic", {
      Properties: { TopicName: appConfig.opsAlertsTopic },
    });
    const opsTopicId = Object.keys(opsTopics)[0];
    expect(opsTopicId).toBeDefined();

    for (const alarm of Object.values(alarms)) {
      expect(alarm.Properties.MetricName).toBe(
        "ApproximateNumberOfMessagesVisible",
      );
      expect(alarm.Properties.Namespace).toBe("AWS/SQS");
      expect(alarm.Properties.Threshold).toBe(1);
      expect(alarm.Properties.ComparisonOperator).toBe(
        "GreaterThanOrEqualToThreshold",
      );
      expect(alarm.Properties.AlarmActions).toEqual([{ Ref: opsTopicId }]);
    }
  });

  it("notifies the video-uploaded topic on uploads/ ObjectCreated", () => {
    const { storage } = synth();
    storage.hasResourceProperties("Custom::S3BucketNotifications", {
      NotificationConfiguration: {
        TopicConfigurations: Match.arrayWith([
          Match.objectLike({
            Events: ["s3:ObjectCreated:*"],
            Filter: {
              Key: {
                FilterRules: [{ Name: "prefix", Value: "uploads/" }],
              },
            },
            TopicArn: Match.anyValue(),
          }),
        ]),
      },
    });
  });
});
