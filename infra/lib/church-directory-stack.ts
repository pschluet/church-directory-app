import * as path from "node:path";
import { Stack, type StackProps, RemovalPolicy, Duration, CfnOutput } from "aws-cdk-lib";
import type { Construct } from "constructs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
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
  /**
   * The RSA keypair CloudFront uses to gate photo reads.
   *
   * Generated once, out of band, by scripts/create-photo-key.sh -- CDK cannot
   * create a keypair, and a private key in the template would be readable by
   * anyone who can describe the stack. The public half is committed (it is
   * public by definition); the private half arrives from a GitHub Actions
   * secret through CDK context and lands in a Lambda environment variable,
   * which the runtime decrypts with no network call. That last part matters:
   * this VPC has no route to Secrets Manager or SSM (see the networking
   * comment below), so the usual homes for a secret are unreachable.
   */
  readonly photoPublicKeyPem: string;
  readonly photoPrivateKeyPem: string;
  /**
   * The VAPID keypair Web Push is signed with, base64url. Generated once, out
   * of band, by scripts/create-push-key.sh -- for the same two reasons as the
   * photo keypair above, and delivered the same way: the public half committed,
   * the private half from a GitHub Actions secret into a Lambda environment
   * variable that the runtime decrypts with no network call.
   *
   * Both empty when the parish has no keypair yet. That is a supported state,
   * not a broken one: prayer requests still work, they simply arrive without a
   * push notification. `assertPushConfig` in api/src/services/push.ts is what
   * refuses the half-configured case.
   *
   * There is nothing to add to the network for this. Web Push reaches
   * web.push.apple.com, fcm.googleapis.com and Mozilla's endpoint over IPv6 --
   * all three publish AAAA records -- so it works through the egress-only
   * gateway below with no NAT and no interface endpoint. See the networking
   * comment.
   */
  readonly vapidPublicKey: string;
  readonly vapidPrivateKey: string;
  /** `mailto:` or a URL, so a push service can reach the sender. */
  readonly vapidSubject: string;
}

/**
 * The GitHub Actions deploy role. Created once by
 * scripts/create-deploy-role.sh, referenced here.
 */
const DEPLOY_ROLE_NAME = "church-directory-github-deploy";

/** The Postgres role the API connects as; created by V2__app_role.sql. */
const APP_DB_ROLE = "directory_app";

/**
 * The sender name on every message this app sends.
 *
 * Defined once and used twice -- Cognito's one-time sign-in code, and the
 * invitation the API sends itself through SES -- because the whole point is
 * that a new member sees the same sender on both. They used to disagree: the
 * code came from "Parish Directory" and the invitation from a bare address with
 * no display name at all.
 *
 * It matches the installed app's name deliberately, so a member who has the
 * directory on their home screen recognises the email as coming from it.
 */
const EMAIL_FROM_NAME = "Directory";
const DB_NAME = "directory";

export class ChurchDirectoryStack extends Stack {
  constructor(scope: Construct, id: string, props: ChurchDirectoryStackProps) {
    super(scope, id, props);

    const {
      superAdminEmail,
      domainName,
      hostedZoneId,
      hostedZoneName,
      certificateArn,
      photoPublicKeyPem,
      photoPrivateKeyPem,
      vapidPublicKey,
      vapidPrivateKey,
      vapidSubject,
    } = props;

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
    // ses are IPv4-only on their *standard* endpoints. Nothing here needs STS
    // (Lambda credentials come from the runtime's link-local endpoint); SES has
    // a dual-stack endpoint the client opts into (see api/src/email.ts); and
    // presigning an S3 URL is a local signature. Real S3 calls -- deleting a
    // replaced photo -- go over IPv4 through the gateway endpoint, which works
    // without NAT because the ENI still has an IPv4 address in its subnet.
    //
    // If a future feature needs an AWS API that has no IPv6 endpoint, add an
    // interface endpoint for it rather than reaching for NAT.
    //
    // Web Push is the one call out of here that is not to AWS at all, and it
    // needed nothing: `web.push.apple.com`, `fcm.googleapis.com` and
    // `updates.push.services.mozilla.com` all publish AAAA records, so the
    // sends go out over IPv6 like the Cognito calls do.
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
    // Storage alarm -- the one thing that can stop every write at once.
    //
    // `maxAllocatedStorage` above is disabled on purpose, which makes 20 GiB a
    // hard ceiling rather than a soft one. Postgres does not degrade gracefully
    // when it arrives: RDS moves the instance to `storage-full` and writes
    // start failing, so nobody can save a phone number or post a prayer request
    // until somebody resizes the volume. Growth is slow, entirely invisible
    // from inside the app, and nothing prunes -- notifications, audit_log and
    // prayer_requests only ever get longer -- so "somebody notices" has to be a
    // notification rather than a habit of checking.
    //
    // This does not contradict the blueprint in requirements/database.md. What
    // that switches off, Performance Insights and Enhanced Monitoring, is
    // billed per instance per month. `FreeStorageSpace` is a metric RDS already
    // publishes for free, and CloudWatch's perpetual free tier covers ten
    // standard alarms, so this is monitoring that costs nothing to keep.
    //
    // Nothing is needed from the VPC for it either. The alarm is evaluated by
    // CloudWatch and published by SNS, both outside the network, so this works
    // despite the private subnets having no route to either service.
    // -------------------------------------------------------------------
    const dbStorageAlarmTopic = new sns.Topic(this, "DatabaseStorageAlarmTopic", {
      displayName: "Church directory database storage",
    });

    // Email, to the address the stack already requires: there is no on-call
    // rotation for a parish directory, and the super admin is the person who
    // would have to act on this anyway.
    //
    // One manual step comes with it. SNS sends a confirmation link that has to
    // be clicked once, and until it is, the alarm fires into nothing -- an
    // unconfirmed subscription looks identical to a working one from the alarm
    // view, so this is worth verifying after the first deploy rather than
    // assuming.
    dbStorageAlarmTopic.addSubscription(new snsSubscriptions.EmailSubscription(superAdminEmail));

    // 20% of the 20 GiB allocated above, picked for lead time rather than
    // urgency. At the tens of megabytes a year this database actually grows,
    // 4 GiB is years of warning; and it still leaves room to react if a
    // migration or a runaway table consumes the volume much faster than that.
    const dbFreeStorageThresholdBytes = 4 * 1024 ** 3;

    const dbStorageAlarm = database
      .metricFreeStorageSpace({
        // The low-water mark over the hour, not the average. A volume that dips
        // below the threshold while a migration or a vacuum runs is exactly the
        // event this exists to catch, and averaging would smooth it away.
        statistic: "Minimum",
        period: Duration.hours(1),
      })
      .createAlarm(this, "DatabaseFreeStorageAlarm", {
        alarmName: "church-directory-database-storage-low",
        alarmDescription:
          "Less than 4 GiB free on the church directory database. Storage autoscaling is " +
          "disabled, so this will not resolve itself: raise allocatedStorage in " +
          "infra/lib/church-directory-stack.ts, or prune the notifications table.",
        threshold: dbFreeStorageThresholdBytes,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        // A metric that stops arriving means the instance is not reporting,
        // which is an availability problem and not this alarm's job. Treating
        // it as breaching would turn every maintenance window into a storage
        // warning nobody should act on.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

    dbStorageAlarm.addAlarmAction(new cloudwatchActions.SnsAction(dbStorageAlarmTopic));

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
          // itself needs to allow the SPA's origin. GET is deliberately absent:
          // reads go through CloudFront on the site's own origin, so they are
          // not cross-origin at all.
          allowedMethods: [s3.HttpMethods.PUT],
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
    // Photo delivery
    //
    // The photos bucket is private and is not a website. CloudFront reaches it
    // with an Origin Access Control, and the /photos/* behaviour is restricted
    // to viewers holding a signature from this key group -- the cookies
    // api/src/photo-cookies.ts issues on GET /me.
    //
    // The alternative, a presigned GET per object, is what this replaces: the
    // signature changes on every response, so the URL changes, so the browser
    // cache never hits and a directory page re-downloads every face. These
    // paths are permanent and cacheable at the edge instead.
    // -------------------------------------------------------------------
    const photoPublicKey = new cloudfront.PublicKey(this, "PhotoPublicKey", {
      encodedKey: photoPublicKeyPem,
      comment: "Signs church directory photo cookies",
    });
    const photoKeyGroup = new cloudfront.KeyGroup(this, "PhotoKeyGroup", {
      items: [photoPublicKey],
      comment: "Trusted signers for /photos/*",
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
        fromName: EMAIL_FROM_NAME,
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
      // Both, and the IPv6 one is not optional: `allowAllOutbound` emits only
      // the 0.0.0.0/0 egress rule, which covers the database and the S3
      // gateway endpoint but silently drops every packet to Cognito and SES --
      // the two calls that leave the VPC, and both of them over IPv6. The
      // symptom is an invite that hangs until the function times out.
      allowAllOutbound: true,
      allowAllIpv6Outbound: true,
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
        // Passed rather than duplicated in api/src/email.ts, so this stack is
        // the only place the sender name is written down.
        FROM_NAME: EMAIL_FROM_NAME,
        // Encrypted at rest with the AWS-managed Lambda key and decrypted by
        // the runtime, so reading it costs no network call -- which is the only
        // way a secret can work in this VPC. See the props comment.
        CLOUDFRONT_PRIVATE_KEY: photoPrivateKeyPem,
        CLOUDFRONT_KEY_PAIR_ID: photoPublicKey.publicKeyId,
        // Web Push. Same delivery as CLOUDFRONT_PRIVATE_KEY above and for the
        // same reason -- Secrets Manager and SSM are both unreachable from
        // this VPC. Empty when no keypair has been created yet, which the API
        // reads as "push is not configured here".
        VAPID_PUBLIC_KEY: vapidPublicKey,
        VAPID_PRIVATE_KEY: vapidPrivateKey,
        VAPID_SUBJECT: vapidSubject,
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
    // Bastion -- the only route a database client on a laptop has to the
    // instance, which sits in an isolated subnet by design.
    //
    // Deliberately kept stopped: ~$3/month running, ~$0.64/month for the root
    // volume when it is not. scripts/db-tunnel.sh starts it, forwards a local
    // port to Postgres and stops it again on exit; the idle timer in the user
    // data below is the backstop for when that script is killed before its
    // trap can run.
    // -------------------------------------------------------------------
    const bastionSecurityGroup = new ec2.SecurityGroup(this, "BastionSecurityGroup", {
      vpc,
      description: "Bastion; no inbound rules at all -- access is via SSM",
      allowAllOutbound: true,
    });

    const bastionUserData = ec2.UserData.forLinux();
    bastionUserData.addCommands(
      // Stops the instance once nothing is using it, so a tunnel script that
      // was killed without running its trap cannot leave it billing. `set -e`
      // is left off on purpose: a probe that fails should not abort the check
      // and quietly disable the shutdown.
      `cat >/usr/local/bin/bastion-idle-stop <<'SCRIPT'
#!/usr/bin/env bash
set -uo pipefail

IDLE_LIMIT=1200
MARKER=/run/bastion-idle-since

busy=no
if pgrep -f ssm-session-worker >/dev/null 2>&1; then
  busy=yes
elif [ -n "$(ss -Htn state established '( sport = :5432 or dport = :5432 )' 2>/dev/null || true)" ]; then
  busy=yes
fi

if [ "$busy" = yes ]; then
  rm -f "$MARKER"
  exit 0
fi

now="$(date +%s)"
if [ ! -f "$MARKER" ]; then
  echo "$now" >"$MARKER"
  exit 0
fi

idle_for=$(( now - $(cat "$MARKER") ))
if [ "$idle_for" -ge "$IDLE_LIMIT" ]; then
  logger -t bastion-idle-stop "idle for $idle_for seconds, stopping"
  shutdown -h now
fi
SCRIPT`,
      "chmod +x /usr/local/bin/bastion-idle-stop",
      `cat >/etc/systemd/system/bastion-idle-stop.service <<'UNIT'
[Unit]
Description=Stop the bastion when nothing is using it

[Service]
Type=oneshot
ExecStart=/usr/local/bin/bastion-idle-stop
UNIT`,
      `cat >/etc/systemd/system/bastion-idle-stop.timer <<'UNIT'
[Unit]
Description=Check every five minutes whether the bastion is idle

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT`,
      // The units live on the root volume, so enabling the timer once is
      // enough -- it comes back on its own after every stop/start.
      "systemctl daemon-reload",
      "systemctl enable --now bastion-idle-stop.timer"
    );

    const bastion = new ec2.Instance(this, "Bastion", {
      vpc,
      // A public subnet with a public IP, for the same reason the Flyway task
      // runs there: the SSM agent has to reach ssmmessages, and the only other
      // way out of this VPC over IPv4 would be three interface endpoints at
      // ~$7/month each. `mapPublicIpOnLaunch` is false on the subnet, so the
      // address has to be asked for here -- without it the agent never
      // registers and `start-session` fails with TargetNotConnected.
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      associatePublicIpAddress: true,
      securityGroup: bastionSecurityGroup,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.NANO
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      // Session Manager only: no key pair, no inbound rule, nothing to rotate.
      ssmSessionPermissions: true,
      httpTokens: ec2.HttpTokens.REQUIRED,
      instanceName: "church-directory-bastion",
      // The idle timer runs `shutdown -h now`. Without this an
      // instance-initiated shutdown would terminate the instance instead, and
      // nothing would say so until the next tunnel failed.
      instanceInitiatedShutdownBehavior: ec2.InstanceInitiatedShutdownBehavior.STOP,
      userData: bastionUserData,
    });

    dbSecurityGroup.addIngressRule(
      bastionSecurityGroup,
      ec2.Port.tcp(5432),
      "Bastion tunnel to Postgres"
    );

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
        "/photos/*": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(photosBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          // Every rendition is written under a ULID that is never reused, so
          // the bytes at a path never change and this can cache hard. It is
          // also why no deploy needs to invalidate /photos/*.
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          trustedKeyGroups: [photoKeyGroup],
          // Deliberately no function here either: the SPA fallback would
          // rewrite an extensionless rendition path to /index.html.
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
    new CfnOutput(this, "BastionInstanceId", { value: bastion.instanceId });
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
