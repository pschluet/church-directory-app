import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GROUP_NOTIFICATION_PREFS,
  GROUP_NOTIFICATION_PREF_LABELS,
  type GroupNotificationPref,
  type NotificationPreferencesDto,
  type OrganizationAddressDto,
} from "@shared";
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
import { AddressAutocomplete } from "../components/AddressAutocomplete";
import { Link } from "../components/nav";
import { Button, ErrorNotice, Field, PageHeading, Spinner, inputClass } from "../components/ui";

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
  const { me, canApprovePrayerRequests, isAdmin, organizationId } = useMe();
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
    mutationFn: (
      body: Partial<
        Pick<
          NotificationPreferencesDto,
          "prayerRequests" | "prayerRequestReviews" | "directoryRequests" | "groupNotificationPref"
        >
      >
    ) =>
      api<NotificationPreferencesDto>("/notifications/preferences", {
        method: "PUT",
        body,
        withOrg: false,
      }),
    onSuccess: (updated) => queryClient.setQueryData(qk.notificationPreferences(), updated),
    onError: (err) => setError(err instanceof Error ? err.message : "Could not save that setting"),
  });

  /*
   * A group's exception, changed or removed from here. Account-scoped routes
   * rather than the group's own, because this list can include a group in
   * another parish (a super admin belongs to several) and the group's route
   * only answers for the active one. Both return the whole preferences object,
   * so the cache is replaced from one shape.
   */
  const saveException = useMutation({
    mutationFn: ({ groupId, pref }: { groupId: string; pref: GroupNotificationPref }) =>
      api<NotificationPreferencesDto>(`/notifications/group-preferences/${groupId}`, {
        method: "PUT",
        body: { notificationPref: pref },
        withOrg: false,
      }),
    onSuccess: (updated) => queryClient.setQueryData(qk.notificationPreferences(), updated),
    onError: (err) => setError(err instanceof Error ? err.message : "Could not save that setting"),
  });

  const removeException = useMutation({
    mutationFn: (groupId: string) =>
      api<NotificationPreferencesDto>(`/notifications/group-preferences/${groupId}`, {
        method: "DELETE",
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
  const directoryRequests = preferences?.directoryRequests ?? true;
  const groupNotificationPref = preferences?.groupNotificationPref ?? "ALL";
  const groupExceptions = preferences?.groupExceptions ?? [];
  const saving =
    preferencesQuery.isPending ||
    savePreferences.isPending ||
    saveException.isPending ||
    removeException.isPending;
  // Push has something to send if any group could still speak up, not just
  // prayer requests.
  const anyGroupNotifications =
    groupNotificationPref !== "NONE" || groupExceptions.some((e) => e.notificationPref !== "NONE");
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
          The directory can tell you about prayer requests and group messages two ways: a badge on
          the bell in the top corner, and a notification on your phone or computer.
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

          {/* Administrators only, for the same reason as the switch above. */}
          {isAdmin && (
            <div className="mt-4 border-t border-line pt-4">
              <Switch
                label="Requests to be added to the directory"
                hint="When somebody asks to be added from the sign-in page. Turning this off does not hide them — they still show on People & Accounts."
                checked={directoryRequests}
                disabled={saving}
                onChange={(next) => savePreferences.mutate({ directoryRequests: next })}
              />
            </div>
          )}
        </div>

        <div className="mt-5 border-t border-line pt-5">
          <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-muted">
            Group messages
          </h3>
          <label className="block">
            <span className="block font-bold text-ink">By default, tell me about</span>
            <select
              className={`${inputClass} mt-1 sm:max-w-xs`}
              value={groupNotificationPref}
              disabled={saving}
              onChange={(event) =>
                savePreferences.mutate({
                  groupNotificationPref: event.target.value as GroupNotificationPref,
                })
              }
            >
              {GROUP_NOTIFICATION_PREFS.map((pref) => (
                <option key={pref} value={pref}>
                  {GROUP_NOTIFICATION_PREF_LABELS[pref]}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-sm text-ink-muted">
              Applies to every group. To treat one group differently, change it from that group's
              member list.
            </span>
          </label>

          {groupExceptions.length > 0 && (
            <div className="mt-4">
              <h4 className="mb-1 font-bold text-ink">Except in these groups</h4>
              <ul className="divide-y divide-line rounded-md border border-line">
                {groupExceptions.map((exception) => (
                  <li
                    key={exception.groupId}
                    className="flex flex-wrap items-center justify-between gap-2 p-3"
                  >
                    {/* A link only inside the active parish: out of it the page
                        would open the group under the wrong church. */}
                    {exception.organizationId === organizationId ? (
                      <Link
                        to={`/groups/${exception.groupId}`}
                        className="min-w-0 break-words font-bold text-ink hover:text-accent"
                      >
                        {exception.groupTitle}
                      </Link>
                    ) : (
                      <span className="min-w-0 break-words font-bold text-ink">
                        {exception.groupTitle}
                      </span>
                    )}
                    <span className="flex items-center gap-2">
                      <select
                        aria-label={`Notifications for ${exception.groupTitle}`}
                        className={`${inputClass} w-auto`}
                        value={exception.notificationPref}
                        disabled={saving}
                        onChange={(event) =>
                          saveException.mutate({
                            groupId: exception.groupId,
                            pref: event.target.value as GroupNotificationPref,
                          })
                        }
                      >
                        {GROUP_NOTIFICATION_PREFS.map((pref) => (
                          <option key={pref} value={pref}>
                            {GROUP_NOTIFICATION_PREF_LABELS[pref]}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant="ghost"
                        aria-label={`Use your default for ${exception.groupTitle}`}
                        disabled={saving}
                        onClick={() => removeException.mutate(exception.groupId)}
                      >
                        Use my default
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
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
                !prayerRequests &&
                !(canApprovePrayerRequests && prayerRequestReviews) &&
                !(isAdmin && directoryRequests) &&
                !anyGroupNotifications
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

      {isAdmin && <ChurchAddressSection />}

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
 * The church address, for an administrator.
 *
 * Here rather than on *Churches*, which is a super administrator's page, because
 * Map View warns an administrator that this address is missing -- and a warning
 * that links somewhere you are bounced out of is worse than no warning. This is
 * the UI for `PATCH /api/organizations/current`, which is deliberately narrower
 * than the super administrator's route: it takes an address and nothing else, so
 * the parish name and the Map View switch stay out of reach.
 *
 * Shown to every administrator, not only when the address is missing. Somebody
 * has to be able to correct one that is merely wrong, and a section that
 * vanished once it was filled in would be a section nobody could find again.
 */
function ChurchAddressSection() {
  const queryClient = useQueryClient();
  const { organizationId } = useMe();
  const [saved, setSaved] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState<{
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    placeId: string | null;
  } | null>(null);

  /*
   * Read from the map, which every member may load, rather than from
   * `/organizations` -- that one is super-admin-only, so an administrator
   * asking it would get a 403 and this section would be permanently broken for
   * exactly the people it is for.
   */
  const current = useQuery({
    queryKey: qk.churchAddress(organizationId),
    queryFn: ({ signal }) => api<OrganizationAddressDto>("/organizations/current", { signal }),
  });

  const form = address ?? {
    addressLine1: current.data?.addressLine1 ?? "",
    city: current.data?.city ?? "",
    state: current.data?.state ?? "",
    postalCode: current.data?.postalCode ?? "",
    country: current.data?.country ?? "",
    placeId: current.data?.placeId ?? null,
  };

  const save = useMutation({
    mutationFn: () =>
      api<{ organization: OrganizationAddressDto; geocodeWarning: string | null }>(
        "/organizations/current",
        { method: "PATCH", body: form }
      ),
    onSuccess: async (result) => {
      setError(null);
      setWarning(result.geocodeWarning);
      setSaved(
        result.organization.latitude === null
          ? "Saved. It could not be placed on the map."
          : "Saved, and placed on the map."
      );
      await queryClient.invalidateQueries({ queryKey: qk.churchAddress(organizationId) });
    },
    onError: (err: unknown) => {
      setSaved(null);
      setError(err instanceof Error ? err.message : "Could not save that address");
    },
  });

  return (
    <section className="mt-4 rounded-lg border border-line bg-surface p-4">
      <h2 className="font-bold text-ink">Church address</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Where Map View opens, at about a 30 mile radius. Without it the map centres on the middle of
        the parish instead.
      </p>

      {current.isPending ? (
        <Spinner label="Loading the church address" />
      ) : (
        <form
          className="mt-3 grid gap-4 md:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Street" className="md:col-span-2">
            <AddressAutocomplete
              value={form.addressLine1}
              onChange={(value) => setAddress({ ...form, addressLine1: value, placeId: null })}
              onPick={(picked) =>
                setAddress({
                  addressLine1: picked.addressLine1,
                  city: picked.city || form.city,
                  state: picked.state || form.state,
                  postalCode: picked.postalCode || form.postalCode,
                  country: picked.country || form.country,
                  placeId: picked.placeId,
                })
              }
            />
          </Field>
          <Field label="City">
            <input
              className={inputClass}
              value={form.city}
              onChange={(event) => setAddress({ ...form, city: event.target.value })}
            />
          </Field>
          <Field label="State">
            <input
              className={inputClass}
              value={form.state}
              onChange={(event) => setAddress({ ...form, state: event.target.value })}
            />
          </Field>
          <Field label="ZIP code">
            <input
              className={inputClass}
              value={form.postalCode}
              onChange={(event) => setAddress({ ...form, postalCode: event.target.value })}
            />
          </Field>
          <Field label="Country">
            <input
              className={inputClass}
              value={form.country}
              onChange={(event) => setAddress({ ...form, country: event.target.value })}
            />
          </Field>

          <div className="md:col-span-2">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save church address"}
            </Button>
          </div>

          {error && (
            <p role="alert" className="font-bold text-primary md:col-span-2">
              {error}
            </p>
          )}
          {/* Status rather than alert: the save worked, so this is news. */}
          {saved && !error && (
            <p role="status" className="text-sm text-ink-muted md:col-span-2">
              {saved}
            </p>
          )}
          {warning && (
            <p
              role="status"
              className="rounded-md border border-accent bg-surface-muted p-3 text-sm text-ink md:col-span-2"
            >
              {warning}
            </p>
          )}
        </form>
      )}
    </section>
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
