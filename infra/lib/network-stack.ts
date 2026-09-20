import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type { Construct } from "constructs";
import type { AppConfig } from "../config.js";

export interface NetworkStackProps extends cdk.StackProps {
  readonly appConfig: AppConfig;
}

/**
 * Network backbone for every Clipper compute service (features 003/006+).
 *
 * Cost posture: **zero NAT gateways** (~$32/mo each). Private subnets reach
 * AWS APIs through VPC endpoints instead. Interface endpoints are deployed
 * in a single AZ in dev to avoid paying the per-AZ hourly charge; prod would
 * spread them across both AZs.
 */
export class NetworkStack extends cdk.Stack {
  /** The VPC all compute resources join. */
  public readonly vpc: ec2.Vpc;
  /** Security group for web/API and worker tasks (exported for later stacks). */
  public readonly appSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { appConfig } = props;

    this.vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/16"),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // S3 gateway endpoint: free, and keeps object traffic off the (absent)
    // NAT and the public internet.
    this.vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // One AZ only in dev (cost). See class doc.
    const privateSubnet = this.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnets[0];
    if (!privateSubnet) {
      throw new Error("NetworkStack: expected at least one private subnet");
    }
    const endpointSubnets: ec2.SubnetSelection = { subnets: [privateSubnet] };

    this.vpc.addInterfaceEndpoint("SqsEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.SQS,
      subnets: endpointSubnets,
    });
    this.vpc.addInterfaceEndpoint("SecretsManagerEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: endpointSubnets,
    });
    this.vpc.addInterfaceEndpoint("CloudWatchLogsEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      subnets: endpointSubnets,
    });

    // TODO(feature 006): add ecr.api + ecr.dkr interface endpoints so Fargate
    // can pull images into these private subnets (the S3 gateway endpoint
    // already covers image layers).

    this.appSecurityGroup = new ec2.SecurityGroup(this, "AppSecurityGroup", {
      vpc: this.vpc,
      description:
        "Clipper app/worker tasks; consumers add least-privilege ingress.",
      allowAllOutbound: true,
    });

    new cdk.CfnOutput(this, "VpcId", {
      value: this.vpc.vpcId,
      exportName: `${appConfig.envName}-clipper-vpc-id`,
    });
    new cdk.CfnOutput(this, "AppSecurityGroupId", {
      value: this.appSecurityGroup.securityGroupId,
      exportName: `${appConfig.envName}-clipper-app-sg-id`,
      description:
        "Security group for the web/API and worker services (feature 003+).",
    });
  }
}
