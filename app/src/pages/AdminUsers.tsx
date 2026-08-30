import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { AppUserDto, FamilySummaryDto, JoinRequestDto, OrganizationDto, Role } from "@shared";
import { api } from "../lib/api";
import { useMe } from "../context/MeContext";
import {
  Badge,
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
 * Accounts.
 *
 * Sign-up is disabled on the user pool, so this is the only way in: an
 * administrator enters a name and address, and Cognito emails the invitation.
 *
 * The table becomes stacked cards under `md` rather than scrolling sideways.
 */

const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: "Super administrator",
  ADMIN: "Administrator",
  USER: "Member",
};

export function AdminUsers() {
  const { me, isSuperAdmin, organizationId, reload: reloadMe } = useMe();
  const [users, setUsers] = useState<AppUserDto[]>([]);
  const [families, setFamilies] = useState<FamilySummaryDto[]>([]);
  const [joinRequests, setJoinRequests] = useState<JoinRequestDto[]>([]);
  const [organizations, setOrganizations] = useState<{ id: string; name: string }[]>([]);
  const [moving, setMoving] = useState<AppUserDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [userResult, familyResult, organizationResult, joinRequestResult] = await Promise.all([
        api<{ users: AppUserDto[] }>("/admin/users"),
        api<{ families: FamilySummaryDto[] }>("/families").catch(() => ({
          families: [],
        })),
        // Only a super admin may read this, and only they can move anyone
        // between churches.
        isSuperAdmin
          ? api<{ organizations: OrganizationDto[] }>("/organizations", { withOrg: false }).catch(
              () => ({ organizations: [] })
            )
          : Promise.resolve({ organizations: [] }),
        // For an admin this endpoint returns the whole parish, not just their
        // own family.
        api<{ joinRequests: JoinRequestDto[] }>("/families/join-requests/pending").catch(() => ({
          joinRequests: [],
        })),
      ]);
      setUsers(userResult.users);
      setFamilies(familyResult.families);
      setOrganizations(organizationResult.organizations.map((o) => ({ id: o.id, name: o.name })));
      setJoinRequests(joinRequestResult.joinRequests);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load accounts");
    } finally {
      setLoading(false);
    }
  }, [isSuperAdmin]);

  useEffect(() => {
    void load();
    // A super admin switching parish is administering a different set of people.
  }, [load, organizationId]);

  async function decide(request: JoinRequestDto, decision: "approve" | "deny"): Promise<void> {
    try {
      await api(`/families/join-requests/${request.id}/${decision}`, { method: "POST" });
      await load();
      // An admin can be approving their own request.
      if (request.personId === me?.appUser.personId) await reloadMe();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not decide that request");
    }
  }

  async function update(user: AppUserDto, body: Record<string, unknown>): Promise<void> {
    try {
      await api(`/admin/users/${user.id}`, { method: "PATCH", body });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update that account");
    }
  }

  return (
    <>
      <PageHeading
        title="People & Accounts"
        subtitle={`${users.length} ${users.length === 1 ? "account" : "accounts"}`}
        actions={<Button onClick={() => setInviting(true)}>Invite someone</Button>}
      />

      {error && <ErrorNotice message={error} onRetry={() => void load()} />}

      {joinRequests.length > 0 && (
        <section className="mb-6 rounded-lg border border-accent/40 bg-accent/5 p-4">
          <h2 className="mb-3 font-bold text-ink">Pending join requests ({joinRequests.length})</h2>
          <ul className="space-y-2">
            {joinRequests.map((request) => (
              <li
                key={request.id}
                className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <span>
                  {request.personName} → {request.familyName} family
                </span>
                <span className="flex gap-2">
                  <Button onClick={() => void decide(request, "approve")}>Approve</Button>
                  <Button variant="ghost" onClick={() => void decide(request, "deny")}>
                    Decline
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {loading ? (
        <Spinner label="Loading accounts" />
      ) : users.length === 0 ? (
        <EmptyState title="No accounts yet" />
      ) : (
        <>
          {/* Cards on a phone; a table from md up. */}
          <ul className="space-y-3 md:hidden">
            {users.map((user) => (
              <li key={user.id} className="rounded-lg border border-line bg-surface p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-bold text-ink">{user.personName ?? user.email}</p>
                    <p className="truncate text-sm text-ink-muted">{user.email}</p>
                  </div>
                  <StatusBadge status={user.status} />
                </div>
                <dl className="mt-3 space-y-1 text-sm">
                  <Row label="Role">{ROLE_LABELS[user.role]}</Row>
                  {isSuperAdmin && <Row label="Church">{user.organizationName ?? "—"}</Row>}
                </dl>
                <div className="mt-3 flex flex-wrap gap-3 text-sm">
                  <UserActions
                    user={user}
                    isSelf={user.id === me?.appUser.id}
                    isSuperAdmin={isSuperAdmin}
                    onUpdate={update}
                    onMove={setMoving}
                  />
                </div>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-hidden rounded-lg border border-line md:block">
            <table className="w-full text-left">
              <thead className="bg-surface-muted text-sm uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-4 py-3 font-bold">Name</th>
                  <th className="px-4 py-3 font-bold">Email</th>
                  <th className="px-4 py-3 font-bold">Role</th>
                  {isSuperAdmin && <th className="px-4 py-3 font-bold">Church</th>}
                  <th className="px-4 py-3 font-bold">Status</th>
                  <th className="px-4 py-3 font-bold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {users.map((user) => (
                  <tr key={user.id}>
                    <td className="px-4 py-3">
                      {user.personId ? (
                        <Link
                          to={`/people/${user.personId}`}
                          className="font-bold text-primary hover:text-accent"
                        >
                          {user.personName}
                        </Link>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink-muted">{user.email}</td>
                    <td className="px-4 py-3">{ROLE_LABELS[user.role]}</td>
                    {isSuperAdmin && (
                      <td className="px-4 py-3 text-ink-muted">{user.organizationName ?? "—"}</td>
                    )}
                    <td className="px-4 py-3">
                      <StatusBadge status={user.status} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-3 text-sm">
                        <UserActions
                          user={user}
                          isSelf={user.id === me?.appUser.id}
                          isSuperAdmin={isSuperAdmin}
                          onUpdate={update}
                          onMove={setMoving}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {inviting && (
        <InviteModal
          families={families}
          organizations={organizations}
          canInviteSuperAdmin={isSuperAdmin}
          onClose={() => setInviting(false)}
          onInvited={async () => {
            setInviting(false);
            await load();
          }}
        />
      )}

      {moving && (
        <MoveChurchModal
          user={moving}
          organizations={organizations}
          onClose={() => setMoving(null)}
          onMoved={async () => {
            setMoving(null);
            await load();
          }}
        />
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="font-bold text-ink-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: AppUserDto["status"] }) {
  if (status === "ACTIVE") return <Badge tone="accent">Active</Badge>;
  if (status === "INVITED") return <Badge tone="primary">Invited</Badge>;
  return <Badge>Disabled</Badge>;
}

function UserActions({
  user,
  isSelf,
  isSuperAdmin,
  onUpdate,
  onMove,
}: {
  user: AppUserDto;
  isSelf: boolean;
  isSuperAdmin: boolean;
  onUpdate: (user: AppUserDto, body: Record<string, unknown>) => Promise<void>;
  onMove: (user: AppUserDto) => void;
}) {
  const canChangeRole = isSuperAdmin || user.role !== "SUPER_ADMIN";

  return (
    <>
      {canChangeRole && user.role !== "ADMIN" && user.role !== "SUPER_ADMIN" && (
        <button
          type="button"
          className="font-bold text-primary hover:text-accent"
          onClick={() => void onUpdate(user, { role: "ADMIN" })}
        >
          Make administrator
        </button>
      )}
      {canChangeRole && user.role === "ADMIN" && (
        <button
          type="button"
          className="font-bold text-primary hover:text-accent"
          onClick={() => void onUpdate(user, { role: "USER" })}
        >
          Make member
        </button>
      )}
      {isSuperAdmin && (
        <button
          type="button"
          className="font-bold text-primary hover:text-accent"
          onClick={() => onMove(user)}
        >
          Move church
        </button>
      )}
      {!isSelf &&
        (user.status === "DISABLED" ? (
          <button
            type="button"
            className="font-bold text-primary hover:text-accent"
            onClick={() => void onUpdate(user, { status: "ACTIVE" })}
          >
            Re-enable
          </button>
        ) : (
          <button
            type="button"
            className="font-bold text-primary hover:text-accent"
            onClick={() => void onUpdate(user, { status: "DISABLED" })}
          >
            Disable
          </button>
        ))}
    </>
  );
}

function InviteModal({
  families,
  organizations,
  canInviteSuperAdmin,
  onClose,
  onInvited,
}: {
  families: { id: string; name: string }[];
  organizations: { id: string; name: string }[];
  canInviteSuperAdmin: boolean;
  onClose: () => void;
  onInvited: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [role, setRole] = useState<Role>("USER");
  const [familyId, setFamilyId] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A super admin can be given a church, in which case they get a directory
  // record like anyone else. Left blank they administer without belonging to
  // one, and can join later from My Details.
  const showChurchPicker = organizations.length > 0;

  return (
    <Modal title="Invite someone" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api("/admin/users", {
              method: "POST",
              body: {
                email,
                firstName,
                lastName: lastName || null,
                role,
                familyId: familyId || null,
                organizationId: organizationId || null,
              },
            });
            await onInvited();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not send that invitation");
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-ink-muted">
          They will get an email from the parish inviting them to sign in. There is no password —
          each sign-in sends a one-time code.
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="First name">
            <input
              className={inputClass}
              required
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
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

        <Field label="Email address">
          <input
            className={inputClass}
            type="email"
            inputMode="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Role">
            <select
              className={inputClass}
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              <option value="USER">Member</option>
              <option value="ADMIN">Administrator</option>
              {canInviteSuperAdmin && <option value="SUPER_ADMIN">Super administrator</option>}
            </select>
          </Field>

          {showChurchPicker && (
            <Field
              label={role === "SUPER_ADMIN" ? "Church (optional)" : "Church"}
              hint={
                role === "SUPER_ADMIN"
                  ? "Give them a church to list them in its directory; they administer every church either way."
                  : undefined
              }
            >
              <select
                className={inputClass}
                value={organizationId}
                onChange={(event) => setOrganizationId(event.target.value)}
              >
                <option value="">{role === "SUPER_ADMIN" ? "No church" : "My own church"}</option>
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>
                    {organization.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {role !== "SUPER_ADMIN" && families.length > 0 && (
            <Field label="Family (optional)">
              <select
                className={inputClass}
                value={familyId}
                onChange={(event) => setFamilyId(event.target.value)}
              >
                <option value="">No family yet</option>
                {families.map((family) => (
                  <option key={family.id} value={family.id}>
                    {family.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>

        {error && (
          <p role="alert" className="font-bold text-primary">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" disabled={busy}>
            {busy ? "Sending…" : "Send invitation"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Moving an account to another church. The record goes with it -- see
 * setAccountOrganization in api/src/services/membership.ts -- but family
 * membership and inherited details cannot follow, because both are scoped to a
 * single church. Say so before the fact rather than after.
 */
function MoveChurchModal({
  user,
  organizations,
  onClose,
  onMoved,
}: {
  user: AppUserDto;
  organizations: { id: string; name: string }[];
  onClose: () => void;
  onMoved: () => Promise<void>;
}) {
  const [organizationId, setOrganizationId] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // An app_users row carries no name, so creating a first record needs one.
  const needsName = user.personId === null;

  return (
    <Modal title={`Move ${user.personName ?? user.email}`} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const result = await api<{ move?: { removedAnniversaries: number } }>(
              `/admin/users/${user.id}`,
              {
                method: "PATCH",
                body: {
                  organizationId,
                  ...(needsName ? { firstName, lastName: lastName || null } : {}),
                },
              }
            );
            const removed = result.move?.removedAnniversaries ?? 0;
            if (removed > 0) {
              // Not an error, but it is data that is gone -- do not let it pass
              // silently.
              window.alert(
                `Moved. ${removed} wedding anniversar${removed === 1 ? "y was" : "ies were"} removed, because the other person stayed in the old church.`
              );
            }
            await onMoved();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not move that account");
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-ink-muted">
          Their directory entry, photo, birthday and name day move too. Their family membership and
          any details they shared with a relative will be cleared, because both belong to{" "}
          {user.organizationName ?? "their current church"}.
        </p>

        <Field label="Move to">
          <select
            className={inputClass}
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            required
          >
            <option value="">Choose a church…</option>
            {organizations
              .filter((organization) => organization.id !== user.organizationId)
              .map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
          </select>
        </Field>

        {needsName && (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="First name" hint="They have no directory entry yet">
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
        )}

        {error && (
          <p role="alert" className="font-bold text-primary">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="submit"
            disabled={busy || !organizationId || (needsName && firstName.trim() === "")}
          >
            {busy ? "Moving…" : "Move"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
