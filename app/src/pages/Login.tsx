import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { Button, Field, inputClass } from "../components/ui";

/**
 * Two steps, no password: enter your email, then the code that arrives.
 * Sign-up is disabled on the user pool, so anyone not already invited is told
 * to ask an administrator rather than being offered a way to register.
 */
export function Login() {
  const { status, email, error, busy, requestCode, submitCode, restart } = useAuth();
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");

  const awaitingCode = status === "awaitingCode";

  return (
    <div className="flex min-h-screen flex-col bg-surface-muted">
      <div className="bg-primary px-4 py-2 text-center text-sm text-white">Parish Directory</div>

      <div className="flex flex-1 items-start justify-center px-4 py-10 md:items-center md:py-16">
        <div className="w-full max-w-md rounded-lg border border-line bg-surface p-6 shadow-sm md:p-8">
          <h1 className="text-2xl font-bold text-ink">Sign in</h1>

          {awaitingCode ? (
            <>
              <p className="mt-2 text-ink-muted">
                We sent a one-time code to <span className="font-bold text-ink">{email}</span>.
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
                    // Safe here: this is the only field on the step.
                    autoFocus
                    maxLength={10}
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\s/g, ""))}
                  />
                </Field>

                {error && (
                  <p role="alert" className="font-bold text-primary">
                    {error}
                  </p>
                )}

                <Button type="submit" disabled={busy || code.length < 4} className="w-full">
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
                    autoFocus
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

              <p className="mt-6 border-t border-line pt-4 text-sm text-ink-muted">
                Not in the directory yet? Ask a parish administrator to add you.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
