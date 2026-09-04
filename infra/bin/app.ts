#!/usr/bin/env node
import "source-map-support/register";
import * as fs from "node:fs";
import * as path from "node:path";
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

/**
 * The CloudFront photo-signing keypair. Created once by
 * scripts/create-photo-key.sh -- the public half is committed, the private half
 * comes from the CLOUDFRONT_PRIVATE_KEY GitHub secret (or `-c photoPrivateKey=`
 * for a deploy from a laptop). Neither can be synthesised here: CDK cannot
 * generate a keypair, and a private key in the template would be readable by
 * anyone who can describe the stack.
 */
function readPhotoKeys(): { publicKeyPem: string; privateKeyPem: string } {
  const publicKeyPath = path.join(__dirname, "..", "photo-public-key.pem");
  if (!fs.existsSync(publicKeyPath)) {
    throw new Error(
      "Missing infra/photo-public-key.pem. Run ./scripts/create-photo-key.sh once, " +
        "commit the public key, and store the private key as the CLOUDFRONT_PRIVATE_KEY secret."
    );
  }
  const privateKeyPem =
    app.node.tryGetContext("photoPrivateKey") ?? process.env.CLOUDFRONT_PRIVATE_KEY;
  if (!privateKeyPem) {
    throw new Error(
      'Missing the photo signing private key. Pass -c photoPrivateKey="$(cat key.pem)" ' +
        "or set CLOUDFRONT_PRIVATE_KEY. Without it every photo returns 403."
    );
  }
  return { publicKeyPem: fs.readFileSync(publicKeyPath, "utf8"), privateKeyPem };
}

/**
 * The VAPID keypair for Web Push. Created once by scripts/create-push-key.sh.
 *
 * Unlike the photo keypair, having no keys at all is fine: a parish without them
 * posts prayer requests that simply arrive without a notification, and the API
 * treats empty values as "push is not configured".
 *
 * The committed public key is what decides whether push is switched on, and the
 * two cases are deliberately not symmetric.
 *
 * A public key with no secret behind it *throws*: browsers would happily
 * subscribe against it to a sender that can never send, and nothing downstream
 * would look wrong.
 *
 * A secret with no public key committed does not, because the setup is two
 * steps in two different places -- `gh secret set` and a commit -- and the order
 * they land in should not be able to break a deploy. Until the public key
 * arrives, push is simply off. It is warned about rather than ignored, so a
 * misplaced file is visible in the deploy log instead of silently costing
 * everyone their notifications.
 */
function readPushKeys(): { publicKey: string; privateKey: string } {
  const publicKeyPath = path.join(__dirname, "..", "push-public-key.txt");
  const privateKey = app.node.tryGetContext("vapidPrivateKey") ?? process.env.VAPID_PRIVATE_KEY;

  if (!fs.existsSync(publicKeyPath)) {
    if (privateKey) {
      console.warn(
        "A VAPID private key was supplied but infra/push-public-key.txt is missing, " +
          "so Web Push is being deployed switched off. Run ./scripts/create-push-key.sh " +
          "and commit the public key it writes."
      );
    }
    return { publicKey: "", privateKey: "" };
  }

  if (!privateKey) {
    throw new Error(
      'Missing the VAPID private key. Pass -c vapidPrivateKey="$(cat key.txt)" or set ' +
        "VAPID_PRIVATE_KEY. Without it browsers could subscribe to push that can never be sent."
    );
  }
  return {
    publicKey: fs.readFileSync(publicKeyPath, "utf8").trim(),
    privateKey: privateKey.trim(),
  };
}

const photoKeys = readPhotoKeys();
const pushKeys = readPushKeys();

new ChurchDirectoryStack(app, "ChurchDirectoryStack", {
  env: { account, region },
  superAdminEmail,
  domainName: "directory.pauldev.io",
  hostedZoneId: "Z0005541NUHRO213TE6L",
  hostedZoneName: "pauldev.io",
  certificateArn:
    "arn:aws:acm:us-east-1:435432815368:certificate/e2fec70c-b80c-4143-b853-105c118d4749",
  photoPublicKeyPem: photoKeys.publicKeyPem,
  photoPrivateKeyPem: photoKeys.privateKeyPem,
  vapidPublicKey: pushKeys.publicKey,
  vapidPrivateKey: pushKeys.privateKey,
  // The address a push service contacts if it has a problem with our sends.
  // Reuses the SES sender rather than inventing a mailbox nobody reads.
  vapidSubject: "mailto:no-reply@pauldev.io",
});

// Every resource is tagged so this project's cost can be tracked on its own.
cdk.Tags.of(app).add("Project", "all-saints");
