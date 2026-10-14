import { randomBytes } from "node:crypto";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { HTTPException } from "hono/http-exception";

/**
 * Cognito account management for the invite-only sign-up flow.
 *
 * Sign-up is disabled on the user pool, so an account only ever comes into
 * existence here: an admin submits an invite and we call AdminCreateUser.
 *
 * Cognito's own invitation email is suppressed. A custom Cognito template is
 * required to contain the `{####}` placeholder -- a temporary password -- and
 * emailing a live credential nobody needs, for an app whose sign-in is a
 * one-time code, is both confusing and worse than not sending it. email.ts
 * sends the invitation instead.
 *
 * COGNITO_MODE=local short-circuits all of it so the app can run offline; the
 * caller then gets a fabricated sub and no email is sent.
 */

const MODE = (process.env.COGNITO_MODE ?? "aws") as "aws" | "local";
const USER_POOL_ID = process.env.USER_POOL_ID ?? "";

let client: CognitoIdentityProviderClient | undefined;
function cognito(): CognitoIdentityProviderClient {
  client ??= new CognitoIdentityProviderClient({
    region: process.env.AWS_REGION ?? "us-east-1",
  });
  return client;
}

export interface InvitedCognitoUser {
  /** The Cognito `sub`, stored on app_users so later sign-ins resolve directly. */
  sub: string;
}

export async function createInvitedUser(params: {
  email: string;
  firstName: string;
  lastName: string | null;
}): Promise<InvitedCognitoUser> {
  if (MODE === "local") {
    return { sub: `local-${params.email}` };
  }

  try {
    const result = await cognito().send(
      new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: params.email,
        // We send our own invitation; see email.ts.
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: params.email },
          // Sign-in is an emailed code, which proves control of the mailbox on every
          // sign-in; marking it verified here avoids a pointless second
          // confirmation step.
          { Name: "email_verified", Value: "true" },
          { Name: "given_name", Value: params.firstName },
          ...(params.lastName ? [{ Name: "family_name", Value: params.lastName }] : []),
        ],
      })
    );

    const sub = result.User?.Attributes?.find((a) => a.Name === "sub")?.Value;
    if (!sub) throw new Error("Cognito did not return a sub for the new user");
    await confirmWithoutPassword(params.email);
    return { sub };
  } catch (err) {
    if (err instanceof UsernameExistsException) {
      throw new HTTPException(409, {
        message: "Someone with that email address has already been invited",
      });
    }
    throw err;
  }
}

/**
 * AdminCreateUser leaves the account in FORCE_CHANGE_PASSWORD, and Cognito
 * answers a custom-auth sign-in from that state with NEW_PASSWORD_REQUIRED
 * instead of tokens. Setting a permanent password moves it to CONFIRMED.
 *
 * The password is random, never stored and never sent anywhere, and the app
 * client has no password flow enabled, so it cannot be used to sign in. It
 * exists only because Cognito will not confirm an account without one.
 */
async function confirmWithoutPassword(username: string): Promise<void> {
  // Mixed classes so it passes any password policy the pool might have.
  const password = `${randomBytes(32).toString("base64url")}aA1!`;
  await cognito().send(
    new AdminSetUserPasswordCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      Password: password,
      Permanent: true,
    })
  );
}

export async function updateUserEmail(username: string, email: string): Promise<void> {
  if (MODE === "local") return;
  await cognito().send(
    new AdminUpdateUserAttributesCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
      ],
    })
  );
}

/**
 * Disabling rather than deleting is the default: directory data is kept
 * forever, and a deleted Cognito user whose app_users row survives would be
 * able to sign up again and re-bind by email.
 *
 * The exception is the admin screen's permanent delete, which removes the
 * account row and this user together -- neither can outlive the other, so the
 * re-bind that makes a lone Cognito delete dangerous cannot happen.
 */
export async function setUserEnabled(username: string, enabled: boolean): Promise<void> {
  if (MODE === "local") return;
  await cognito().send(
    enabled
      ? new AdminEnableUserCommand({ UserPoolId: USER_POOL_ID, Username: username })
      : new AdminDisableUserCommand({ UserPoolId: USER_POOL_ID, Username: username })
  );
}

/**
 * Callers pass `app_users.cognito_sub`, not an email address. updateUserEmail
 * changes the email attribute and never the username, so for anyone whose
 * sign-in address has been changed the two no longer agree and only the sub
 * still identifies the user.
 */
export async function deleteUser(username: string): Promise<void> {
  if (MODE === "local") return;
  await cognito().send(
    new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: username })
  );
}
