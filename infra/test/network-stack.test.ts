import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { appConfig } from "../config.js";
import { NetworkStack } from "../lib/network-stack.js";
import { testEnv } from "./helpers.js";

function synth(): Template {
  const app = new cdk.App();
  const stack = new NetworkStack(app, "TestNetwork", {
    env: testEnv,
    appConfig,
  });
  return Template.fromStack(stack);
}

describe("NetworkStack", () => {
  it("creates zero NAT gateways (cost posture)", () => {
    synth().resourceCountIs("AWS::EC2::NatGateway", 0);
  });

  it("spans two AZs with public and private subnets", () => {
    const template = synth();
    template.resourceCountIs("AWS::EC2::Subnet", 4);
    template.resourceCountIs("AWS::EC2::RouteTable", 4);
  });

  it("exposes the S3 gateway endpoint", () => {
    synth().hasResourceProperties("AWS::EC2::VPCEndpoint", {
      VpcEndpointType: "Gateway",
      ServiceName: {
        "Fn::Join": ["", ["com.amazonaws.", { Ref: "AWS::Region" }, ".s3"]],
      },
    });
  });

  it("exposes SQS, SecretsManager, and CloudWatch Logs interface endpoints", () => {
    const template = synth();
    for (const service of [".sqs", ".secretsmanager", ".logs"]) {
      template.hasResourceProperties("AWS::EC2::VPCEndpoint", {
        VpcEndpointType: "Interface",
        ServiceName: `com.amazonaws.ap-southeast-1${service}`,
      });
    }
  });

  it("places every interface endpoint in a single AZ (dev cost saving)", () => {
    const template = synth();
    const endpoints = template.findResources("AWS::EC2::VPCEndpoint", {
      Properties: { VpcEndpointType: "Interface" },
    });
    expect(Object.keys(endpoints)).toHaveLength(3);
    for (const endpoint of Object.values(endpoints)) {
      expect(endpoint.Properties.SubnetIds).toHaveLength(1);
    }
  });

  it("exports the VPC and app security group for later stacks", () => {
    const template = synth();
    template.hasOutput("VpcId", {
      Export: { Name: `${appConfig.envName}-clipper-vpc-id` },
    });
    template.hasOutput("AppSecurityGroupId", {
      Export: { Name: `${appConfig.envName}-clipper-app-sg-id` },
    });
  });
});
