import { useId, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ROLES,
  USER_STATUSES,
  roleLabel,
  userStatusLabel,
  type AppUserDto,
  type DirectoryRequestDto,
  type FamilySummaryDto,
  type JoinRequestDto,
  type MergeRequestDto,
  type OrganizationDto,
  type Role,
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
  MultiSelect,
  PageHeading,
  Select,
  Spinner,
  inputClass,
} from "../components/ui";
import { Link } from "../components/nav";
import { SearchField } from "../components/SearchField";
import { formatPostedAt } from "../lib/format";

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
 * Only the accounts in the church being viewed -- an administrator's own, or
 * whichever one a super admin has switched to -- and only those can be changed
 * from here. The server holds to the same scope.
 *
 * The search box (name and email) and the role and status filters all narrow
 * the accounts already loaded rather than calling /directory/search. That
 * endpoint returns people, not accounts: no role, no status, and nothing for
 * anyone whose sign-in address was changed, since it matches on persons.email.
 * GET /admin/users already returns everything in scope, so there is nothing to
 * fetch.
 */

/**
 * The roles the actions menu will offer to switch someone to. Deliberately
 * without SUPER_ADMIN: that one is granted when an account is invited or moved,
 * not from a row menu, and it was never offered here.
 */
const ASSIGNABLE_ROLES: Role[] = ["ADMIN", "PRAYER_REQUEST_ADMIN", "USER"];

type UserStatus = AppUserDto["status"];

/** Most to least privileged, the order the filter lists them in. */
const ROLE_OPTIONS = ROLES.map((value) => ({ value, label: roleLabel(value) }));
const STATUS_OPTIONS = USER_STATUSES.map((value) => ({ value, label: userStatusLabel(value) }));

/** Whatever of `allowed` the URL names, ignoring anything a hand-edited link added. */
function readList<T extends string>(params: URLSearchParams, key: string, allowed: readonly T[]) {
  const named = params.getAll(key);
  return allowed.filter((value) => named.includes(value));
}

export function AdminUsers() {
  const { me, isSuperAdmin, organizationId, reload: reloadMe } = useMe();
  const queryClient = useQueryClient();
  const [moving, setMoving] = useState<AppUserDto | null>(null);
  const [changingEmail, setChangingEmail] = useState<AppUserDto | null>(null);
  const [deleting, setDeleting] = useState<AppUserDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState(false);
  /*
   * In the URL rather than in state, so the back chevron brings the filtered
   * table back rather than the whole list -- opening somebody's account from a
   * search of four hundred people and returning to an unfiltered table is the
   * case this page had.
   *
   * Written on every keystroke and always as a `replace`, with no debounce and
   * no separate buffer for what the box shows. Both of those exist on Directory
   * because typing there is a request; here it filters accounts already in hand
   * (see the note above), so the write is free and synchronous and the box can
   * read straight from the URL without the caret ever getting behind it.
   */
  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
  // Repeated parameters, `?role=ADMIN&role=USER`, as on the audit log.
  const roles = useMemo(() => readList(params, "role", ROLES), [params]);
  const statuses = useMemo(() => readList(params, "status", USER_STATUSES), [params]);
  const filtering = search.trim() !== "" || roles.length > 0 || statuses.length > 0;

  function updateParams(mutate: (updated: URLSearchParams) => void): void {
    setParams(
      (prev) => {
        const updated = new URLSearchParams(prev);
        mutate(updated);
        return updated;
      },
      { replace: true }
    );
  }

  function setSearch(next: string): void {
    updateParams((updated) => {
      if (next) updated.set("q", next);
      else updated.delete("q");
    });
  }

  function setList(key: "role" | "status", values: string[]): void {
    updateParams((updated) => {
      updated.delete(key);
      for (const value of values) updated.append(key, value);
    });
  }

  function clearFilters(): void {
    updateParams((updated) => {
      for (const key of ["q", "role", "status"]) updated.delete(key);
    });
  }
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

  // "Request to be added" from the sign-in page, for the parish in view.
  const directoryRequestsQuery = useQuery({
    queryKey: qk.directoryRequests(organizationId),
    queryFn: ({ signal }) =>
      api<{ directoryRequests: DirectoryRequestDto[] }>("/admin/directory-requests", { signal }),
  });

  const users = usersQuery.data?.users ?? [];
  const directoryRequests = directoryRequestsQuery.data?.directoryRequests ?? [];
  const families = familiesQuery.data?.families ?? [];
  const joinRequests = joinRequestsQuery.data?.joinRequests ?? [];
  const mergeRequests = mergesQuery.data?.mergeRequests ?? [];
  const organizations = useMemo(
    () => (organizationsQuery.data?.organizations ?? []).map((o) => ({ id: o.id, name: o.name })),
    [organizationsQuery.data]
  );

  /*
   * The search is over name and email only -- role and status have filters of
   * their own. Every whitespace-separated term has to match somewhere, so
   * "anna smith" narrows rather than widens, the same rule /directory/search
   * applies server-side. An empty filter is no filter.
   */
  const shown = useMemo(() => {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
    return users.filter((user) => {
      if (roles.length > 0 && !roles.includes(user.role)) return false;
      if (statuses.length > 0 && !statuses.includes(user.status)) return false;
      if (terms.length === 0) return true;
      const haystack = [user.personName, user.email].filter(Boolean).join(" ").toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [users, search, roles, statuses]);

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
   * Approving creates an account, so it reloads the accounts list as well as
   * the requests; either decision also retires the bell entry for every
   * administrator, this one included.
   */
  async function decideDirectoryRequest(
    request: DirectoryRequestDto,
    decision: "approve" | "decline"
  ): Promise<void> {
    setActionError(null);
    try {
      await api(`/admin/directory-requests/${request.id}/${decision}`, { method: "POST" });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not decide that request");
    } finally {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.directoryRequests(organizationId) }),
        queryClient.invalidateQueries({ queryKey: qk.notifications() }),
        decision === "approve" ? reload() : Promise.resolve(),
      ]);
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
          filtering
            ? `${shown.length} of ${users.length} ${users.length === 1 ? "account" : "accounts"}`
            : `${users.length} ${users.length === 1 ? "account" : "accounts"}`
        }
        /*
         * The search box, not the Invite button. `actions` is beside the title
         * from `md` up and stacked underneath it on a phone, which is exactly
         * where a search box wants to be. Invite moved down to the list it adds
         * to.
         */
        actions={
          <SearchField
            value={search}
            onChange={setSearch}
            label="Search people and accounts"
            placeholder="Search name or email…"
          />
        }
        filters={
          <>
            <MultiSelect
              aria-label="Filter by role"
              allLabel="All roles"
              summarize={(count) => `${count} roles`}
              options={ROLE_OPTIONS}
              values={roles}
              onChange={(values) => setList("role", values)}
              className="w-full sm:w-56"
            />
            <MultiSelect
              aria-label="Filter by status"
              allLabel="All statuses"
              summarize={(count) => `${count} statuses`}
              options={STATUS_OPTIONS}
              values={statuses}
              onChange={(values) => setList("status", values)}
              className="w-full sm:w-48"
            />
          </>
        }
      />

      {error && <ErrorNotice message={error} onRetry={() => void usersQuery.refetch()} />}

      {directoryRequests.length > 0 && (
        <DirectoryRequestsSection requests={directoryRequests} onDecide={decideDirectoryRequest} />
      )}

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
        <EmptyState
          title={
            roles.length === 0 && statuses.length === 0
              ? `No accounts match “${search.trim()}”`
              : "No accounts match these filters"
          }
        >
          <Button variant="ghost" onClick={clearFilters}>
            Clear filters
          </Button>
        </EmptyState>
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
                  <Badge>{roleLabel(user.role)}</Badge>
                  <StatusBadge status={user.status} />
                </div>
              </div>
              <UserActions
                user={user}
                isSelf={user.id === me?.appUser.id}
                isSuperAdmin={isSuperAdmin}
                onUpdate={update}
                onMove={setMoving}
                onChangeEmail={setChangingEmail}
                onDelete={setDeleting}
              />
            </li>
          ))}
        </ul>
      )}

      {inviting && (
        <InviteModal
          families={families}
          organizationId={organizationId}
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

      {changingEmail && (
        <ChangeEmailModal
          user={changingEmail}
          onClose={() => setChangingEmail(null)}
          onChanged={async () => {
            setChangingEmail(null);
            await reload();
          }}
        />
      )}
    </>
  );
}

/**
 * Requests to be added, from the sign-in page.
 *
 * Collapsed to its heading by default, with the count on the heading either
 * way: unlike a join or merge request these come from people nobody here knows
 * yet, and a parish that gets a steady trickle should not have the accounts
 * list pushed down the page by them. The count is what says there is
 * something to open.
 */
function DirectoryRequestsSection({
  requests,
  onDecide,
}: {
  requests: DirectoryRequestDto[];
  onDecide: (request: DirectoryRequestDto, decision: "approve" | "decline") => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const listId = useId();

  async function decide(request: DirectoryRequestDto, decision: "approve" | "decline") {
    setBusyId(request.id);
    try {
      await onDecide(request, decision);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="mb-6 rounded-lg border border-accent/40 bg-accent/5">
      <h2>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((open) => !open)}
          className="tap-target flex w-full items-center gap-3 rounded-lg p-4 text-left font-bold text-ink hover:bg-accent/10"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="currentColor"
            className={`h-5 w-5 shrink-0 text-ink-muted transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            <path
              fillRule="evenodd"
              d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z"
              clipRule="evenodd"
            />
          </svg>
          <span className="flex-1">Requests to be added</span>
          <Badge tone="primary">
            <span className="sr-only">
              {requests.length === 1 ? "1 request" : `${requests.length} requests`}
            </span>
            <span aria-hidden="true">{requests.length}</span>
          </Badge>
        </button>
      </h2>

      {expanded && (
        <ul id={listId} className="space-y-3 px-4 pb-4">
          {requests.map((request) => (
            <li
              key={request.id}
              className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate font-bold text-ink">
                  {request.firstName} {request.lastName}
                </p>
                <p className="truncate text-sm text-ink-muted">
                  {request.email} · {formatPostedAt(request.requestedAt)}
                </p>
              </div>
              <span className="flex shrink-0 gap-2">
                <Button
                  disabled={busyId === request.id}
                  onClick={() => void decide(request, "approve")}
                >
                  Approve
                </Button>
                <Button
                  variant="ghost"
                  disabled={busyId === request.id}
                  onClick={() => void decide(request, "decline")}
                >
                  Decline
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: UserStatus }) {
  const label = userStatusLabel(status);
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
  onChangeEmail,
  onDelete,
}: {
  user: AppUserDto;
  isSelf: boolean;
  isSuperAdmin: boolean;
  onUpdate: (user: AppUserDto, body: Record<string, unknown>) => Promise<void>;
  onMove: (user: AppUserDto) => void;
  onChangeEmail: (user: AppUserDto) => void;
  onDelete: (user: AppUserDto) => void;
}) {
  const canManage = isSuperAdmin || user.role !== "SUPER_ADMIN";

  const items = [
    /*
     * One entry per role they are not already in, rather than a hand-written
     * promote/demote pair. With three assignable roles a pair would have been
     * six branches, and adding a fourth role later would mean editing this
     * list again instead of just ASSIGNABLE_ROLES.
     */
    ...(canManage
      ? ASSIGNABLE_ROLES.filter((role) => role !== user.role).map((role) => (
          <MenuItem key={`role-${role}`} onSelect={() => void onUpdate(user, { role })}>
            Make {roleLabel(role).toLowerCase()}
          </MenuItem>
        ))
      : []),
    isSuperAdmin && (
      <MenuItem key="move" onSelect={() => onMove(user)}>
        Move church
      </MenuItem>
    ),
    /*
     * Everyone's own address goes through the self-service, code-verified
     * flow on My Details instead (see PersonForm and
     * api/src/services/email-change.ts) -- not offered here even for an
     * admin, since `PATCH /admin/users/:id` already refuses `isSelf`
     * everywhere else a rescue path like this one could lock someone out.
     * This is for everyone *else*: the rescue when they have lost access to
     * their old mailbox and so could never receive the code that flow sends.
     */
    !isSelf && canManage && (
      <MenuItem key="change-email" onSelect={() => onChangeEmail(user)}>
        Change sign-in email
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
  organizationId,
  canInviteSuperAdmin,
  onClose,
  onInvited,
}: {
  families: { id: string; name: string }[];
  /** The church being viewed, which is where the invitation lands. */
  organizationId: string | null;
  canInviteSuperAdmin: boolean;
  onClose: () => void;
  onInvited: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [role, setRole] = useState<Role>("USER");
  const [familyId, setFamilyId] = useState("");
  /*
   * Everyone is invited into the church being viewed, so the new account shows
   * up on the list it was invited from. A super admin alone may instead belong
   * to no church: they administer every one either way, and can join one later
   * from My Details.
   */
  const [inThisChurch, setInThisChurch] = useState<"yes" | "no">("yes");
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
                organizationId:
                  role === "SUPER_ADMIN" && inThisChurch === "no" ? null : organizationId,
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
            <Select
              value={role}
              onChange={setRole}
              options={(
                [
                  "USER",
                  "PRAYER_REQUEST_ADMIN",
                  "ADMIN",
                  ...(canInviteSuperAdmin ? ["SUPER_ADMIN"] : []),
                ] as Role[]
              ).map((value) => ({ value, label: roleLabel(value) }))}
            />
          </Field>

          {role === "SUPER_ADMIN" && (
            <Field
              label="Church"
              hint="In this church, they are listed in its directory; they administer every church either way."
            >
              <Select
                value={inThisChurch}
                onChange={setInThisChurch}
                options={[
                  { value: "yes", label: "This church" },
                  { value: "no", label: "No church" },
                ]}
              />
            </Field>
          )}

          {role !== "SUPER_ADMIN" && families.length > 0 && (
            <Field label="Family (optional)">
              <Select
                value={familyId}
                onChange={setFamilyId}
                options={[
                  { value: "", label: "No family yet" },
                  ...families.map((family) => ({ value: family.id, label: family.name })),
                ]}
              />
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
          <Select
            value={organizationId}
            onChange={setOrganizationId}
            required
            placeholder="Choose a church…"
            options={organizations
              .filter((organization) => organization.id !== user.organizationId)
              .map((organization) => ({ value: organization.id, label: organization.name }))}
          />
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

/**
 * Changes the address an account signs in with, immediately and without a
 * code -- unlike the self-service flow on My Details, which emails one to
 * the new address before anything changes. This is the rescue path for
 * someone who no longer has access to the mailbox that flow would have to
 * reach: an administrator is already trusted to invite and disable this
 * account, and there is no other way back in once the old address is gone
 * (see `PUT /admin/users/:id/email`, api/src/services/email-change.ts). The
 * old address is still emailed a notice once the change lands, so an
 * unexpected one is visible even though nothing here waited for it.
 */
function ChangeEmailModal({
  user,
  onClose,
  onChanged,
}: {
  user: AppUserDto;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal title={`Change sign-in email for ${user.personName ?? user.email}`} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api(`/admin/users/${user.id}/email`, { method: "PUT", body: { email } });
            await onChanged();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not change that address");
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-ink-muted">
          Takes effect immediately, with no code sent to the new address. Their directory contact
          email changes with it, and a notice goes to their current address,{" "}
          <span className="font-bold text-ink">{user.email}</span>, in case this was not them.
        </p>

        <Field label="New sign-in email">
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            className={inputClass}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoFocus
            required
          />
        </Field>

        {error && (
          <p role="alert" className="font-bold text-primary">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" disabled={busy || email.trim() === ""}>
            {busy ? "Changing…" : "Change email"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
