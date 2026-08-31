import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  confirmSignIn,
  fetchAuthSession,
  getCurrentUser,
  signIn,
  signOut as amplifySignOut,
} from "aws-amplify/auth";
import { Hub } from "aws-amplify/utils";
import { useQueryClient } from "@tanstack/react-query";
import { DEV_AUTH } from "../lib/api";

/**
 * Passwordless sign-in.
 *
 * Cognito's USER_AUTH flow with a preferred challenge of EMAIL_OTP means there
 * is no password anywhere: you enter your address, Cognito emails a one-time
 * code through SES, and you enter that. Sign-up is disabled on the pool, so
 * only people an admin has invited can get in.
 *
 * When the local API server runs with DEV_AUTH_EMAIL there is no Cognito at
 * all, so this reports "signed in" straight away and the API client sends no
 * token -- that is what lets the whole app run on a laptop with no AWS account.
 */

export type AuthStatus = "loading" | "signedOut" | "awaitingCode" | "signedIn";

interface AuthContextValue {
  status: AuthStatus;
  email: string | null;
  error: string | null;
  busy: boolean;
  /** Sends a one-time code and moves to `awaitingCode`. */
  requestCode: (email: string) => Promise<void>;
  submitCode: (code: string) => Promise<void>;
  /** Back to the email step, e.g. after a typo in the address. */
  restart: () => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function messageFor(err: unknown): string {
  if (err instanceof Error) {
    // Cognito's own wording is not something to show a parishioner.
    if (err.name === "UserNotFoundException" || err.name === "NotAuthorizedException") {
      return "We could not sign you in. Check the address, or ask an administrator to add you.";
    }
    if (err.name === "CodeMismatchException") return "That code is not right. Try again.";
    if (err.name === "ExpiredCodeException") return "That code has expired. Ask for a new one.";
    if (err.name === "LimitExceededException") {
      return "Too many attempts. Wait a few minutes and try again.";
    }
    return err.message;
  }
  return "Something went wrong. Try again.";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>(DEV_AUTH ? "signedIn" : "loading");
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (DEV_AUTH) return;
    try {
      await getCurrentUser();
      const session = await fetchAuthSession();
      const idToken = session.tokens?.idToken;
      if (!idToken) throw new Error("No ID token in session");
      setEmail((idToken.payload.email as string | undefined) ?? null);
      setStatus("signedIn");
    } catch {
      setStatus("signedOut");
      setEmail(null);
    }
  }, []);

  useEffect(() => {
    if (DEV_AUTH) return;
    void refresh();
    return Hub.listen("auth", ({ payload }) => {
      if (payload.event === "signedIn" || payload.event === "signedOut") void refresh();
    });
  }, [refresh]);

  const requestCode = useCallback(
    async (address: string) => {
      setBusy(true);
      setError(null);
      try {
        const trimmed = address.trim().toLowerCase();
        const { nextStep } = await signIn({
          username: trimmed,
          options: { authFlowType: "USER_AUTH", preferredChallenge: "EMAIL_OTP" },
        });
        setEmail(trimmed);

        if (nextStep.signInStep === "DONE") {
          await refresh();
          return;
        }
        setStatus("awaitingCode");
      } catch (err) {
        setError(messageFor(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const submitCode = useCallback(
    async (code: string) => {
      setBusy(true);
      setError(null);
      try {
        await confirmSignIn({ challengeResponse: code.trim() });
        await refresh();
      } catch (err) {
        setError(messageFor(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const restart = useCallback(() => {
    setStatus("signedOut");
    setError(null);
  }, []);

  const signOut = useCallback(async () => {
    await amplifySignOut();
    setStatus("signedOut");
    setEmail(null);
    // Otherwise the next person to sign in on this tab reads the last one's
    // directory straight out of memory before their own /me lands.
    queryClient.clear();
  }, [queryClient]);

  const value = useMemo(
    () => ({ status, email, error, busy, requestCode, submitCode, restart, signOut }),
    [status, email, error, busy, requestCode, submitCode, restart, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
