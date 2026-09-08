import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrganizationDto } from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { useMe } from "../context/MeContext";
import { AddressAutocomplete } from "../components/AddressAutocomplete";
import {
  Button,
  EmptyState,
  ErrorNotice,
  Badge,
  Field,
  Modal,
  PageHeading,
  Spinner,
  inputClass,
} from "../components/ui";

/**
 * The tenants. Only a super administrator sees this page; the route is guarded
 * in App.tsx and the API refuses anyone else regardless.
 */
export function AdminOrganizations() {
  const { switchOrganization, organizationId, reload: reloadMe } = useMe();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<OrganizationDto | "new" | null>(null);

  // Not organization-scoped, in the request or in the key: this is the list you
  // choose from.
  const organizationsQuery = useQuery({
    queryKey: qk.organizations(),
    queryFn: ({ signal }) =>
      api<{ organizations: OrganizationDto[] }>("/organizations", { withOrg: false, signal }),
  });

  const organizations = organizationsQuery.data?.organizations ?? [];
  const loading = organizationsQuery.isPending;
  const error = organizationsQuery.error?.message ?? null;

  return (
    <>
      <PageHeading
        title="Churches"
        subtitle="Each church has its own directory; members only ever see their own."
        actions={<Button onClick={() => setEditing("new")}>Add a church</Button>}
      />

      {error && <ErrorNotice message={error} onRetry={() => void organizationsQuery.refetch()} />}

      {loading ? (
        <Spinner label="Loading churches" />
      ) : organizations.length === 0 ? (
        <EmptyState title="No churches yet">
          <p>Add one, then invite an administrator for it.</p>
        </EmptyState>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {organizations.map((organization) => (
            <li
              key={organization.id}
              className="rounded-lg border border-line bg-surface p-4 md:p-5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-bold text-ink">{organization.name}</h2>
                  <p className="truncate text-sm text-ink-muted">{organization.slug}</p>
                </div>
                {organizationId === organization.id && (
                  <span className="shrink-0 text-sm font-bold text-accent">Viewing</span>
                )}
              </div>

              <p className="mt-3 text-sm text-ink-muted">
                {organization.personCount} {organization.personCount === 1 ? "person" : "people"} ·{" "}
                {organization.familyCount} {organization.familyCount === 1 ? "family" : "families"}
              </p>

              {/*
                Visible on the list rather than only inside the modal: which
                parishes have a map is the thing a super admin is here to see,
                and a missing church address is why one of them looks wrong.
              */}
              {organization.mapViewEnabled && (
                <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone="primary">Map View</Badge>
                  {organization.latitude === null && (
                    <span className="text-ink-muted">no church address placed</span>
                  )}
                </p>
              )}

              <div className="mt-4 flex flex-wrap gap-3 text-sm">
                {organizationId !== organization.id && (
                  <button
                    type="button"
                    className="font-bold text-primary hover:text-accent"
                    onClick={() => void switchOrganization(organization.id)}
                  >
                    View this directory
                  </button>
                )}
                <button
                  type="button"
                  className="font-bold text-primary hover:text-accent"
                  onClick={() => setEditing(organization)}
                >
                  Edit
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <OrganizationModal
          organization={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await queryClient.invalidateQueries({ queryKey: qk.organizations() });
            await reloadMe();
          }}
        />
      )}
    </>
  );
}

function OrganizationModal({
  organization,
  onClose,
  onSaved,
}: {
  organization: OrganizationDto | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(organization?.name ?? "");
  const [slug, setSlug] = useState(organization?.slug ?? "");
  const [slugEdited, setSlugEdited] = useState(Boolean(organization));
  const [mapViewEnabled, setMapViewEnabled] = useState(organization?.mapViewEnabled ?? false);
  const [address, setAddress] = useState({
    addressLine1: organization?.addressLine1 ?? "",
    addressLine2: organization?.addressLine2 ?? "",
    city: organization?.city ?? "",
    state: organization?.state ?? "",
    postalCode: organization?.postalCode ?? "",
    country: organization?.country ?? "",
    placeId: organization?.placeId ?? null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal title={organization ? "Edit church" : "Add a church"} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api(organization ? `/organizations/${organization.id}` : "/organizations", {
              method: organization ? "PATCH" : "POST",
              body: { name, slug, mapViewEnabled, ...address },
              withOrg: false,
            });
            await onSaved();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not save that church");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Name">
          <input
            className={inputClass}
            required
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              // Derive the short name until someone edits it themselves.
              if (!slugEdited) {
                setSlug(
                  event.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-+|-+$/g, "")
                    .slice(0, 60)
                );
              }
            }}
          />
        </Field>

        <Field label="Short name" hint="Lowercase letters, numbers and hyphens.">
          <input
            className={inputClass}
            required
            value={slug}
            onChange={(event) => {
              setSlugEdited(true);
              setSlug(event.target.value);
            }}
          />
        </Field>

        <fieldset className="rounded-lg border border-line p-4">
          <legend className="px-1 font-bold text-ink">Church address</legend>
          <p className="mb-3 text-sm text-ink-muted">
            Where the map opens, at about a 30 mile radius. Without it the map centres on the middle
            of the parish instead, and administrators are told to add one.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Street" className="md:col-span-2">
              <AddressAutocomplete
                value={address.addressLine1}
                onChange={(value) =>
                  setAddress((prev) => ({ ...prev, addressLine1: value, placeId: null }))
                }
                onPick={(picked) =>
                  setAddress((prev) => ({
                    ...prev,
                    addressLine1: picked.addressLine1,
                    city: picked.city || prev.city,
                    state: picked.state || prev.state,
                    postalCode: picked.postalCode || prev.postalCode,
                    country: picked.country || prev.country,
                    placeId: picked.placeId,
                  }))
                }
              />
            </Field>
            <Field label="City">
              <input
                className={inputClass}
                value={address.city}
                onChange={(event) => setAddress((p) => ({ ...p, city: event.target.value }))}
              />
            </Field>
            <Field label="State">
              <input
                className={inputClass}
                value={address.state}
                onChange={(event) => setAddress((p) => ({ ...p, state: event.target.value }))}
              />
            </Field>
            <Field label="ZIP code">
              <input
                className={inputClass}
                value={address.postalCode}
                onChange={(event) => setAddress((p) => ({ ...p, postalCode: event.target.value }))}
              />
            </Field>
            <Field label="Country">
              <input
                className={inputClass}
                value={address.country}
                onChange={(event) => setAddress((p) => ({ ...p, country: event.target.value }))}
              />
            </Field>
          </div>
        </fieldset>

        {/*
          The one switch on this page that costs money, so it says so. Only a
          super admin sees it -- an administrator can set the address above
          through PATCH /organizations/current but not this, because turning it
          on starts a billable Google integration for their parish.
        */}
        <fieldset className="rounded-lg border border-line p-4">
          <legend className="px-1 font-bold text-ink">Map View</legend>
          <label className="tap-target flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-primary"
              checked={mapViewEnabled}
              onChange={(event) => setMapViewEnabled(event.target.checked)}
            />
            <span>
              <span className="font-bold text-ink">Give this church a map of its parish</span>
              <span className="mt-1 block text-ink-muted">
                Adds a Map View link to the directory, and turns on address suggestions when
                somebody edits an address. Both call Google, so a church with this switched off
                costs nothing at all — which is also why addresses in it are not placed on a map
                until it is switched on.
              </span>
            </span>
          </label>
          {organization && mapViewEnabled && !organization.mapViewEnabled && (
            <p className="mt-3 text-sm text-ink-muted">
              Existing addresses will not appear until they have been geocoded, which the daily
              refresh does — or run the backfill to do it now.
            </p>
          )}
        </fieldset>

        {error && (
          <p role="alert" className="font-bold text-primary">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
