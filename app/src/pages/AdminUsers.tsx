import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { AppUserDto, Role } from "@shared";
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
  const { me, isSuperAdmin } = useMe();
  const [users, setUsers] = useState<AppUserDto[]>([]);
  const [families, setFamilies] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [userResult, familyResult] = await Promise.all([
        api<{ users: AppUserDto[] }>("/admin/users"),
        api<{ families: { id: string; name: string }[] }>("/families").catch(() => ({
          families: [],
        })),
      ]);
      setUsers(userResult.users);
      setFamilies(familyResult.families);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load accounts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
          canInviteSuperAdmin={isSuperAdmin}
          onClose={() => setInviting(false)}
          onInvited={async () => {
            setInviting(false);
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
}: {
  user: AppUserDto;
  isSelf: boolean;
  isSuperAdmin: boolean;
  onUpdate: (user: AppUserDto, body: Record<string, unknown>) => Promise<void>;
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
  canInviteSuperAdmin,
  onClose,
  onInvited,
}: {
  families: { id: string; name: string }[];
  canInviteSuperAdmin: boolean;
  onClose: () => void;
  onInvited: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [role, setRole] = useState<Role>("USER");
  const [familyId, setFamilyId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
