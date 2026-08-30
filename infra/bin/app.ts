#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { ChurchDirectoryStack } from "../lib/church-directory-stack";

const app = new cdk.App();

const account = process.env.CDK_DEFAULT_ACCOUNT ?? "435432815368";
// SES (pauldev.io) and the *.pauldev.io ACM cert both already live in
// us-east-1, so deploying everything there keeps it in one region and lets
// CloudFront reference the cert without a cross-region lookup.
const region = "us-east-1";

// Seeded into app_users by V3__bootstrap_super_admin.sql and bound to a Cognito
// user on first sign-in. Also passed to Flyway as a placeholder.
const superAdminEmail = app.node.tryGetContext("superAdminEmail") ?? "paul@paulschlueter.com";

new ChurchDirectoryStack(app, "ChurchDirectoryStack", {
  env: { account, region },
  superAdminEmail,
  domainName: "directory.pauldev.io",
  hostedZoneId: "Z0005541NUHRO213TE6L",
  hostedZoneName: "pauldev.io",
  certificateArn:
    "arn:aws:acm:us-east-1:435432815368:certificate/e2fec70c-b80c-4143-b853-105c118d4749",
});

// Every resource is tagged so this project's cost can be tracked on its own.
cdk.Tags.of(app).add("Project", "all-saints");
