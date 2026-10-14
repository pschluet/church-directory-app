import { randomInt, timingSafeEqual } from "node:crypto";
import type {
  CreateAuthChallengeTriggerEvent,
  DefineAuthChallengeTriggerEvent,
  VerifyAuthChallengeResponseTriggerEvent,
} from "aws-lambda";
import { sendSignInCodeEmail } from "./email";

/**
 * Sign-in: a 6-digit code, emailed, through Cognito's custom auth flow.
 *
 * Cognito's built-in passwordless EMAIL_OTP would do all of this for us, but
 * its sign-in code is always 8 digits and the length is not configurable. Six
 * is what people are used to typing from an email, so the code is ours: the
 * three triggers below generate it, send it and check it, and Cognito only
 * keeps the session and issues the tokens.
 *
 * One Lambda serves all three triggers (see `handler`). A sign-in calls them
 * back to back, so a single function pays at most one cold start and stays
 * warm for the rest of the flow.
 *
 * How long a code lives is the app client's `authSessionValidity`, set in the
 * stack: when that session lapses Cognito rejects the answer itself.
 */

/** Wrong answers allowed before the attempt ends and a new code is needed. */
export const MAX_ATTEMPTS = 3;
export const CODE_LENGTH = 6;

const CODE_PREFIX = "CODE-";

/** Uniform over 000000-999999; `randomInt` is the CSPRNG, not Math.random. */
export function generateCode(): string {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
}

export async function defineAuthChallenge(
  event: DefineAuthChallengeTriggerEvent
): Promise<DefineAuthChallengeTriggerEvent> {
  const session = event.request.session;
  const last = session.at(-1);

  // Anything but our own challenge in the session (a password, SRP) is not a
  // sign-in this app offers.
  if (session.some((round) => round.challengeName !== "CUSTOM_CHALLENGE")) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
  } else if (last?.challengeResult === true) {
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
  } else if (session.length >= MAX_ATTEMPTS) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
  } else {
    event.response.issueTokens = false;
    event.response.failAuthentication = false;
    event.response.challengeName = "CUSTOM_CHALLENGE";
  }
  return event;
}

export async function createAuthChallenge(
  event: CreateAuthChallengeTriggerEvent
): Promise<CreateAuthChallengeTriggerEvent> {
  const email = event.request.userAttributes.email ?? "";

  // A retry after a typo keeps the code already in the inbox: a fresh one per
  // wrong answer would mean a second email, and the first code going stale
  // while someone is still reading it.
  const previous = event.request.session.at(-1)?.challengeMetadata?.startsWith(CODE_PREFIX)
    ? event.request.session.at(-1)?.challengeMetadata?.slice(CODE_PREFIX.length)
    : undefined;

  const code = previous ?? generateCode();
  // An address with no account goes through the same steps, minus the email,
  // so the code screen looks identical either way and nobody can probe which
  // addresses are in the directory. No code it is given will ever match.
  if (!previous && !event.request.userNotFound) {
    await sendSignInCodeEmail({ to: email, code });
  }

  // Nothing public: the client already knows the address it typed, and an
  // empty one here for a missing account would give the game away.
  event.response.publicChallengeParameters = {};
  event.response.privateChallengeParameters = { code };
  // Never returned to the client; it is how the next round finds the code.
  event.response.challengeMetadata = `${CODE_PREFIX}${code}`;
  return event;
}

export async function verifyAuthChallenge(
  event: VerifyAuthChallengeResponseTriggerEvent
): Promise<VerifyAuthChallengeResponseTriggerEvent> {
  const expected = Buffer.from(event.request.privateChallengeParameters.code ?? "");
  const answer = Buffer.from(String(event.request.challengeAnswer ?? "").trim());
  // timingSafeEqual throws on a length mismatch, which is itself a wrong answer.
  event.response.answerCorrect =
    expected.length === CODE_LENGTH &&
    answer.length === expected.length &&
    timingSafeEqual(answer, expected);
  return event;
}

type AuthChallengeEvent =
  | DefineAuthChallengeTriggerEvent
  | CreateAuthChallengeTriggerEvent
  | VerifyAuthChallengeResponseTriggerEvent;

export async function handler(event: AuthChallengeEvent): Promise<AuthChallengeEvent> {
  switch (event.triggerSource) {
    case "DefineAuthChallenge_Authentication":
      return defineAuthChallenge(event);
    case "CreateAuthChallenge_Authentication":
      return createAuthChallenge(event);
    case "VerifyAuthChallengeResponse_Authentication":
      return verifyAuthChallenge(event);
    default:
      throw new Error(`Unexpected trigger: ${(event as { triggerSource: string }).triggerSource}`);
  }
}
