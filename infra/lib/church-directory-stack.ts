import * as path from "node:path";
import { Stack, type StackProps, RemovalPolicy, Duration, CfnOutput } from "aws-cdk-lib";
import type { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as iam from "aws-cdk-lib/aws-iam";

export interface ChurchDirectoryStackProps extends StackProps {
  /** Seeded into app_users by the migrations and bound on first sign-in. */
  readonly superAdminEmail: string;
  readonly domainName: string;
  readonly hostedZoneId: string;
  readonly hostedZoneName: string;
  /** Must be an ISSUED cert in us-east-1 covering domainName. */
  readonly certificateArn: string;
}

/**
 * The GitHub Actions deploy role. Created once by
 * scripts/create-deploy-role.sh, referenced here.
 */
const DEPLOY_ROLE_NAME = "church-directory-github-deploy";

/** The Postgres role the API connects as; created by V2__app_role.sql. */
const APP_DB_ROLE = "directory_app";
const DB_NAME = "directory";

export class ChurchDirectoryStack extends Stack {
  constructor(scope: Construct, id: string, props: ChurchDirectoryStackProps) {
    super(scope, id, props);

    const { superAdminEmail, domainName, hostedZoneId, hostedZoneName, certificateArn } = props;

    // -------------------------------------------------------------------
    // Networking
    //
    // No NAT gateway. The API Lambda has to sit in the VPC to reach the
    // private database, which normally means paying ~$32/month for NAT just so
    // it can call the Cognito IdP API. Instead the subnets are dual-stack with
    // an egress-only internet gateway, which is free:
    // `cognito-idp.us-east-1.amazonaws.com` publishes an AAAA record, so the
    // AWS SDK reaches it over IPv6 with no endpoint override needed.
    //
    // The catch, and the reason for the S3 gateway endpoint below: sts, s3 and
    // ses are IPv4-only on their standard endpoints. Nothing here needs STS
    // (Lambda credentials come from the runtime's link-local endpoint) or SES
    // (Cognito sends the invitation and OTP emails itself), and presigning an
    // S3 URL is a local signature. Real S3 calls -- deleting a replaced photo
    // -- go over IPv4 through the gateway endpoint, which works without NAT
    // because the ENI still has an IPv4 address in its subnet.
    //
    // If a future feature needs an AWS API that has no IPv6 endpoint, add an
    // interface endpoint for it rather than reaching for NAT.
    // -------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      ipProtocol: ec2.IpProtocol.DUAL_STACK,
      subnetConfiguration: [
        {
          // The Flyway task runs here with a public IP so it can pull its image
          // from ECR without NAT.
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
          mapPublicIpOnLaunch: false,
        },
        {
          // The Lambda and the database. "Isolated" refers to IPv4: there is no
          // IPv4 route out, but CDK gives dual-stack private subnets an
          // egress-only internet gateway route for IPv6.
          name: "private",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // Free, and the only way the Lambda can make a real S3 call without NAT.
    vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // CDK gives PRIVATE_ISOLATED subnets no default route of any kind -- that
    // is what "isolated" means to it -- so the egress-only internet gateway and
    // the ::/0 route have to be added by hand. Without them the Lambda still
    // gets an IPv6 address and still has `ipv6AllowedForDualStack`, but has
    // nowhere to send packets, and every Cognito call hangs until the function
    // times out. That failure only shows up at runtime, never at synth, which
    // is why infra/test asserts both of these exist.
    const egressOnlyIgw = new ec2.CfnEgressOnlyInternetGateway(this, "EgressOnlyIgw", {
      vpcId: vpc.vpcId,
    });
    vpc.isolatedSubnets.forEach((subnet, index) => {
      new ec2.CfnRoute(this, `PrivateIpv6EgressRoute${index}`, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationIpv6CidrBlock: "::/0",
        egressOnlyInternetGatewayId: egressOnlyIgw.ref,
      });
    });

    // -------------------------------------------------------------------
    // Database -- the cheapest managed Postgres that is still backed up.
    // Settings follow requirements/database.md exactly.
    // -------------------------------------------------------------------
    const dbSecurityGroup = new ec2.SecurityGroup(this, "DatabaseSecurityGroup", {
      vpc,
      description: "Postgres; reachable only from the API Lambda and the migration task",
      allowAllOutbound: false,
    });

    const database = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_17,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MICRO
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      databaseName: DB_NAME,
      credentials: rds.Credentials.fromGeneratedSecret("postgres"),
      // Single-AZ: Multi-AZ doubles the baseline instance cost.
      multiAz: false,
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      // Off on purpose: autoscaling makes a temporary spike in logs or a large
      // migration into a permanent, unrecoverable storage bill.
      maxAllocatedStorage: undefined,
      backupRetention: Duration.days(7),
      enablePerformanceInsights: false,
      monitoringInterval: undefined,
      publiclyAccessible: false,
      // Free, and switching it on later would require replacing the instance.
      storageEncrypted: true,
      // Lets the API authenticate with a locally-signed token instead of
      // fetching a secret at runtime -- no Secrets Manager egress needed.
      iamAuthentication: true,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
    });

    // -------------------------------------------------------------------
    // Buckets
    // -------------------------------------------------------------------
    const photosBucket = new s3.Bucket(this, "PhotosBucket", {
      removalPolicy: RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      cors: [
        {
          // Browsers PUT straight to S3 with a presigned URL, so the bucket
          // itself needs to allow the SPA's origin.
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedOrigins: [`https://${domainName}`, "http://localhost:5173"],
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          maxAge: 3000,
        },
      ],
    });

    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });

    // -------------------------------------------------------------------
    // Cognito -- passwordless email OTP for everyone, invite-only.
    // -------------------------------------------------------------------
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "church-directory",
      // Accounts only ever come from an admin invite (AdminCreateUser).
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        givenName: { required: true, mutable: true },
        familyName: { required: false, mutable: true },
        email: { required: true, mutable: true },
      },
      accountRecovery: cognito.AccountRecovery.NONE,
      removalPolicy: RemovalPolicy.RETAIN,
      featurePlan: cognito.FeaturePlan.ESSENTIALS, // required for passwordless
      signInPolicy: {
        allowedFirstAuthFactors: {
          // Cognito requires password to stay allowed at the policy level, but
          // invited users are never given one, so only email OTP is usable.
          password: true,
          emailOtp: true,
        },
      },
      email: cognito.UserPoolEmail.withSES({
        fromEmail: `no-reply@${hostedZoneName}`,
        fromName: "Parish Directory",
        sesRegion: "us-east-1",
        sesVerifiedDomain: hostedZoneName,
      }),
    });

    const userPoolClient = userPool.addClient("SpaClient", {
      authFlows: { user: true }, // enables USER_AUTH (choice-based / passwordless)
      disableOAuth: true, // the SPA calls the Auth SDK directly; no Hosted UI
      generateSecret: false,
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    // -------------------------------------------------------------------
    // API Lambda
    // -------------------------------------------------------------------
    const apiSecurityGroup = new ec2.SecurityGroup(this, "ApiSecurityGroup", {
      vpc,
      description: "API Lambda",
      allowAllOutbound: true,
    });
    dbSecurityGroup.addIngressRule(apiSecurityGroup, ec2.Port.tcp(5432), "API Lambda to Postgres");

    const apiLogGroup = new logs.LogGroup(this, "ApiLogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const apiFn = new NodejsFunction(this, "ApiFunction", {
      entry: path.join(__dirname, "..", "..", "api", "src", "api.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(20),
      bundling: { minify: true, target: "node22" },
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [apiSecurityGroup],
      // The whole point of the dual-stack VPC: without this the function has no
      // route out at all and every Cognito call would hang until timeout.
      ipv6AllowedForDualStack: true,
      logGroup: apiLogGroup,
      environment: {
        DB_HOST: database.dbInstanceEndpointAddress,
        DB_PORT: database.dbInstanceEndpointPort,
        DB_NAME,
        DB_USER: APP_DB_ROLE,
        DB_AUTH: "iam",
        PHOTOS_BUCKET: photosBucket.bucketName,
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
        SITE_URL: `https://${domainName}`,
        FROM_EMAIL: `no-reply@${hostedZoneName}`,
      },
    });

    // IAM database authentication: `rds-db:connect` on the resource id of the
    // instance plus the Postgres role name. No password anywhere.
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["rds-db:connect"],
        resources: [
          `arn:aws:rds-db:${this.region}:${this.account}:dbuser:${database.instanceResourceId}/${APP_DB_ROLE}`,
        ],
      })
    );
    photosBucket.grantReadWrite(apiFn);
    photosBucket.grantDelete(apiFn);
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail"],
        resources: [`arn:aws:ses:${this.region}:${this.account}:identity/${hostedZoneName}`],
      })
    );
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminUpdateUserAttributes",
          "cognito-idp:AdminDisableUser",
          "cognito-idp:AdminEnableUser",
          "cognito-idp:AdminDeleteUser",
        ],
        resources: [userPool.userPoolArn],
      })
    );

    // -------------------------------------------------------------------
    // Flyway migrations -- a one-off Fargate task run by the CD workflow.
    //
    // The database is private, so CI cannot reach it directly. The SQL is baked
    // into an image alongside Flyway, so what runs is pinned to the commit
    // being deployed. The task runs in a public subnet with a public IP purely
    // so it can pull that image without a NAT gateway.
    // -------------------------------------------------------------------
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    });

    const migrationSecurityGroup = new ec2.SecurityGroup(this, "MigrationSecurityGroup", {
      vpc,
      description: "Flyway migration task",
      allowAllOutbound: true,
    });
    dbSecurityGroup.addIngressRule(
      migrationSecurityGroup,
      ec2.Port.tcp(5432),
      "Flyway migration task to Postgres"
    );

    // ARM64 for the same reasons as the Lambda: Fargate Graviton is cheaper,
    // and the image builds natively on an Apple Silicon laptop instead of
    // through emulation, which is slow enough to look like a hang.
    const migrationImage = new ecrAssets.DockerImageAsset(this, "MigrationImage", {
      directory: path.join(__dirname, "..", "..", "db"),
      platform: ecrAssets.Platform.LINUX_ARM64,
    });

    const migrationTask = new ecs.FargateTaskDefinition(this, "MigrationTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const migrationLogGroup = new logs.LogGroup(this, "MigrationLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    migrationTask.addContainer("flyway", {
      image: ecs.ContainerImage.fromDockerImageAsset(migrationImage),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "flyway",
        logGroup: migrationLogGroup,
      }),
      environment: {
        FLYWAY_URL: `jdbc:postgresql://${database.dbInstanceEndpointAddress}:${database.dbInstanceEndpointPort}/${DB_NAME}`,
        FLYWAY_PLACEHOLDERS_APPROLE: APP_DB_ROLE,
        // Flyway fails on an unresolved placeholder, so this has to be set --
        // but the branch of V2__app_role.sql that uses it only runs on a
        // database with no `rds_iam` role, i.e. never here. Not a credential.
        FLYWAY_PLACEHOLDERS_APPROLELOCALPASSWORD: "unused-on-rds-iam-auth-only",
        FLYWAY_PLACEHOLDERS_SUPERADMINEMAIL: superAdminEmail,
      },
      secrets: {
        // Injected by ECS at start-up, so the credentials never appear in the
        // task definition or in the CI logs.
        FLYWAY_USER: ecs.Secret.fromSecretsManager(database.secret!, "username"),
        FLYWAY_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, "password"),
      },
    });

    // -------------------------------------------------------------------
    // HTTP API
    // -------------------------------------------------------------------
    const issuer = `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`;
    const authorizer = new HttpJwtAuthorizer("JwtAuthorizer", issuer, {
      jwtAudience: [userPoolClient.userPoolClientId],
    });

    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: "church-directory-api",
      defaultAuthorizer: authorizer,
    });

    const apiIntegration = new HttpLambdaIntegration("ApiIntegration", apiFn);

    httpApi.addRoutes({
      path: "/api/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: apiIntegration,
    });

    // The health check has to opt out of the authorizer here, not in the Hono
    // app: with a default authorizer on the API, API Gateway rejects the
    // request before the Lambda ever runs, so an in-code exemption is dead
    // code. A specific static path takes precedence over the greedy proxy
    // route, so this wins for GET /api/health.
    httpApi.addRoutes({
      path: "/api/health",
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration,
      authorizer: new apigwv2.HttpNoneAuthorizer(),
    });

    // -------------------------------------------------------------------
    // CloudFront -- SPA at "/", API at "/api/*" on the same origin (no CORS)
    // -------------------------------------------------------------------
    const certificate = acm.Certificate.fromCertificateArn(this, "Certificate", certificateArn);
    const apiDomain = `${httpApi.apiId}.execute-api.${this.region}.amazonaws.com`;

    // This app has real client-side routes, so a deep link like /dates has to
    // serve index.html. Distribution-wide custom error responses are the wrong
    // tool: they would also rewrite genuine 403/404 JSON coming back from
    // /api/*. A viewer-request function on the default behaviour only touches
    // SPA paths, and leaves anything with a file extension alone so assets
    // still resolve.
    const spaFallback = new cloudfront.Function(this, "SpaFallback", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  // Anything with an extension is a real file: /assets/index-abc123.js, /favicon.ico
  if (uri.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}
      `),
    });

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      domainNames: [domainName],
      certificate,
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          {
            function: spaFallback,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        "/api/*": {
          origin: new origins.HttpOrigin(apiDomain, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          // Deliberately no function here: /api/* must pass through untouched.
        },
      },
    });

    // -------------------------------------------------------------------
    // DNS
    // -------------------------------------------------------------------
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId,
      zoneName: hostedZoneName,
    });
    new route53.ARecord(this, "AliasRecord", {
      zone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });
    new route53.AaaaRecord(this, "AliasRecordV6", {
      zone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    // -------------------------------------------------------------------
    // Deployment identity
    //
    // The GitHub Actions role and the account's OIDC provider are *not*
    // created here, and that is deliberate. Both are account-level, both are
    // unique by name, and CDK creating the role would be circular: the very
    // first deploy would have to come from a laptop, which is exactly the
    // machine that cannot publish assets. Creating them once out-of-band with
    // scripts/create-deploy-role.sh (IAM calls only, no asset upload) means
    // GitHub Actions can run every deploy including the first.
    //
    // Referenced rather than ignored so the grants below stay in the stack and
    // the role's ARN appears in the outputs.
    // -------------------------------------------------------------------
    const deployRole = iam.Role.fromRoleName(this, "GitHubDeployRole", DEPLOY_ROLE_NAME, {
      // The out-of-band script owns this role's permissions; do not let the
      // stack drift them.
      mutable: false,
    });

    // -------------------------------------------------------------------
    // Outputs -- read by .github/workflows/deploy.yml
    // -------------------------------------------------------------------
    new CfnOutput(this, "SiteUrl", { value: `https://${domainName}` });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "HttpApiUrl", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "SiteBucketName", { value: siteBucket.bucketName });
    new CfnOutput(this, "PhotosBucketName", { value: photosBucket.bucketName });
    new CfnOutput(this, "DistributionId", { value: distribution.distributionId });
    new CfnOutput(this, "GitHubDeployRoleArn", { value: deployRole.roleArn });
    new CfnOutput(this, "DatabaseEndpoint", { value: database.dbInstanceEndpointAddress });
    new CfnOutput(this, "DatabaseSecretArn", { value: database.secret!.secretArn });
    new CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    new CfnOutput(this, "MigrationTaskArn", { value: migrationTask.taskDefinitionArn });
    new CfnOutput(this, "MigrationSubnetIds", {
      value: vpc.publicSubnets.map((s) => s.subnetId).join(","),
    });
    new CfnOutput(this, "MigrationSecurityGroupId", {
      value: migrationSecurityGroup.securityGroupId,
    });
    // So the deploy workflow can print Flyway's output without needing
    // ecs:DescribeTaskDefinition, which AWS does not allow to be scoped.
    new CfnOutput(this, "MigrationLogGroup", { value: migrationLogGroup.logGroupName });
  }
}
