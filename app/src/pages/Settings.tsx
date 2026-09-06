import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NotificationPreferencesDto } from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import {
  currentSubscription,
  pushAvailability,
  subscribeThisDevice,
  type PushAvailability,
} from "../lib/push";
import { useMe } from "../context/MeContext";
import { MAPS_PROVIDERS, forgetPreferredProvider, preferredProvider } from "../lib/maps";
import { Button, ErrorNotice, PageHeading, Spinner } from "../components/ui";

/**
 * Notification settings.
 *
 * One section, two questions, in that order: *what* to be told about, and
 * *where*. Both belong under the same heading because they compose -- the
 * category decides whether anything is sent at all, and the device switch only
 * decides whether it also reaches this phone. Reading them as two unrelated
 * settings was the confusing part of the first cut of this page.
 *
 * Neither can live in the operating system's own notification settings, which
 * is why this page exists at all: permission can only be asked for from a tap
 * inside the app, the server has to be handed a push subscription that the OS
 * cannot give it, and "prayer requests specifically" has no OS equivalent. The
 * system settings remain the global mute on top of all this.
 *
 * Reached from the gear in the nav rather than being a nav item of its own: it
 * is a page somebody visits once.
 *
 * A second section appears below it only for somebody who told an address to
 * stop asking which map to open. That choice is made in the sheet itself, so
 * this page is not where it is set -- only where it can be taken back, which
 * is otherwise nowhere.
 */
export function Settings() {
  const { me, canApprovePrayerRequests } = useMe();
  const queryClient = useQueryClient();

  const publicKey = me?.pushPublicKey ?? null;
  const [availability, setAvailability] = useState<PushAvailability | null>(null);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preferencesQuery = useQuery({
    queryKey: qk.notificationPreferences(),
    queryFn: ({ signal }) =>
      api<NotificationPreferencesDto>("/notifications/preferences", {
        signal,
        withOrg: false,
      }),
  });

  const savePreferences = useMutation({
    // Only the switch that was touched: the server coalesces an absent field to
    // whatever it already held, so this cannot clear the other one.
    mutationFn: (body: Partial<NotificationPreferencesDto>) =>
      api<NotificationPreferencesDto>("/notifications/preferences", {
        method: "PUT",
        body,
        withOrg: false,
      }),
    onSuccess: (updated) => queryClient.setQueryData(qk.notificationPreferences(), updated),
    onError: (err) => setError(err instanceof Error ? err.message : "Could not save that setting"),
  });

  /*
   * Read once on mount rather than held in a query: both answers come from the
   * browser, not the API, and neither changes without something on this page
   * doing it.
   */
  const refreshDeviceState = useCallback(async () => {
    const state = pushAvailability(publicKey);
    setAvailability(state);
    if (state !== "ready") {
      setSubscribed(false);
      return;
    }
    setSubscribed((await currentSubscription()) !== null);
  }, [publicKey]);

  useEffect(() => {
    void refreshDeviceState();
  }, [refreshDeviceState]);

  async function enablePush(): Promise<void> {
    if (!publicKey) return;
    setBusy(true);
    setError(null);
    try {
      const subscription = await subscribeThisDevice(publicKey);
      if (!subscription) {
        // Declined at the browser prompt. Not an error -- but the state has to
        // be re-read, because "denied" is now permanent for this browser.
        await refreshDeviceState();
        return;
      }
      await api("/push/subscriptions", {
        method: "POST",
        body: subscription.toJSON(),
        withOrg: false,
      });
      setSubscribed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Notifications could not be turned on here.");
      await refreshDeviceState();
    } finally {
      setBusy(false);
    }
  }

  async function disablePush(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const subscription = await currentSubscription();
      if (subscription) {
        // The server first: if `unsubscribe()` succeeded and the DELETE then
        // failed, the row would be left pointing at an endpoint that no longer
        // exists and this browser could not ask again. In the other order the
        // worst case is a row already gone, which the delete reports as a 404
        // and which the next send would have pruned anyway.
        await api("/push/subscriptions", {
          method: "DELETE",
          body: { endpoint: subscription.endpoint },
          withOrg: false,
        }).catch(() => undefined);
        await subscription.unsubscribe();
      }
      setSubscribed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Notifications could not be turned off.");
    } finally {
      setBusy(false);
    }
  }

  // Held here rather than in the section below because it decides the page's
  // subtitle as well as whether the section exists at all.
  const [mapsProvider, setMapsProvider] = useState(preferredProvider);

  const preferences = preferencesQuery.data;
  const prayerRequests = preferences?.prayerRequests ?? true;
  const prayerRequestReviews = preferences?.prayerRequestReviews ?? true;
  const saving = preferencesQuery.isPending || savePreferences.isPending;
  const message = error ?? preferencesQuery.error?.message ?? null;

  return (
    <>
      <PageHeading
        title="Settings"
        subtitle={
          mapsProvider
            ? "Choose what the directory tells you about, and which map it opens."
            : "Choose what the directory tells you about."
        }
      />

      {message && <ErrorNotice message={message} />}

      <section className="rounded-lg border border-line bg-surface p-4">
        <h2 className="font-bold text-ink">Notifications</h2>
        <p className="mt-1 text-sm text-ink-muted">
          The directory can tell you about prayer requests two ways: a badge on the bell in the top
          corner, and a notification on your phone or computer.
        </p>

        <div className="mt-5">
          <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-muted">
            Notify me about
          </h3>
          <Switch
            label="New prayer requests"
            hint="When somebody's prayer request is posted for the parish to see."
            checked={prayerRequests}
            disabled={saving}
            onChange={(next) => savePreferences.mutate({ prayerRequests: next })}
          />

          {/*
            Only shown to the people who would ever get one. For everybody else
            it would be a switch with no effect, and the value stored on their
            row is simply never read.
          */}
          {canApprovePrayerRequests && (
            <div className="mt-4 border-t border-line pt-4">
              <Switch
                label="Requests waiting for my approval"
                hint="When somebody asks for prayers and it needs your approval before the parish can see it. Turning this off does not stop you approving them — they still show on the Prayer Requests page."
                checked={prayerRequestReviews}
                disabled={saving}
                onChange={(next) => savePreferences.mutate({ prayerRequestReviews: next })}
              />
            </div>
          )}
        </div>

        <div className="mt-5 border-t border-line pt-5">
          <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-muted">
            On this device
          </h3>

          {availability === null ? (
            <Spinner label="Checking this device" />
          ) : availability === "ready" ? (
            <Switch
              label="Push notifications"
              hint={
                // The two switches compose, so say so rather than leaving
                // somebody with push on and nothing selected to send.
                !prayerRequests && !(canApprovePrayerRequests && prayerRequestReviews)
                  ? "Nothing to send while everything above is switched off."
                  : subscribed
                    ? "This device will be notified even when the directory is closed."
                    : "Your phone or computer will ask for permission."
              }
              checked={subscribed === true}
              disabled={busy}
              onChange={(next) => void (next ? enablePush() : disablePush())}
            />
          ) : (
            <PushUnavailable availability={availability} />
          )}
        </div>
      </section>

      {mapsProvider && (
        <section className="mt-4 rounded-lg border border-line bg-surface p-4">
          <h2 className="font-bold text-ink">Maps</h2>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 text-ink-muted">
              Addresses open in {MAPS_PROVIDERS[mapsProvider].label} without asking.
            </p>
            <Button
              variant="secondary"
              onClick={() => {
                forgetPreferredProvider();
                setMapsProvider(null);
              }}
            >
              Ask me again
            </Button>
          </div>
        </section>
      )}
    </>
  );
}

/**
 * Why push cannot be switched on here, and what to do about it.
 *
 * Each of these is a real state somebody lands in, and none is something a
 * greyed-out toggle would explain. They are all careful to say *push* rather
 * than *notifications*: the bell is unaffected in every one of these cases, and
 * the earlier wording read as though the whole feature were missing.
 *
 * `needs-install` is the common one on an iPhone, and the reason this component
 * exists at all.
 */
function PushUnavailable({ availability }: { availability: PushAvailability }) {
  if (availability === "needs-install") {
    return (
      <div className="rounded-md border border-accent/40 bg-accent/5 p-3 text-sm text-ink">
        <p className="font-bold">Add the directory to your home screen first</p>
        <p className="mt-1 text-ink-muted">
          On an iPhone or iPad, push notifications only reach an installed app. Tap the Share
          button, then <span className="font-bold">Add to Home Screen</span>, and open the directory
          from there to switch them on.
        </p>
      </div>
    );
  }

  if (availability === "denied") {
    return (
      <div className="rounded-md border border-line bg-surface-muted p-3 text-sm text-ink">
        <p className="font-bold">Push notifications are blocked for the directory</p>
        <p className="mt-1 text-ink-muted">
          The app cannot ask again. Turn them back on in your device settings — on an iPhone,
          Settings → Notifications → Directory.
        </p>
      </div>
    );
  }

  if (availability === "not-configured") {
    return (
      <div className="rounded-md border border-line bg-surface-muted p-3 text-sm text-ink">
        <p className="font-bold">Push notifications are not switched on for this directory</p>
        <p className="mt-1 text-ink-muted">
          A parish administrator has to enable them before they can be sent to anyone's phone. The
          bell in the top corner works either way.
        </p>
      </div>
    );
  }

  return (
    <p className="text-sm text-ink-muted">
      This browser cannot show push notifications. The bell in the top corner works either way.
    </p>
  );
}

/**
 * A labelled on/off setting.
 *
 * A plain checkbox, as on the directory's account-holders filter. Not
 * `role="switch"`: that overrides the implicit checkbox role and then obliges
 * us to mirror the state into `aria-checked` by hand, which is a second source
 * of truth for no gain -- a checkbox already announces "checked", is focusable,
 * and responds to the space bar.
 */
function Switch({
  label,
  hint,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span className="min-w-0">
        <span className="block font-bold text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-sm text-ink-muted">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-5 w-5 shrink-0 accent-primary disabled:opacity-60"
      />
    </label>
  );
}
