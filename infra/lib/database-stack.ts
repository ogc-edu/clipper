import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import type { AppConfig } from "../config.js";

export interface DatabaseStackProps extends cdk.StackProps {
  readonly appConfig: AppConfig;
  /** VPC from `NetworkStack` (feature 002); the DB sits in its private subnets. */
  readonly vpc: ec2.IVpc;
  /** App/worker security group from `NetworkStack`; the only allowed DB client. */
  readonly appSecurityGroup: ec2.ISecurityGroup;
}

/**
 * The Clipper RDS PostgreSQL instance (architecture §2.3, decision D3).
 *
 * The web/API service is the only DB client; workers hold no DB credentials.
 * The database is private-only, master credentials are generated into
 * Secrets Manager, and in dev it is `DESTROY`-on-teardown. The schema itself
 * is feature 004 — this stack provisions the instance only.
 */
export class DatabaseStack extends cdk.Stack {
  /** The database instance. Later stacks (006) attach it to the API. */
  public readonly database: rds.DatabaseInstance;
  /** DB security group: ingress from the app SG only. */
  public readonly databaseSecurityGroup: ec2.SecurityGroup;
  /** Generated master-credentials secret. Never print its value. */
  public readonly secret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);
    const { appConfig, vpc, appSecurityGroup } = props;
    const isDev = appConfig.envName === "dev";
    const removalPolicy = isDev
      ? cdk.RemovalPolicy.DESTROY
      : cdk.RemovalPolicy.RETAIN;

    this.databaseSecurityGroup = new ec2.SecurityGroup(
      this,
      "DatabaseSecurityGroup",
      {
        vpc,
        description:
          "Clipper RDS PostgreSQL; accepts connections only from the app SG.",
        // RDS never initiates connections, so no egress rule is needed.
        allowAllOutbound: false,
      },
    );

    // SG-to-SG only — there is deliberately no CIDR ingress anywhere in this
    // stack. The app SG is the only principal that may reach tcp/5432.
    this.databaseSecurityGroup.addIngressRule(
      appSecurityGroup,
      ec2.Port.tcp(5432),
      "PostgreSQL from the Clipper app security group only",
    );

    // CDK-generated master credentials in Secrets Manager. The secret is
    // built explicitly (rather than `Credentials.fromGeneratedSecret`) so its
    // removal policy can follow the environment: destroyed in dev, retained
    // alongside the instance in prod. Rotation stays disabled in dev; prod
    // enables it with `database.addRotationSingleUser()`.
    this.secret = new secretsmanager.Secret(this, "DatabaseCredentials", {
      secretName: appConfig.dbSecretName,
      description: `Clipper RDS master credentials for ${appConfig.dbName}.`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: appConfig.dbUsername,
        }),
        generateStringKey: "password",
        passwordLength: 30,
        excludeCharacters: " %+~`#$&*()|[]{}:;<>?!'/@\"\\",
      },
      removalPolicy,
    });

    this.database = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: new ec2.InstanceType(appConfig.dbInstanceClass),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.databaseSecurityGroup],
      publiclyAccessible: false,
      multiAz: false, // single-AZ for Part A; prod would enable multi-AZ
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true, // encryption at rest (AWS-managed key)
      databaseName: appConfig.dbName,
      credentials: rds.Credentials.fromSecret(
        this.secret,
        appConfig.dbUsername,
      ),
      backupRetention: cdk.Duration.days(isDev ? 1 : 7),
      deletionProtection: !isDev, // dev: false; prod: true
      deleteAutomatedBackups: isDev,
      removalPolicy,
    });

    new cdk.CfnOutput(this, "DatabaseSecretArn", {
      value: this.secret.secretArn,
      exportName: `${appConfig.envName}-clipper-db-secret-arn`,
      description: "Secrets Manager ARN holding the RDS master credentials.",
    });
    new cdk.CfnOutput(this, "DatabaseEndpointAddress", {
      value: this.database.dbInstanceEndpointAddress,
      exportName: `${appConfig.envName}-clipper-db-endpoint-address`,
      description: "RDS writer endpoint hostname (private subnets only).",
    });
    new cdk.CfnOutput(this, "DatabaseEndpointPort", {
      value: this.database.dbInstanceEndpointPort,
      exportName: `${appConfig.envName}-clipper-db-endpoint-port`,
      description: "RDS writer endpoint port.",
    });
    new cdk.CfnOutput(this, "DatabaseName", {
      value: appConfig.dbName,
      exportName: `${appConfig.envName}-clipper-db-name`,
      description: "Logical database name inside the RDS instance.",
    });
  }
}
