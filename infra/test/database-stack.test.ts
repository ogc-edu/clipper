import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { appConfig, type AppConfig } from "../config.js";
import { DatabaseStack } from "../lib/database-stack.js";
import { NetworkStack } from "../lib/network-stack.js";
import { testEnv } from "./helpers.js";

function synth(config: AppConfig = appConfig): {
  database: Template;
  network: Template;
} {
  const app = new cdk.App();
  const network = new NetworkStack(app, "TestNetwork", {
    env: testEnv,
    appConfig: config,
  });
  const database = new DatabaseStack(app, "TestDatabase", {
    env: testEnv,
    appConfig: config,
    vpc: network.vpc,
    appSecurityGroup: network.appSecurityGroup,
  });
  return {
    database: Template.fromStack(database),
    network: Template.fromStack(network),
  };
}

describe("DatabaseStack", () => {
  it("creates a PostgreSQL 16 instance on the configured class, 20 GB gp3", () => {
    synth().database.hasResourceProperties("AWS::RDS::DBInstance", {
      Engine: "postgres",
      EngineVersion: Match.stringLikeRegexp("^16(\\.|$)"),
      DBInstanceClass: `db.${appConfig.dbInstanceClass}`,
      AllocatedStorage: "20",
      StorageType: "gp3",
      StorageEncrypted: true,
    });
  });

  it("is private and single-AZ", () => {
    synth().database.hasResourceProperties("AWS::RDS::DBInstance", {
      PubliclyAccessible: false,
      MultiAZ: false,
    });
  });

  it("places the instance in private subnets only", () => {
    const { database, network } = synth();

    const subnets = network.findResources("AWS::EC2::Subnet");
    const privateSubnets = Object.values(subnets).filter(
      (subnet) => subnet.Properties.MapPublicIpOnLaunch !== true,
    );
    const publicSubnets = Object.values(subnets).filter(
      (subnet) => subnet.Properties.MapPublicIpOnLaunch === true,
    );
    expect(privateSubnets).toHaveLength(2);
    expect(publicSubnets).toHaveLength(2);

    const subnetGroups = database.findResources("AWS::RDS::DBSubnetGroup");
    const subnetGroup = Object.values(subnetGroups)[0];
    expect(subnetGroup).toBeDefined();

    const subnetIds = subnetGroup?.Properties.SubnetIds as unknown[];
    expect(subnetIds).toHaveLength(2);
    for (const subnetId of subnetIds) {
      const value = JSON.stringify(subnetId);
      expect(value).toContain("PrivateSubnet");
      expect(value).not.toContain("PublicSubnet");
    }
  });

  it("generates the master secret under the configured name, rotation disabled", () => {
    const { database } = synth();
    database.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: appConfig.dbSecretName,
      GenerateSecretString: Match.objectLike({
        GenerateStringKey: "password",
      }),
    });
    // No rotation Lambda/schedule exists in this stack.
    database.resourceCountIs("AWS::SecretsManager::RotationSchedule", 0);
  });

  it("never puts a literal password in the secret template", () => {
    const { database } = synth();
    const secrets = database.findResources("AWS::SecretsManager::Secret");
    expect(Object.keys(secrets)).toHaveLength(1);
    const template =
      Object.values(secrets)[0]?.Properties.GenerateSecretString
        .SecretStringTemplate;
    expect(template).toContain(appConfig.dbUsername);
    expect(template).not.toContain("password");
  });

  it("allows tcp/5432 from the app SG only — no CIDR ingress", () => {
    const { database } = synth();
    const ingressRules = Object.values(
      database.findResources("AWS::EC2::SecurityGroupIngress"),
    );
    expect(ingressRules).toHaveLength(1);

    const rule = ingressRules[0]!;
    expect(rule.Properties).toMatchObject({
      IpProtocol: "tcp",
      FromPort: 5432,
      ToPort: 5432,
    });
    expect(rule.Properties.SourceSecurityGroupId).toBeDefined();
    expect(JSON.stringify(rule.Properties.SourceSecurityGroupId)).toContain(
      "AppSecurityGroup",
    );
    expect(rule.Properties.CidrIp).toBeUndefined();
    expect(rule.Properties.CidrIpv6).toBeUndefined();
  });

  it("contains no 0.0.0.0/0 anywhere", () => {
    const { database } = synth();
    expect(JSON.stringify(database.toJSON())).not.toContain("0.0.0.0/0");
  });

  it("is DESTROY + unprotected in dev (no final snapshot)", () => {
    const { database } = synth();
    database.hasResource("AWS::RDS::DBInstance", {
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
      Properties: Match.objectLike({
        DeletionProtection: false,
        DeleteAutomatedBackups: true,
        BackupRetentionPeriod: 1,
      }),
    });
    database.hasResource("AWS::SecretsManager::Secret", {
      DeletionPolicy: "Delete",
    });
  });

  it("is RETAIN + protected in prod", () => {
    const prodConfig: AppConfig = { ...appConfig, envName: "prod" };
    const { database } = synth(prodConfig);
    database.hasResource("AWS::RDS::DBInstance", {
      DeletionPolicy: "Retain",
      Properties: Match.objectLike({
        DeletionProtection: true,
        DeleteAutomatedBackups: false,
      }),
    });
    database.hasResource("AWS::SecretsManager::Secret", {
      DeletionPolicy: "Retain",
    });
  });

  it("exports the secret ARN, writer endpoint, and DB name", () => {
    const { database } = synth();
    database.hasOutput("DatabaseSecretArn", {
      Export: { Name: `${appConfig.envName}-clipper-db-secret-arn` },
    });
    database.hasOutput("DatabaseEndpointAddress", {
      Export: { Name: `${appConfig.envName}-clipper-db-endpoint-address` },
    });
    database.hasOutput("DatabaseEndpointPort", {
      Export: { Name: `${appConfig.envName}-clipper-db-endpoint-port` },
    });
    database.hasOutput("DatabaseName", {
      Value: appConfig.dbName,
      Export: { Name: `${appConfig.envName}-clipper-db-name` },
    });
  });
});
