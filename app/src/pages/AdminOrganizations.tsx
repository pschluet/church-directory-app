import { useCallback, useEffect, useState } from "react";
import type { OrganizationDto } from "@shared";
import { api } from "../lib/api";
import { useMe } from "../context/MeContext";
import {
  Button,
  EmptyState,
  ErrorNotice,
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
  const [organizations, setOrganizations] = useState<OrganizationDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<OrganizationDto | "new" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Not organization-scoped: this is the list you choose from.
      const result = await api<{ organizations: OrganizationDto[] }>("/organizations", {
        withOrg: false,
      });
      setOrganizations(result.organizations);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load churches");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeading
        title="Churches"
        subtitle="Each church has its own directory; members only ever see their own."
        actions={<Button onClick={() => setEditing("new")}>Add a church</Button>}
      />

      {error && <ErrorNotice message={error} onRetry={() => void load()} />}

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
                  Rename
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
            await load();
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal title={organization ? "Rename church" : "Add a church"} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api(organization ? `/organizations/${organization.id}` : "/organizations", {
              method: organization ? "PATCH" : "POST",
              body: { name, slug },
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
