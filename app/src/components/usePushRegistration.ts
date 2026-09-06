import { useEffect, useRef } from "react";
import { api } from "../lib/api";
import { registeredSubscription } from "../lib/push";
import { useMe } from "../context/MeContext";

/**
 * Keeps this device's push subscription pointing at whoever is signed in.
 *
 * A browser has one push subscription per origin, and `push_subscriptions` is
 * unique on the endpoint, so a device has exactly one row -- owned by whoever
 * registered it. Registering used to happen only in the settings page's own
 * toggle, which meant the row stayed with whoever last flipped that switch. On
 * a phone or a parish tablet shared between members, the next person to sign in
 * then received the previous person's notifications: an approver's "Approval
 * Needed" push arriving for somebody who cannot approve, which is a leak and not
 * merely noise.
 *
 * `api/src/routes/push.ts` was already written for this -- its `POST` is an
 * upsert on the endpoint precisely so the row can move to the current owner --
 * and its comment claimed the SPA re-subscribed on every load. Nothing did.
 * This is that missing half, so no server change goes with it.
 *
 * **This never asks for permission.** `Notification.requestPermission` only
 * works from a user gesture, and this runs on load, so it re-registers a
 * subscription the browser already holds and otherwise does nothing. Somebody
 * who has never turned push on here stays off until they tap the switch.
 *
 * Mounted once, in AppShell -- which renders only when signed in and with `me`
 * loaded, so `appUser.id` below is the account the row should belong to.
 */
export function usePushRegistration(): void {
  const { me } = useMe();
  const appUserId = me?.appUser.id ?? null;

  /*
   * The (account, endpoint) pair already sent, so a remount or a `me` refetch
   * does not re-post the same thing. A ref rather than state: nothing renders
   * from it, and setting state here would loop.
   */
  const registered = useRef<string | null>(null);

  useEffect(() => {
    if (!appUserId) return;
    let cancelled = false;

    void (async () => {
      // Not "not denied": `default` means nobody has been asked yet, and asking
      // is the switch's job, not this hook's.
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;

      const subscription = await registeredSubscription().catch(() => null);
      if (!subscription || cancelled) return;

      const key = `${appUserId}:${subscription.endpoint}`;
      if (registered.current === key) return;

      try {
        await api("/push/subscriptions", {
          method: "POST",
          body: subscription.toJSON(),
          withOrg: false,
        });
        registered.current = key;
      } catch {
        /*
         * Left unmarked, so the next mount tries again. There is deliberately
         * nothing on screen about it: the member did not ask for this and
         * cannot act on it, the bell is unaffected, and the settings page is
         * where a device that is not registered gets explained.
         */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [appUserId]);
}
