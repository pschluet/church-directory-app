import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { Button, Field, inputClass } from "../components/ui";
import { RequestAccessModal } from "../components/RequestAccessModal";

/**
 * Two steps, no password: enter your email, then the code that arrives.
 * Sign-up is disabled on the user pool, so anyone not already invited can ask
 * to be added instead -- a request an administrator approves, not an account.
 */
export function Login() {
  return (
    <div className="flex min-h-screen flex-col bg-surface-muted">
      <div className="bg-primary px-4 py-2 text-center text-sm text-white">Parish Directory</div>

      <div className="flex flex-1 items-start justify-center px-4 py-10 md:items-center md:py-16">
        <SignInForm />
      </div>
    </div>
  );
}

/**
 * The sign-in card itself, without the page around it, so an event's share
 * page (PublicEvent.tsx) can put it beside the event. Signing in from there
 * flips `useAuth().status`, which is all it takes to carry somebody on into
 * the app -- there is no redirect to remember.
 *
 * `offerRequest` is the "Request to be added" link. The share page leaves it
 * off: it offers its own way to ask, about the event in front of the reader.
 */
export function SignInForm({
  title = "Sign in",
  headingLevel = "h1",
  autoFocus = true,
  offerRequest = true,
  fullWidth = false,
}: {
  title?: string;
  headingLevel?: "h1" | "h2";
  /** Off where the form is not the only thing on the page, so it does not scroll the rest away. */
  autoFocus?: boolean;
  offerRequest?: boolean;
  /** Fill the column it is in, to line up with the cards around it, rather than the sign-in page's narrow card. */
  fullWidth?: boolean;
}) {
  const { status, email, error, busy, requestCode, submitCode, restart } = useAuth();
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [requesting, setRequesting] = useState(false);

  const awaitingCode = status === "awaitingCode";
  const Heading = headingLevel;

  return (
    <>
      <div
        className={`w-full ${fullWidth ? "" : "max-w-md"} rounded-lg border border-line bg-surface p-6 shadow-sm md:p-8`}
      >
        <Heading className="text-2xl font-bold text-ink">{title}</Heading>

        {awaitingCode ? (
          <>
            <p className="mt-2 text-ink-muted">
              We sent a 6-digit code to <span className="font-bold text-ink">{email}</span>.
            </p>

            <form
              className="mt-6 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submitCode(code);
              }}
            >
              <Field label="Your code">
                <input
                  className={`${inputClass} text-center text-2xl tracking-[0.4em]`}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  // Safe here: this is the only field on the step, and the
                  // reader has just asked for the code.
                  autoFocus
                  // No maxLength: the browser would cut a pasted "123 456" to
                  // "123 45" before the spaces could be stripped below.
                  pattern="[0-9]{6}"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                />
              </Field>

              {error && (
                <p role="alert" className="font-bold text-primary">
                  {error}
                </p>
              )}

              <Button type="submit" disabled={busy || code.length !== 6} className="w-full">
                {busy ? "Checking…" : "Sign in"}
              </Button>
              <Button variant="ghost" onClick={restart} disabled={busy} className="w-full">
                Use a different address
              </Button>
            </form>
          </>
        ) : (
          <>
            <p className="mt-2 text-ink-muted">
              There is no password. Enter your email address and we will send you a one-time code.
            </p>

            <form
              className="mt-6 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void requestCode(address);
              }}
            >
              <Field label="Email address">
                <input
                  className={inputClass}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoFocus={autoFocus}
                  required
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                />
              </Field>

              {error && (
                <p role="alert" className="font-bold text-primary">
                  {error}
                </p>
              )}

              <Button type="submit" disabled={busy || address.trim() === ""} className="w-full">
                {busy ? "Sending…" : "Send me a code"}
              </Button>
            </form>

            {offerRequest && (
              <p className="mt-6 border-t border-line pt-4 text-sm text-ink-muted">
                Not in the directory yet?{" "}
                <button
                  type="button"
                  className="font-bold text-primary underline-offset-2 hover:text-accent hover:underline"
                  onClick={() => setRequesting(true)}
                >
                  Request to be added
                </button>
              </p>
            )}
          </>
        )}
      </div>

      {requesting && (
        <RequestAccessModal initialEmail={address.trim()} onClose={() => setRequesting(false)} />
      )}
    </>
  );
}
