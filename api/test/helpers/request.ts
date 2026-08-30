import { createApp } from "../../src/api";
import type { Queryable } from "../../src/db";

/**
 * Calls the API the way production does.
 *
 * Rather than injecting claims through a side door, tests pass a Lambda event
 * shaped exactly as API Gateway's Cognito JWT authorizer leaves it -- including
 * the quirk that every claim arrives as a string. That means `claimsFromLambdaEvent`
 * is under test too, not bypassed.
 */
export interface Caller {
  sub: string;
  email: string;
  emailVerified?: boolean;
}

export interface ApiClient {
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
}

export function client(db: Queryable, caller: Caller | null): ApiClient {
  const app = createApp(db);

  const env = caller
    ? {
        event: {
          requestContext: {
            authorizer: {
              jwt: {
                claims: {
                  sub: caller.sub,
                  email: caller.email,
                  email_verified: String(caller.emailVerified ?? true),
                },
              },
            },
          },
        },
      }
    : {};

  return {
    async call(method, path, body) {
      const response = await app.request(
        path,
        {
          method,
          ...(body === undefined
            ? {}
            : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
        },
        env
      );
      const text = await response.text();
      return {
        status: response.status,
        body: text ? JSON.parse(text) : null,
      };
    },
  };
}
