import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GROUP_DESCRIPTION_MAX,
  GROUP_TITLE_MAX,
  GROUP_VISIBILITIES,
  groupCreateSchema,
  groupVisibilityLabel,
  searchTerms,
  type GroupPostReportDto,
  type GroupSummaryDto,
  type GroupVisibility,
} from "@shared";
import { api } from "../lib/api";
import { highlightRanges, matchesTerm } from "../lib/highlight";
import { Highlight } from "../components/Highlight";
import { qk } from "../lib/queryKeys";
import { useMe } from "../context/MeContext";
import { Link } from "../components/nav";
import { SearchField } from "../components/SearchField";
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
import { GroupGuidelinesInfo } from "../components/GroupGuidelinesInfo";

/**
 * Every group the caller may know about: Public and Private ones parish-wide,
 * Secret ones only if they are a member or a parish admin -- the server
 * already filters this, so the page only has to render what it is given. See
 * requirements/groups.md for the visibility rules.
 */
export function Groups() {
  const { me, isAdmin, organizationId } = useMe();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";

  const groupsQuery = useQuery({
    queryKey: qk.groups(organizationId),
    queryFn: ({ signal }) => api<{ groups: GroupSummaryDto[] }>("/groups", { signal }),
  });

  // Every open report parish-wide, so an admin learns about a reported post
  // even in a group they are not a member of. `enabled` keeps this off the
  // wire entirely for anyone below ADMIN -- the endpoint would 403 anyway.
  const reportsQuery = useQuery({
    queryKey: qk.allGroupReports(organizationId),
    queryFn: ({ signal }) => api<{ reports: GroupPostReportDto[] }>("/groups/reports", { signal }),
    enabled: isAdmin,
  });

  const groups = groupsQuery.data?.groups ?? [];
  const reports = reportsQuery.data?.reports ?? [];
  const canCreate = Boolean(me?.appUser.personId);

  /*
   * Searched on the client, same reasoning as Families: the whole list is
   * already here, so there is nothing to debounce, and the box can write
   * straight to the URL so coming Back from a group finds the search still in
   * place. `replace`, as on the Directory, so Back is not an undo of single
   * letters.
   */
  function setQuery(next: string): void {
    setParams(
      (prev) => {
        const updated = new URLSearchParams(prev);
        if (next.trim() === "") updated.delete("q");
        else updated.set("q", next);
        return updated;
      },
      { replace: true }
    );
  }
  const terms = useMemo(() => searchTerms(query).map((term) => term.toLowerCase()), [query]);
  const searching = terms.length > 0;
  const shown = useMemo(
    () =>
      searching ? groups.filter((g) => terms.every((term) => matchesTerm(g.title, term))) : groups,
    [groups, terms, searching]
  );

  const pinMutation = useMutation({
    mutationFn: ({ groupId, pinned }: { groupId: string; pinned: boolean }) =>
      api(`/groups/${groupId}/pin`, { method: pinned ? "DELETE" : "POST" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.groups(organizationId) }),
  });

  const pinned = shown.filter((g) => g.pinned);
  const mine = shown.filter((g) => !g.pinned && g.myRole !== null);
  const others = shown.filter((g) => !g.pinned && g.myRole === null);

  return (
    <>
      <PageHeading
        title="Groups"
        titleAdornment={<GroupGuidelinesInfo />}
        subtitle={
          groupsQuery.isPending
            ? undefined
            : searching
              ? `${shown.length} of ${groups.length} ${groups.length === 1 ? "group" : "groups"}`
              : `${groups.length} ${groups.length === 1 ? "group" : "groups"}`
        }
        actions={
          <div className="flex w-full flex-col gap-3 md:w-auto md:flex-row md:items-center">
            <SearchField
              value={query}
              onChange={setQuery}
              label="Search groups"
              placeholder="Search by group name…"
            />
            {canCreate && <Button onClick={() => setCreating(true)}>Start a group</Button>}
          </div>
        }
      />

      {/* The count above is a plain <p> nothing re-reads; this announces it. */}
      <p role="status" className="sr-only">
        {searching && !groupsQuery.isPending
          ? shown.length === 0
            ? `No group matches ${query.trim()}`
            : `${shown.length} ${shown.length === 1 ? "group matches" : "groups match"} ${query.trim()}`
          : ""}
      </p>

      {groupsQuery.error && (
        <ErrorNotice
          message={groupsQuery.error.message}
          onRetry={() => void groupsQuery.refetch()}
        />
      )}

      {!canCreate && (
        <ErrorNotice message="Your directory record is missing, so you cannot create or join a group. Ask a parish administrator to look into it." />
      )}

      {reports.length > 0 && (
        <section className="mb-6 rounded-lg border border-accent/40 bg-accent/5 p-4">
          <h2 className="mb-2 font-bold text-ink">
            {reports.length === 1 ? "One post has" : `${reports.length} posts have`} been reported
          </h2>
          <ul className="space-y-1 text-sm">
            {reports.map((report) => (
              <li key={report.id}>
                <Link
                  to={`/groups/${report.groupId}`}
                  className="font-bold text-accent hover:underline"
                >
                  {report.groupTitle}
                </Link>
                <span className="text-ink-muted"> — “{report.postExcerpt}”</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {groupsQuery.isPending ? (
        <Spinner label="Loading groups" />
      ) : groups.length === 0 ? (
        <EmptyState title="No groups yet">
          Start one for a ministry, a study, or anything else the parish organizes around.
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState title={`Nothing matches “${query.trim()}”`}>
          <p>Check the spelling, or try a shorter fragment of the group name.</p>
          <p className="mt-3">
            <Button variant="ghost" onClick={() => setQuery("")}>
              Show all groups
            </Button>
          </p>
        </EmptyState>
      ) : (
        <>
          {pinned.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 font-bold text-ink">Starred</h2>
              <GroupList groups={pinned} terms={terms} onTogglePin={pinMutation.mutate} />
            </section>
          )}
          {mine.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 font-bold text-ink">Yours</h2>
              <GroupList groups={mine} terms={terms} onTogglePin={pinMutation.mutate} />
            </section>
          )}
          {others.length > 0 && (
            <section>
              {(pinned.length > 0 || mine.length > 0) && (
                <h2 className="mb-3 font-bold text-ink">More groups</h2>
              )}
              <GroupList groups={others} terms={terms} onTogglePin={pinMutation.mutate} />
            </section>
          )}
        </>
      )}

      {creating && (
        <CreateGroupModal
          existingTitles={groups.map((g) => g.title)}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await queryClient.invalidateQueries({ queryKey: qk.groups(organizationId) });
          }}
        />
      )}
    </>
  );
}

/*
 * One line per group, no card around it: the page is for finding a group, so
 * it fits as many on screen as it can. A hairline between rows keeps them
 * readable without boxing each one in.
 */
function GroupList({
  groups,
  terms,
  onTogglePin,
}: {
  groups: GroupSummaryDto[];
  terms: readonly string[];
  onTogglePin: (args: { groupId: string; pinned: boolean }) => void;
}) {
  return (
    <ul className="divide-y divide-line border-y border-line">
      {groups.map((group) => (
        <li key={group.id}>
          <GroupRow group={group} terms={terms} onTogglePin={onTogglePin} />
        </li>
      ))}
    </ul>
  );
}

/** Gray open padlock, plain closed padlock, red closed padlock. */
const VISIBILITY_ICON_CLASS: Record<GroupVisibility, string> = {
  PUBLIC: "text-ink-muted",
  PRIVATE: "text-ink",
  SECRET: "text-primary",
};

function VisibilityIcon({ visibility }: { visibility: GroupVisibility }) {
  const label = `${groupVisibilityLabel(visibility)} group`;
  return (
    <span title={label} className={`shrink-0 ${VISIBILITY_ICON_CLASS[visibility]}`}>
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className="h-4 w-4 fill-none stroke-current"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="4" y="9" width="12" height="9" rx="1.5" className="fill-current" />
        {/* The shackle: closed drops back into the body, open swings clear of it. */}
        <path
          d={
            visibility === "PUBLIC"
              ? "M6.5 9V6a3.5 3.5 0 0 1 6.8-1.2"
              : "M6.5 9V6a3.5 3.5 0 0 1 7 0v3"
          }
        />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function GroupRow({
  group,
  terms,
  onTogglePin,
}: {
  group: GroupSummaryDto;
  terms: readonly string[];
  onTogglePin: (args: { groupId: string; pinned: boolean }) => void;
}) {
  const unread = group.unreadCount > 0;
  return (
    <Link
      to={`/groups/${group.id}`}
      className="group flex min-h-11 items-center gap-3 px-1 py-1.5 transition hover:bg-surface-muted"
    >
      <VisibilityIcon visibility={group.visibility} />

      {/* Truncated rather than wrapped, so a long name never takes a second line.
          Bold is the only unread marker, like an inbox; the sr-only text says it aloud. */}
      <h3
        className={`min-w-0 flex-1 truncate text-ink transition group-hover:text-accent ${
          unread ? "font-bold" : "font-normal"
        }`}
      >
        <Highlight text={group.title} ranges={highlightRanges(group.title, terms)} />
        {unread && <span className="sr-only">, unread messages</span>}
      </h3>

      {group.pendingJoinRequestId && (
        <span title="Waiting for approval" className="shrink-0">
          <Badge tone="accent">
            <span aria-hidden="true">Pending</span>
            <span className="sr-only">Waiting for approval</span>
          </Badge>
        </span>
      )}

      <span className="flex shrink-0 items-center gap-1 text-sm tabular-nums text-ink-muted">
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">
          <circle cx="7.5" cy="6.5" r="3" />
          <path d="M1.5 16.5c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5v.5h-12v-.5Z" />
          <circle cx="14" cy="7" r="2.4" />
          <path d="M14.5 17h4v-.6c0-2.7-2-4.6-4.6-4.6-.7 0-1.3.1-1.9.4 1.5 1.1 2.5 2.8 2.5 4.8Z" />
        </svg>
        {group.memberCount}
        <span className="sr-only">{group.memberCount === 1 ? "member" : "members"}</span>
      </span>

      <button
        type="button"
        aria-label={group.pinned ? `Unstar ${group.title}` : `Star ${group.title}`}
        aria-pressed={group.pinned}
        onClick={(event) => {
          // The row underneath is one big link -- without these this would
          // navigate instead of toggling the pin.
          event.preventDefault();
          event.stopPropagation();
          onTogglePin({ groupId: group.id, pinned: group.pinned });
        }}
        className={`tap-target -my-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition ${
          group.pinned ? "text-accent" : "text-line hover:text-accent"
        }`}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">
          <path d="M10 1.8l2.4 5.1 5.6.7-4.1 3.9 1 5.5L10 14.2 5.1 17l1-5.5L2 7.6l5.6-.7L10 1.8Z" />
        </svg>
      </button>
    </Link>
  );
}

function CreateGroupModal({
  existingTitles,
  onClose,
  onCreated,
}: {
  existingTitles: string[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<GroupVisibility>("PUBLIC");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const duplicate = existingTitles.some((t) => t.toLowerCase() === title.trim().toLowerCase());

  async function submit(): Promise<void> {
    const parsed = groupCreateSchema.safeParse({ title, description, visibility });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "That is not valid");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/groups", { method: "POST", body: parsed.data });
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create that group");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Start a group" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Title"
          hint={duplicate ? `There is already a group called ${title.trim()}.` : undefined}
        >
          <input
            className={inputClass}
            value={title}
            maxLength={GROUP_TITLE_MAX}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
            required
          />
        </Field>

        <Field label="Description" hint="Optional.">
          <textarea
            className={`${inputClass} min-h-24`}
            value={description}
            maxLength={GROUP_DESCRIPTION_MAX}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <fieldset>
          <legend className="mb-1 font-bold text-ink">Who can join</legend>
          <div className="space-y-2">
            {GROUP_VISIBILITIES.map((option) => (
              <label key={option} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="visibility"
                  checked={visibility === option}
                  onChange={() => setVisibility(option)}
                  className="mt-1"
                />
                <span>
                  <span className="font-bold text-ink">{groupVisibilityLabel(option)}</span>
                  <span className="block text-ink-muted">{VISIBILITY_HELP[option]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {error && (
          <p role="alert" className="font-bold text-primary">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" disabled={busy || title.trim() === ""}>
            {busy ? "Creating…" : "Create"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const VISIBILITY_HELP: Record<GroupVisibility, string> = {
  PUBLIC: "Anyone can see it, join it, and read its messages.",
  PRIVATE: "Anyone can see it exists, but joining takes an invite or your request to be approved.",
  SECRET: "Only members — and parish administrators — can see it exists at all.",
};
