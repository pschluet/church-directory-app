import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AppUserDto,
  FamilySummaryDto,
  JoinRequestDto,
  MergeRequestDto,
  OrganizationDto,
  Role,
} from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { useMe } from "../context/MeContext";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  Field,
  MenuButton,
  MenuItem,
  Modal,
  PageHeading,
  Spinner,
  inputClass,
} from "../components/ui";
import { SearchField } from "../components/SearchField";

/**
 * Accounts.
 *
 * Sign-up is disabled on the user pool, so this is the only way in: an
 * administrator enters a name and address, and Cognito emails the invitation.
 *
 * One reflowing list at every width, with every per-account action behind a
 * kebab. It was a table from `md` up, which put a portrait tablet -- 768px, the
 * exact breakpoint -- on the table branch, where six padded columns and four
 * action labels could not fit and an `overflow-hidden` wrapper clipped the rest
 * with no way to scroll to it.
 *
 * The search box filters the accounts already loaded rather than calling
 * /directory/search. That endpoint returns people, not accounts: no role, no
 * status, and nothing for an account with no directory record -- a parish-less
 * super admin -- or for anyone whose sign-in address was changed, since it
 * matches on persons.email. GET /admin/users already returns everything in
 * scope, so there is nothing to fetch.
 */

const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: "Super administrator",
  ADMIN: "Administrator",
  USER: "Member",
};

/** Shared by the badge and the search, so typing what is on screen matches. */
const STATUS_LABELS: Record<AppUserDto["status"], string> = {
  ACTIVE: "Active",
  INVITED: "Invited",
  DISABLED: "Disabled",
};

export function AdminUsers() {
  const { me, isSuperAdmin, organizationId, reload: reloadMe } = useMe();
  const queryClient = useQueryClient();
  const [moving, setMoving] = useState<AppUserDto | null>(null);
  const [deleting, setDeleting] = useState<AppUserDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [search, setSearch] = useState("");
  // Mutation failures only; the read's own is `usersQuery.error`.
  const [actionError, setActionError] = useState<string | null>(null);

  /*
   * Four requests that used to be one `Promise.all`. Three of them carried a
   * `.catch(() => fallback)` so that a refusal did not take the page down --
   * as separate queries that becomes `enabled` plus simply not reading their
   * error, which says the same thing without swallowing anything into state.
   *
   * The organization is in every key, so a super admin switching parish is
   * administering a different set of people without an effect to say so.
   */
  const usersQuery = useQuery({
    queryKey: qk.adminUsers(organizationId),
    queryFn: ({ signal }) => api<{ users: AppUserDto[] }>("/admin/users", { signal }),
  });

  const familiesQuery = useQuery({
    queryKey: qk.families(organizationId),
    queryFn: ({ signal }) => api<{ families: FamilySummaryDto[] }>("/families", { signal }),
  });

  // Only a super admin may read this, and only they can move anyone between
  // churches.
  const organizationsQuery = useQuery({
    queryKey: qk.organizations(),
    queryFn: ({ signal }) =>
      api<{ organizations: OrganizationDto[] }>("/organizations", { withOrg: false, signal }),
    enabled: isSuperAdmin,
  });

  // For an admin this endpoint returns the whole parish, not just their own
  // family.
  const joinRequestsQuery = useQuery({
    queryKey: qk.pendingJoinRequests(organizationId),
    queryFn: ({ signal }) =>
      api<{ joinRequests: JoinRequestDto[] }>("/families/join-requests/pending", { signal }),
  });

  // Same three-way scope as the join-request list: an admin sees every pending
  // merge in the parish, which is what makes a stalled one fixable.
  const mergesQuery = useQuery({
    queryKey: qk.pendingMerges(organizationId),
    queryFn: ({ signal }) =>
      api<{ mergeRequests: MergeRequestDto[] }>("/merges/pending", { signal }),
  });

  const users = usersQuery.data?.users ?? [];
  const families = familiesQuery.data?.families ?? [];
  const joinRequests = joinRequestsQuery.data?.joinRequests ?? [];
  const mergeRequests = mergesQuery.data?.mergeRequests ?? [];
  const organizations = useMemo(
    () => (organizationsQuery.data?.organizations ?? []).map((o) => ({ id: o.id, name: o.name })),
    [organizationsQuery.data]
  );

  /*
   * Every whitespace-separated term has to match somewhere, so "smith admin"
   * narrows rather than widens -- the same rule /directory/search applies
   * server-side. Role and status are matched by their labels, because
   * "administrator" and "disabled" are what is on screen to be typed.
   */
  const shown = useMemo(() => {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return users;
    return users.filter((user) => {
      const haystack = [
        user.personName,
        user.email,
        ROLE_LABELS[user.role],
        STATUS_LABELS[user.status],
        user.organizationName,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [users, search]);

  // Only the accounts list gates the page, exactly as it did when it was the
  // one call in the Promise.all without a catch around it.
  const loading = usersQuery.isPending;
  const error = actionError ?? usersQuery.error?.message ?? null;

  // Everything an account write can reach: the accounts themselves, the
  // families and join requests under them, and the directory cards that carry
  // a person's family and role.
  const reload = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.adminUsers(organizationId) }),
      queryClient.invalidateQueries({ queryKey: qk.families(organizationId) }),
      queryClient.invalidateQueries({ queryKey: qk.directoryRoot(organizationId) }),
    ]);
  };

  async function decide(request: JoinRequestDto, decision: "approve" | "deny"): Promise<void> {
    try {
      await api(`/families/join-requests/${request.id}/${decision}`, { method: "POST" });
      await reload();
      // An admin can be approving their own request.
      if (request.personId === me?.appUser.personId) await reloadMe();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not decide that request");
    }
  }

  /*
   * A merge moves a person between families and retires a record, so it sweeps
   * wider than `reload` and always reloads the caller -- an admin can be
   * approving a merge that changes their own family.
   */
  async function decideMerge(
    mergeRequest: MergeRequestDto,
    decision: "approve" | "deny"
  ): Promise<void> {
    try {
      await api(`/merges/${mergeRequest.id}/${decision}`, { method: "POST" });
      await Promise.all([
        reload(),
        queryClient.invalidateQueries({ queryKey: qk.persons(organizationId) }),
        queryClient.invalidateQueries({ queryKey: qk.specialDates(organizationId) }),
      ]);
      await reloadMe();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not decide that merge");
    }
  }

  /*
   * Permanent, and wider than `reload`: the person goes with the account, so
   * their special dates and their place in a family go too. No navigation to
   * do afterwards -- unlike the person page, the row simply leaves this list.
   */
  async function remove(user: AppUserDto): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/admin/users/${user.id}`, { method: "DELETE" });
      await Promise.all([
        reload(),
        queryClient.invalidateQueries({ queryKey: qk.persons(organizationId) }),
        queryClient.invalidateQueries({ queryKey: qk.specialDates(organizationId) }),
      ]);
      setDeleting(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not delete that account");
    } finally {
      setBusy(false);
    }
  }

  async function update(user: AppUserDto, body: Record<string, unknown>): Promise<void> {
    try {
      await api(`/admin/users/${user.id}`, { method: "PATCH", body });
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not update that account");
    }
  }

  return (
    <>
      <PageHeading
        title="People & Accounts"
        subtitle={
          search.trim()
            ? `${shown.length} of ${users.length} ${users.length === 1 ? "account" : "accounts"}`
            : `${users.length} ${users.length === 1 ? "account" : "accounts"}`
        }
        /*
         * The search box, not the Invite button. `actions` is beside the title
         * from `md` up and stacked underneath it on a phone, which is exactly
         * where a search box wants to be; `filters` would keep it below the
         * title at every width. Invite moved down to the list it adds to.
         */
        actions={
          <SearchField
            value={search}
            onChange={setSearch}
            label="Search people and accounts"
            placeholder="Search name, email, role, status…"
          />
        }
      />

      {error && <ErrorNotice message={error} onRetry={() => void usersQuery.refetch()} />}

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

      {mergeRequests.length > 0 && (
        <section className="mb-6 rounded-lg border border-accent/40 bg-accent/5 p-4">
          <h2 className="mb-3 font-bold text-ink">
            Pending merge requests ({mergeRequests.length})
          </h2>
          <ul className="space-y-2">
            {mergeRequests.map((request) => (
              <li
                key={request.id}
                className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <span>
                  {request.duplicatePersonName}
                  {request.duplicateFamilyName ? ` (${request.duplicateFamilyName} family)` : ""} →{" "}
                  {request.accountPersonName}
                </span>
                <span className="flex gap-2">
                  <Button onClick={() => void decideMerge(request, "approve")}>Approve</Button>
                  <Button variant="ghost" onClick={() => void decideMerge(request, "deny")}>
                    Decline
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/*
       * Directly above the list it adds to, rather than in the heading, where
       * the search box now sits. Outside the branch below so it is still there
       * when there are no accounts at all -- which is the one moment inviting
       * someone is the only thing to do.
       */}
      <div className="mb-3 flex justify-end">
        <Button onClick={() => setInviting(true)}>Invite someone</Button>
      </div>

      {loading ? (
        <Spinner label="Loading accounts" />
      ) : users.length === 0 ? (
        <EmptyState title="No accounts yet" />
      ) : shown.length === 0 ? (
        <EmptyState title={`No accounts match “${search.trim()}”`} />
      ) : (
        /*
         * One list at every width, rounded on the rows rather than the
         * container: `overflow-hidden` here would clip an open row menu, and
         * focusing an item that stuck out would make the browser scroll this
         * box and slide the top row out of sight. See FamilyMemberList.
         */
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {shown.map((user) => (
            <li
              key={user.id}
              className="flex items-center gap-3 bg-surface p-4 first:rounded-t-lg last:rounded-b-lg"
            >
              <div className="min-w-0 flex-1">
                {user.personId ? (
                  <Link
                    to={`/people/${user.personId}`}
                    className="block truncate font-bold text-primary hover:text-accent"
                  >
                    {user.personName ?? user.email}
                  </Link>
                ) : (
                  <p className="truncate font-bold text-ink">{user.personName ?? user.email}</p>
                )}
                <p className="truncate text-sm text-ink-muted">{user.email}</p>
                {/*
                 * Badges on a wrapping line rather than table columns: this is
                 * what lets a narrow tablet in portrait reflow instead of
                 * forcing a width nothing could scroll to.
                 */}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge>{ROLE_LABELS[user.role]}</Badge>
                  <StatusBadge status={user.status} />
                  {isSuperAdmin && user.organizationName && (
                    <Badge tone="accent">{user.organizationName}</Badge>
                  )}
                </div>
              </div>
              <UserActions
                user={user}
                isSelf={user.id === me?.appUser.id}
                isSuperAdmin={isSuperAdmin}
                onUpdate={update}
                onMove={setMoving}
                onDelete={setDeleting}
              />
            </li>
          ))}
        </ul>
      )}

      {inviting && (
        <InviteModal
          families={families}
          organizations={organizations}
          canInviteSuperAdmin={isSuperAdmin}
          onClose={() => setInviting(false)}
          onInvited={async () => {
            setInviting(false);
            await reload();
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.personName ?? deleting.email}?`}
          confirmLabel="Delete permanently"
          busy={busy}
          onConfirm={() => void remove(deleting)}
          onClose={() => setDeleting(null)}
        >
          This removes their account, their sign-in, and their directory record — contact details,
          family membership, and every special date recorded for them. A wedding anniversary they
          share with someone will be removed from that person's record too. This cannot be undone.
        </ConfirmDialog>
      )}

      {moving && (
        <MoveChurchModal
          user={moving}
          organizations={organizations}
          onClose={() => setMoving(null)}
          onMoved={async () => {
            setMoving(null);
            await reload();
          }}
        />
      )}
    </>
  );
}

function StatusBadge({ status }: { status: AppUserDto["status"] }) {
  const label = STATUS_LABELS[status];
  if (status === "ACTIVE") return <Badge tone="accent">{label}</Badge>;
  if (status === "INVITED") return <Badge tone="primary">{label}</Badge>;
  return <Badge>{label}</Badge>;
}

/**
 * Every action on an account, in one kebab.
 *
 * They used to be four bare buttons side by side in a table cell, which is
 * most of why the row could not fit a tablet in portrait: the widest label
 * ("Make administrator") set a minimum width no amount of wrapping could get
 * under. This also matches the person and family pages.
 */
function UserActions({
  user,
  isSelf,
  isSuperAdmin,
  onUpdate,
  onMove,
  onDelete,
}: {
  user: AppUserDto;
  isSelf: boolean;
  isSuperAdmin: boolean;
  onUpdate: (user: AppUserDto, body: Record<string, unknown>) => Promise<void>;
  onMove: (user: AppUserDto) => void;
  onDelete: (user: AppUserDto) => void;
}) {
  const canManage = isSuperAdmin || user.role !== "SUPER_ADMIN";

  const items = [
    canManage && user.role === "USER" && (
      <MenuItem key="promote" onSelect={() => void onUpdate(user, { role: "ADMIN" })}>
        Make administrator
      </MenuItem>
    ),
    canManage && user.role === "ADMIN" && (
      <MenuItem key="demote" onSelect={() => void onUpdate(user, { role: "USER" })}>
        Make member
      </MenuItem>
    ),
    isSuperAdmin && (
      <MenuItem key="move" onSelect={() => onMove(user)}>
        Move church
      </MenuItem>
    ),
    /*
     * Destructive items last, so the one that cannot be undone is not next to
     * the one most likely to be aimed at. MenuItem has no separator.
     */
    /*
     * Gated on canManage as well as self, which the old row of buttons was not:
     * it offered an admin "Disable" on a super admin's row and the server
     * answered 404. Harmless as a link that failed, worse as a menu entry that
     * looks like the others.
     */
    !isSelf &&
      canManage &&
      (user.status === "DISABLED" ? (
        <MenuItem key="enable" onSelect={() => void onUpdate(user, { status: "ACTIVE" })}>
          Re-enable
        </MenuItem>
      ) : (
        <MenuItem key="disable" danger onSelect={() => void onUpdate(user, { status: "DISABLED" })}>
          Disable
        </MenuItem>
      )),
    !isSelf && canManage && (
      <MenuItem key="delete" danger onSelect={() => onDelete(user)}>
        Delete permanently
      </MenuItem>
    ),
  ].filter(Boolean);

  /*
   * Nothing applicable means no button at all, rather than a kebab that opens
   * an empty panel. Reachable: an admin looking at a super admin in their own
   * parish can do none of these.
   */
  if (items.length === 0) return null;

  return (
    <MenuButton label={`Actions for ${user.personName ?? user.email}`} className="shrink-0">
      {items}
    </MenuButton>
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
