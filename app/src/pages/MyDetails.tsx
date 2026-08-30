import { useEffect, useState } from "react";
import { Navigate } from "react-router";
import type { MeDto, OrganizationMoveDto } from "@shared";
import { api } from "../lib/api";
import { useMe } from "../context/MeContext";
import { Button, ErrorNotice, Field, PageHeading, Spinner, inputClass } from "../components/ui";

/**
 * "My Details" is the signed-in person's own record, so rather than duplicating
 * PersonDetail this hands off to it.
 *
 * Three cases, and the middle one is why this is not a one-line redirect:
 *
 *   - record in the parish being viewed        -> redirect
 *   - record in a *different* parish           -> switch the viewing parish
 *                                                 first, because
 *                                                 GET /persons/:id is
 *                                                 organization-scoped and would
 *                                                 otherwise 404
 *   - super admin with no record at all        -> offer to adopt a parish
 */
export function MyDetails() {
  const { me, loading, error, reload, isSuperAdmin, switchOrganization } = useMe();

  const homeOrganizationId = me?.appUser.organizationId ?? null;
  const viewingOrganizationId = me?.organization?.id ?? null;
  const personId = me?.appUser.personId ?? null;
  const needsParishSwitch =
    personId !== null &&
    homeOrganizationId !== null &&
    homeOrganizationId !== viewingOrganizationId;

  useEffect(() => {
    if (needsParishSwitch && homeOrganizationId) {
      void switchOrganization(homeOrganizationId);
    }
  }, [needsParishSwitch, homeOrganizationId, switchOrganization]);

  if (loading) return <Spinner label="Loading your details" />;
  if (error) return <ErrorNotice message={error} onRetry={() => void reload()} />;

  if (needsParishSwitch) {
    return <Spinner label="Switching to your church" />;
  }

  if (personId) {
    return <Navigate to={`/people/${personId}`} replace />;
  }

  if (isSuperAdmin) {
    return <AdoptParish me={me!} onAdopted={reload} />;
  }

  return (
    <ErrorNotice message="Your directory record is missing. Ask a parish administrator to look into it." />
  );
}

/**
 * A super admin is not required to belong to a parish -- they administer all of
 * them -- but whoever runs the directory is usually also a member of one, and
 * needs their own contact details, family and special dates in it.
 */
function AdoptParish({ me, onAdopted }: { me: MeDto; onAdopted: () => Promise<void> }) {
  const [organizationId, setOrganizationId] = useState(
    me.organization?.id ?? me.availableOrganizations[0]?.id ?? ""
  );
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (me.availableOrganizations.length === 0) {
    return (
      <ErrorNotice message="There are no churches yet. Add one from the Churches page, then come back here to join it." />
    );
  }

  return (
    <>
      <PageHeading
        title="My Details"
        subtitle="You administer every church, but you are not listed in any of them yet."
      />

      <form
        className="max-w-xl space-y-4 rounded-lg border border-line bg-surface p-4 md:p-6"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setFailure(null);
          try {
            await api<MeDto & { move: OrganizationMoveDto }>("/me/organization", {
              method: "PUT",
              body: { organizationId, firstName, lastName: lastName || null },
              withOrg: false,
            });
            // Reloading rather than routing straight to the new record: the
            // whole context changed, including which parish is active.
            await onAdopted();
          } catch (err) {
            setFailure(err instanceof Error ? err.message : "Could not join that church");
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-ink-muted">
          Join a church to get your own entry in its directory — your contact details, your family,
          and your birthday and name day.
        </p>

        <Field label="Church">
          <select
            className={inputClass}
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            required
          >
            {me.availableOrganizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="First name">
            <input
              className={inputClass}
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              required
            />
          </Field>
          <Field label="Last name">
            <input
              className={inputClass}
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
            />
          </Field>
        </div>

        {failure && (
          <p role="alert" className="font-bold text-primary">
            {failure}
          </p>
        )}

        <Button type="submit" disabled={busy || firstName.trim() === "" || !organizationId}>
          {busy ? "Joining…" : "Join this church"}
        </Button>
      </form>
    </>
  );
}
