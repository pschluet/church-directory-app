import { useSearchParams } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Button, ErrorNotice } from "../components/ui";
import { LandingFrame } from "../components/LandingFrame";
import { Link } from "../components/nav";

/**
 * /unsubscribe?token=… -- where the "Unsubscribe" link in a notification email
 * lands.
 *
 * A button rather than unsubscribing on arrival, on purpose. Mail providers and
 * corporate filters open the links in a message before the reader does, to
 * check them; a page that acted on load would switch email off for people who
 * never clicked anything. Mail clients that offer their own "Unsubscribe" use
 * the List-Unsubscribe header instead, which POSTs straight to the API.
 *
 * Rendered with no session, like an event's share page: the token is the only
 * credential, and it can only ever turn email off.
 */
export function Unsubscribe() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  const unsubscribe = useMutation({
    mutationFn: () =>
      api("/public/email-unsubscribe", { method: "POST", query: { token }, withOrg: false }),
  });

  return (
    <LandingFrame>
      <div className="mx-auto max-w-md rounded-lg border border-line bg-surface p-6 shadow-sm md:p-8">
        {!token ? (
          <>
            <h1 className="text-xl font-bold text-ink">That link is incomplete</h1>
            <p className="mt-2 text-ink-muted">
              You can switch email notifications off in{" "}
              <Link
                to="/settings"
                className="font-bold text-primary underline-offset-2 hover:underline"
              >
                Settings
              </Link>{" "}
              once you are signed in.
            </p>
          </>
        ) : unsubscribe.isSuccess ? (
          <>
            <h1 className="text-xl font-bold text-ink">You are unsubscribed</h1>
            <p className="mt-2 text-ink-muted">
              The directory will not email you about notifications any more. The bell, and push
              notifications if you have them on, are unchanged.
            </p>
            <p className="mt-4 text-ink-muted">
              Changed your mind? Switch it back on in{" "}
              <Link
                to="/settings"
                className="font-bold text-primary underline-offset-2 hover:underline"
              >
                Settings
              </Link>
              .
            </p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold text-ink">Stop notification emails?</h1>
            <p className="mt-2 text-ink-muted">
              You will stop getting emails about prayer requests and group messages. Everything
              still shows on the bell in the app.
            </p>
            {unsubscribe.isError && (
              <div className="mt-4">
                <ErrorNotice
                  message={
                    unsubscribe.error instanceof Error
                      ? unsubscribe.error.message
                      : "Could not unsubscribe"
                  }
                />
              </div>
            )}
            <Button
              className="mt-6 w-full"
              disabled={unsubscribe.isPending}
              onClick={() => unsubscribe.mutate()}
            >
              {unsubscribe.isPending ? "Unsubscribing…" : "Unsubscribe"}
            </Button>
          </>
        )}
      </div>
    </LandingFrame>
  );
}
