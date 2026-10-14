import type {
  CreateAuthChallengeTriggerEvent,
  DefineAuthChallengeTriggerEvent,
  VerifyAuthChallengeResponseTriggerEvent,
} from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ATTEMPTS,
  createAuthChallenge,
  defineAuthChallenge,
  generateCode,
  handler,
  verifyAuthChallenge,
} from "../src/auth-challenge";

// vi.mock is hoisted above the imports, so the factory reads this lazily.
const sendSignInCodeEmail = vi.fn((_: { to: string; code: string }) => Promise.resolve());
vi.mock("../src/email", () => ({
  sendSignInCodeEmail: (params: { to: string; code: string }) => sendSignInCodeEmail(params),
}));

type Round = DefineAuthChallengeTriggerEvent["request"]["session"][number];

const custom = (challengeResult: boolean, challengeMetadata = "CODE-123456"): Round => ({
  challengeName: "CUSTOM_CHALLENGE",
  challengeResult,
  challengeMetadata,
});

function defineEvent(session: Round[], userNotFound = false): DefineAuthChallengeTriggerEvent {
  return {
    triggerSource: "DefineAuthChallenge_Authentication",
    request: { userAttributes: {}, session, userNotFound },
    response: {},
  } as unknown as DefineAuthChallengeTriggerEvent;
}

function createEvent(session: Round[], userNotFound = false): CreateAuthChallengeTriggerEvent {
  return {
    triggerSource: "CreateAuthChallenge_Authentication",
    request: {
      userAttributes: userNotFound ? {} : { email: "someone@example.com" },
      challengeName: "CUSTOM_CHALLENGE",
      session,
      userNotFound,
    },
    response: {},
  } as unknown as CreateAuthChallengeTriggerEvent;
}

function verifyEvent(expected: string, answer: string): VerifyAuthChallengeResponseTriggerEvent {
  return {
    triggerSource: "VerifyAuthChallengeResponse_Authentication",
    request: {
      userAttributes: {},
      privateChallengeParameters: { code: expected },
      challengeAnswer: answer,
    },
    response: {},
  } as unknown as VerifyAuthChallengeResponseTriggerEvent;
}

describe("generateCode", () => {
  it("is always exactly six digits, leading zeros included", () => {
    for (let i = 0; i < 2000; i++) expect(generateCode()).toMatch(/^\d{6}$/);
  });
});

describe("defineAuthChallenge", () => {
  it("starts with our challenge", async () => {
    const { response } = await defineAuthChallenge(defineEvent([]));
    expect(response).toMatchObject({
      challengeName: "CUSTOM_CHALLENGE",
      issueTokens: false,
      failAuthentication: false,
    });
  });

  it("issues tokens once the code is right", async () => {
    const { response } = await defineAuthChallenge(defineEvent([custom(false), custom(true)]));
    expect(response).toMatchObject({ issueTokens: true, failAuthentication: false });
  });

  it("asks again after a wrong code with tries left", async () => {
    const session = Array.from({ length: MAX_ATTEMPTS - 1 }, () => custom(false));
    const { response } = await defineAuthChallenge(defineEvent(session));
    expect(response).toMatchObject({
      challengeName: "CUSTOM_CHALLENGE",
      failAuthentication: false,
    });
  });

  it(`fails after ${MAX_ATTEMPTS} wrong codes`, async () => {
    const session = Array.from({ length: MAX_ATTEMPTS }, () => custom(false));
    const { response } = await defineAuthChallenge(defineEvent(session));
    expect(response).toMatchObject({ issueTokens: false, failAuthentication: true });
  });

  it("refuses any other kind of challenge", async () => {
    const { response } = await defineAuthChallenge(
      defineEvent([{ challengeName: "PASSWORD_VERIFIER", challengeResult: true } as Round])
    );
    expect(response).toMatchObject({ issueTokens: false, failAuthentication: true });
  });

  it("treats an unknown address like any other, so it cannot be probed", async () => {
    const { response } = await defineAuthChallenge(defineEvent([], true));
    expect(response).toMatchObject({
      challengeName: "CUSTOM_CHALLENGE",
      failAuthentication: false,
    });
  });
});

describe("createAuthChallenge", () => {
  beforeEach(() => sendSignInCodeEmail.mockClear());

  it("emails a new six-digit code on the first round", async () => {
    const { response } = await createAuthChallenge(createEvent([]));

    const code = response.privateChallengeParameters.code;
    expect(code).toMatch(/^\d{6}$/);
    expect(sendSignInCodeEmail).toHaveBeenCalledExactlyOnceWith({
      to: "someone@example.com",
      code,
    });
    expect(response.challengeMetadata).toBe(`CODE-${code}`);
    // The code must never reach the client.
    expect(JSON.stringify(response.publicChallengeParameters)).not.toContain(code);
  });

  it("reuses the code already sent after a wrong answer, without a second email", async () => {
    const { response } = await createAuthChallenge(createEvent([custom(false, "CODE-042042")]));

    expect(response.privateChallengeParameters.code).toBe("042042");
    expect(sendSignInCodeEmail).not.toHaveBeenCalled();
  });

  it("sends nothing for an unknown address, but looks the same", async () => {
    const { response } = await createAuthChallenge(createEvent([], true));

    expect(sendSignInCodeEmail).not.toHaveBeenCalled();
    expect(response.publicChallengeParameters).toEqual({});
    expect(response.privateChallengeParameters.code).toMatch(/^\d{6}$/);
  });
});

describe("verifyAuthChallenge", () => {
  it.each([
    ["the right code", "123456", true],
    ["the right code with stray spaces", " 123456 ", true],
    ["a wrong code", "654321", false],
    ["too short", "12345", false],
    ["too long", "1234567", false],
    ["empty", "", false],
  ])("%s", async (_, answer, correct) => {
    const { response } = await verifyAuthChallenge(verifyEvent("123456", answer));
    expect(response.answerCorrect).toBe(correct);
  });
});

describe("handler", () => {
  it("routes each trigger to its function", async () => {
    const define = await handler(defineEvent([]));
    expect((define as DefineAuthChallengeTriggerEvent).response.challengeName).toBe(
      "CUSTOM_CHALLENGE"
    );
    const verify = await handler(verifyEvent("123456", "123456"));
    expect((verify as VerifyAuthChallengeResponseTriggerEvent).response.answerCorrect).toBe(true);
  });

  it("rejects a trigger it does not handle", async () => {
    await expect(
      handler({ triggerSource: "PreSignUp_SignUp" } as unknown as DefineAuthChallengeTriggerEvent)
    ).rejects.toThrow(/Unexpected trigger/);
  });
});
