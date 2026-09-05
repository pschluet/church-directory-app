/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

/**
 * The service worker.
 *
 * Hand-written, which it did not used to be: this was `generateSW`, and that
 * cannot host a `push` listener. The alternative -- keeping `generateSW` and
 * pulling the listeners in with `workbox.importScripts` -- was rejected because
 * it adds a *second* file with a fixed name, and every fixed name in this app
 * has to be threaded through three places in .github/workflows/deploy.yml (the
 * `--exclude` list, the no-cache upload, and the invalidation paths). Miss one
 * and the worker either serves a year-stale push handler or fails to import it
 * at all, which takes the whole worker down and with it the offline app shell.
 * One sw.js, already handled correctly, is the safer shape.
 *
 * Everything above the push listeners reproduces exactly what Workbox used to
 * generate, and `app/test/serviceWorker.test.ts` is what holds it to that --
 * including the part that matters most: **nothing** is runtime-cached. There is
 * no `registerRoute` for `/api/*` or `/photos/*`, so every request for either
 * falls straight through to the network and none of the parish's phone numbers,
 * addresses or faces are written to disk. That is the same decision
 * `lib/queryClient.ts` makes about a localStorage persister, for the same
 * reason, and it is a decision rather than an omission.
 */

// `self` in a module worker is typed as the DOM's Window without this.
declare const self: ServiceWorkerGlobalScope & {
  /** The precache manifest vite-plugin-pwa injects at build time. */
  __WB_MANIFEST: { url: string; revision: string | null }[];
};

/*
 * `registerType: "autoUpdate"` means the new worker takes over without asking.
 * With generateSW these two came for free; written by hand they have to be
 * explicit, and they are not optional. In standalone display there is no
 * address bar, so a worker that waits for every tab to close is a worker some
 * installed copies would never get past -- which is the same reason sw.js must
 * never be uploaded `immutable`.
 */
self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

/*
 * A deep link like /dates has no extension and so no precache entry; serve the
 * shell and let the router take it. This mirrors the CloudFront SpaFallback
 * function, which rewrites any URI without a dot to /index.html.
 *
 * The denylist is matched by prefix and not by extension on purpose: photo
 * renditions are extensionless, e.g.
 * /photos/<org>/person/<id>/<ulid>/thumb, so an extension test would answer
 * one with the app shell.
 */
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api\//, /^\/photos\//],
  })
);

interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
  /** Which notification this replaces. See the `tag` note below. */
  tag?: string;
}

/**
 * Kept as a literal rather than imported from `@shared`, matching PushPayload
 * above. The alias does resolve in this build, so an import would compile --
 * and would pull Zod and the whole types module into sw.js.
 */
const CHANGED_MESSAGE = "prayer-requests-changed";

/**
 * Tells every open tab that something changed, so the bell and the prayer
 * requests page update without waiting to be asked.
 *
 * This is the whole of the app's "real-time": nothing polls, so a push is the
 * only signal that arrives on its own. Deliberately a bare signal with no
 * payload -- this worker has no auth context and no idea which account a given
 * window is signed in as, and a phone shared between two members registers one
 * subscription that moves to whoever signed in last. So a message triggered by
 * one account's push can land in a window signed in as another; carrying data
 * would make that a leak, whereas a bare "go and re-read" is just a wasted
 * request.
 *
 * `includeUncontrolled` is what makes this work at all on the first install: a
 * page loaded before this worker took over is not controlled by it yet and
 * would otherwise be missed. `matchAll` only ever returns same-origin clients,
 * so there is nothing to filter.
 */
async function notifyOpenTabs(): Promise<void> {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    client.postMessage({ type: CHANGED_MESSAGE });
  }
}

/**
 * A posted prayer request.
 *
 * The body is only ever a count -- "3 new prayer requests" -- and deliberately
 * so. A prayer request can name somebody's illness, and a lock screen is not
 * where that should be legible to whoever picks the phone up.
 *
 * `tag` is what stops them stacking: a fixed tag means each push *replaces* the
 * previous one, so a member who has not opened the app since Tuesday sees one
 * notification reading "3 new prayer requests" rather than three saying "1".
 * `renotify` is what still buzzes when it is replaced, which without it would
 * be a silent update nobody notices.
 *
 * A notification is always shown, whatever arrives. Every subscription is made
 * `userVisibleOnly`, and a push that shows nothing is what gets a subscription
 * revoked -- on iOS after very few offences.
 *
 * The notification is only half of it: this also nudges any open tab, which is
 * how the app updates itself now that nothing polls. See `notifyOpenTabs`.
 */
self.addEventListener("push", (event) => {
  let payload: PushPayload = {};
  try {
    payload = (event.data?.json() ?? {}) as PushPayload;
  } catch {
    // Malformed or unencrypted payload. Still has to show something.
  }

  event.waitUntil(
    (async () => {
      /*
       * The fallback is not the app's name, and must not become it: iOS renders
       * "{title} from {app name}" and cannot be told not to, so "Parish
       * Directory" here read as "Parish Directory from Directory". Prayer
       * requests are the only thing this app pushes, so that is what an
       * unreadable payload can safely claim to be about.
       */
      await self.registration.showNotification(payload.title ?? "Prayer Requests", {
        body: payload.body ?? "Something new in the parish directory",
        // From the payload, so a request waiting for review can replace the
        // previous *review* notification without displacing a posted one.
        tag: payload.tag ?? "prayer-requests",
        // Not in every lib.dom yet, though every engine that delivers Web Push
        // supports it.
        ...({ renotify: true } as NotificationOptions),
        icon: "/pwa-192x192.png",
        badge: "/pwa-64x64.png",
        data: { url: payload.url ?? "/prayer-requests" },
      });

      /*
       * In the same chain as the notification, and swallowing its own failure.
       * A second `waitUntil` risks the worker being killed before `matchAll`
       * resolves, and a rejected one counts as having shown nothing against
       * `userVisibleOnly` -- which is what gets a subscription revoked.
       */
      await notifyOpenTabs().catch(() => undefined);
    })()
  );
});

/**
 * Tapping the notification opens the app on the prayer requests page.
 *
 * An already-open copy is focused and navigated rather than a second window
 * opened, which is the case that actually happens: on iOS the installed app is
 * usually still running in the background, and `openWindow` there would either
 * be ignored or leave two copies of a standalone app fighting over one home
 * screen icon.
 *
 * `includeUncontrolled` matters on the very first install: a page loaded before
 * this worker took over is not controlled by it yet, and without the flag it
 * would not be found and would be duplicated.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? "/";

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        // Not every engine implements navigate() on a focused client; falling
        // back to the focus alone is better than throwing away the tap.
        if ("navigate" in client) {
          await client.navigate(url).catch(() => undefined);
        }
        return;
      }
      await self.clients.openWindow(url);
    })()
  );
});
