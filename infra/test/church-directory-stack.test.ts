import { beforeAll, describe, expect, it } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ChurchDirectoryStack } from "../lib/church-directory-stack";
import cdkJson from "../cdk.json";

/**
 * These assertions are deliberately not a snapshot. They cover the handful of
 * properties whose failure mode is silent -- a runtime hang, a surprise bill, or
 * data exposed -- rather than a synth error someone would notice immediately.
 */
describe("ChurchDirectoryStack", () => {
  let template: Template;

  beforeAll(() => {
    // The feature flags in cdk.json change what CDK synthesizes -- without
    // them this would be asserting against a different stack than the one that
    // deploys. `requirePrivateSubnetsForEgressOnlyInternetGateway`, for one,
    // decides whether the VPC creates an egress-only gateway of its own.
    const app = new cdk.App({ context: cdkJson.context });
    const stack = new ChurchDirectoryStack(app, "TestStack", {
      env: { account: "123456789012", region: "us-east-1" },
      superAdminEmail: "test@example.com",
      domainName: "directory.example.com",
      hostedZoneId: "Z000TESTZONE",
      hostedZoneName: "example.com",
      certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/test",
    });
    cdk.Tags.of(app).add("Project", "all-saints");
    template = Template.fromStack(stack);
  });

  describe("networking", () => {
    it("has no NAT gateway", () => {
      // A NAT gateway would be roughly $32/month, more than twice the database.
      template.resourceCountIs("AWS::EC2::NatGateway", 0);
    });

    it("has an egress-only internet gateway", () => {
      template.resourceCountIs("AWS::EC2::EgressOnlyInternetGateway", 1);
    });

    it("routes ::/0 from the private subnets to it", () => {
      // Without this the API Lambda has an IPv6 address but nowhere to send
      // packets, and every Cognito call hangs until the function times out --
      // a failure that never shows up at synth time.
      const routes = template.findResources("AWS::EC2::Route", {
        Properties: {
          DestinationIpv6CidrBlock: "::/0",
          EgressOnlyInternetGatewayId: Match.anyValue(),
        },
      });
      expect(Object.keys(routes)).toHaveLength(2);
    });

    it("has a free S3 gateway endpoint, since s3 has no IPv6 endpoint", () => {
      template.hasResourceProperties("AWS::EC2::VPCEndpoint", {
        VpcEndpointType: "Gateway",
      });
    });

    it("has no interface endpoints, which would be about $7/month each", () => {
      const interfaceEndpoints = template.findResources("AWS::EC2::VPCEndpoint", {
        Properties: { VpcEndpointType: "Interface" },
      });
      expect(Object.keys(interfaceEndpoints)).toHaveLength(0);
    });
  });

  describe("database", () => {
    it("matches the cost blueprint in requirements/database.md", () => {
      template.hasResourceProperties("AWS::RDS::DBInstance", {
        DBInstanceClass: "db.t4g.micro",
        MultiAZ: false,
        AllocatedStorage: "20",
        StorageType: "gp3",
        BackupRetentionPeriod: 7,
        EnablePerformanceInsights: false,
      });
    });

    it("is not reachable from the internet", () => {
      template.hasResourceProperties("AWS::RDS::DBInstance", {
        PubliclyAccessible: false,
      });
    });

    it("is encrypted at rest", () => {
      // Free, and it cannot be enabled later without replacing the instance.
      template.hasResourceProperties("AWS::RDS::DBInstance", {
        StorageEncrypted: true,
      });
    });

    it("allows IAM authentication, so no secret is fetched at runtime", () => {
      template.hasResourceProperties("AWS::RDS::DBInstance", {
        EnableIAMDatabaseAuthentication: true,
      });
    });

    it("is retained and deletion-protected", () => {
      template.hasResource("AWS::RDS::DBInstance", {
        DeletionPolicy: "Retain",
        Properties: Match.objectLike({ DeletionProtection: true }),
      });
    });

    it("only accepts connections from the API and the migration task", () => {
      const ingress = template.findResources("AWS::EC2::SecurityGroupIngress");
      const postgres = Object.values(ingress).filter(
        (r) => (r.Properties as { FromPort?: number }).FromPort === 5432
      );
      expect(postgres).toHaveLength(2);
      for (const rule of postgres) {
        const props = rule.Properties as Record<string, unknown>;
        // Sourced from a security group, never a CIDR.
        expect(props.SourceSecurityGroupId).toBeDefined();
        expect(props.CidrIp).toBeUndefined();
        expect(props.CidrIpv6).toBeUndefined();
      }
    });
  });

  describe("API Lambda", () => {
    it("runs in the VPC with IPv6 egress allowed", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Handler: "index.handler",
        VpcConfig: Match.objectLike({ Ipv6AllowedForDualStack: true }),
      });
    });

    it("connects to Postgres with IAM authentication", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: { Variables: Match.objectLike({ DB_AUTH: "iam", DB_USER: "directory_app" }) },
      });
    });

    it("is granted rds-db:connect and nothing broader", () => {
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({ Action: "rds-db:connect", Effect: "Allow" }),
          ]),
        },
      });
    });

    it("is granted only the Cognito admin actions it uses", () => {
      // The `minimizePolicies` feature flag sorts and merges statements, so
      // compare as a set rather than in declaration order.
      const policies = template.findResources("AWS::IAM::Policy");
      const cognitoActions = Object.values(policies)
        .flatMap(
          (policy) =>
            (
              policy.Properties as {
                PolicyDocument: { Statement: { Action: string | string[] }[] };
              }
            ).PolicyDocument.Statement
        )
        .flatMap((statement) =>
          (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).filter((a) =>
            a.startsWith("cognito-idp:")
          )
        );

      expect([...cognitoActions].sort()).toEqual([
        "cognito-idp:AdminCreateUser",
        "cognito-idp:AdminDeleteUser",
        "cognito-idp:AdminDisableUser",
        "cognito-idp:AdminEnableUser",
        "cognito-idp:AdminUpdateUserAttributes",
      ]);
      // No wildcard slipped in.
      expect(cognitoActions).not.toContain("cognito-idp:*");
    });
  });

  describe("Cognito", () => {
    it("does not allow self sign-up", () => {
      template.hasResourceProperties("AWS::Cognito::UserPool", {
        AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
      });
    });

    it("allows email OTP as a first auth factor", () => {
      template.hasResourceProperties("AWS::Cognito::UserPool", {
        Policies: Match.objectLike({
          SignInPolicy: { AllowedFirstAuthFactors: Match.arrayWith(["EMAIL_OTP"]) },
        }),
      });
    });

    it("sends mail through the verified SES domain", () => {
      template.hasResourceProperties("AWS::Cognito::UserPool", {
        EmailConfiguration: Match.objectLike({ From: Match.anyValue() }),
      });
    });

    it("is retained, so accounts survive a stack teardown", () => {
      template.hasResource("AWS::Cognito::UserPool", { DeletionPolicy: "Retain" });
    });
  });

  describe("HTTP API", () => {
    it("leaves the health check unauthenticated at the gateway, not just in code", () => {
      // With a default authorizer, API Gateway rejects before the Lambda runs,
      // so exempting a path inside the Hono app alone would never take effect.
      const routes = template.findResources("AWS::ApiGatewayV2::Route");
      const health = Object.values(routes).find(
        (r) => (r.Properties as { RouteKey?: string }).RouteKey === "GET /api/health"
      );
      expect(health).toBeDefined();
      expect((health!.Properties as { AuthorizationType?: string }).AuthorizationType).toBe("NONE");

      const proxy = Object.values(routes).find(
        (r) => (r.Properties as { RouteKey?: string }).RouteKey === "ANY /api/{proxy+}"
      );
      expect((proxy!.Properties as { AuthorizationType?: string }).AuthorizationType).toBe("JWT");
    });
  });

  describe("CloudFront", () => {
    it("rewrites SPA deep links on the default behaviour only", () => {
      // A distribution-wide custom error response would also rewrite genuine
      // 403/404 JSON coming back from /api/*.
      template.resourceCountIs("AWS::CloudFront::Function", 1);
      const distributions = template.findResources("AWS::CloudFront::Distribution");
      const config = Object.values(distributions)[0]!.Properties as {
        DistributionConfig: {
          DefaultCacheBehavior: { FunctionAssociations?: unknown[] };
          CacheBehaviors: { PathPattern: string; FunctionAssociations?: unknown[] }[];
          CustomErrorResponses?: unknown[];
        };
      };

      expect(config.DistributionConfig.DefaultCacheBehavior.FunctionAssociations).toHaveLength(1);
      const apiBehavior = config.DistributionConfig.CacheBehaviors.find(
        (b) => b.PathPattern === "/api/*"
      );
      expect(apiBehavior).toBeDefined();
      expect(apiBehavior?.FunctionAssociations).toBeUndefined();
      expect(config.DistributionConfig.CustomErrorResponses).toBeUndefined();
    });

    it("never caches the API", () => {
      const distributions = template.findResources("AWS::CloudFront::Distribution");
      const config = Object.values(distributions)[0]!.Properties as {
        DistributionConfig: { CacheBehaviors: { PathPattern: string; CachePolicyId: string }[] };
      };
      const apiBehavior = config.DistributionConfig.CacheBehaviors.find(
        (b) => b.PathPattern === "/api/*"
      );
      // The managed CachingDisabled policy.
      expect(apiBehavior?.CachePolicyId).toBe("4135ea2d-6df8-44a3-9df3-4b5a84be39ad");
    });
  });

  describe("buckets", () => {
    it("keeps photos forever and blocks all public access", () => {
      template.hasResource("AWS::S3::Bucket", {
        DeletionPolicy: "Retain",
        Properties: Match.objectLike({
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
        }),
      });
    });
  });

  describe("migration task", () => {
    it("runs on ARM64, so the image builds natively and Fargate costs less", () => {
      template.hasResourceProperties("AWS::ECS::TaskDefinition", {
        RuntimePlatform: {
          CpuArchitecture: "ARM64",
          OperatingSystemFamily: "LINUX",
        },
      });
    });

    it("publishes its log group, so the workflow needs no DescribeTaskDefinition", () => {
      // ecs:DescribeTaskDefinition cannot be scoped to a resource, so looking
      // the log group up at deploy time would mean granting it on "*".
      template.hasOutput("MigrationLogGroup", {});
    });

    it("takes the database credentials from Secrets Manager, not the task definition", () => {
      const tasks = template.findResources("AWS::ECS::TaskDefinition");
      const container = (
        Object.values(tasks)[0]!.Properties as {
          ContainerDefinitions: {
            Secrets?: { Name: string }[];
            Environment?: { Name: string; Value: unknown }[];
          }[];
        }
      ).ContainerDefinitions[0]!;

      expect((container.Secrets ?? []).map((s) => s.Name).sort()).toEqual([
        "FLYWAY_PASSWORD",
        "FLYWAY_USER",
      ]);
      // The one password-named plain variable is the Flyway placeholder that
      // only applies to a non-RDS database; assert it really is inert rather
      // than allowing anything password-shaped through.
      const plain = Object.fromEntries((container.Environment ?? []).map((e) => [e.Name, e.Value]));
      expect(plain.FLYWAY_PLACEHOLDERS_APPROLELOCALPASSWORD).toBe("unused-on-rds-iam-auth-only");
      expect(Object.keys(plain).filter((n) => /PASSWORD/.test(n))).toEqual([
        "FLYWAY_PLACEHOLDERS_APPROLELOCALPASSWORD",
      ]);
    });
  });

  describe("deployment identity", () => {
    it("creates neither the OIDC provider nor the deploy role", () => {
      // Both are account-level and unique by name. The OIDC provider already
      // exists (another project created it), so creating it would fail the
      // deploy with EntityAlreadyExists; and CDK owning the deploy role would
      // be circular, since the first deploy could then only come from a
      // laptop. scripts/create-deploy-role.sh owns both.
      template.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 0);
      const roles = template.findResources("AWS::IAM::Role");
      const named = Object.values(roles)
        .map((r) => (r.Properties as { RoleName?: string }).RoleName)
        .filter(Boolean);
      expect(named).not.toContain("church-directory-github-deploy");
    });

    it("still reports the deploy role in its outputs", () => {
      template.hasOutput("GitHubDeployRoleArn", {});
    });
  });

  it("tags every taggable resource for cost tracking", () => {
    const buckets = template.findResources("AWS::S3::Bucket");
    for (const bucket of Object.values(buckets)) {
      const tags = (bucket.Properties as { Tags?: { Key: string; Value: string }[] }).Tags ?? [];
      expect(tags).toEqual(expect.arrayContaining([{ Key: "Project", Value: "all-saints" }]));
    }
  });
});
