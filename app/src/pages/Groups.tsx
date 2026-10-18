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
              <GroupGrid groups={pinned} terms={terms} onTogglePin={pinMutation.mutate} />
            </section>
          )}
          {mine.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 font-bold text-ink">Yours</h2>
              <GroupGrid groups={mine} terms={terms} onTogglePin={pinMutation.mutate} />
            </section>
          )}
          {others.length > 0 && (
            <section>
              {(pinned.length > 0 || mine.length > 0) && (
                <h2 className="mb-3 font-bold text-ink">More groups</h2>
              )}
              <GroupGrid groups={others} terms={terms} onTogglePin={pinMutation.mutate} />
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
 * A plain grid, not CSS multi-column: columns-N + break-inside-avoid balances
 * column height, and at some widths (observed at ~927px with a photo card in
 * the mix) the balance estimate comes in shorter than one unbreakable card,
 * which then renders past where its column box ends instead of the container
 * growing to contain it. Grid's row sizing has no balancing step -- a row is
 * exactly as tall as its tallest cell, and the container always grows to fit
 * every row -- which trades the masonry technique's tighter packing of
 * photo-less cards for not overflowing at all.
 */
function GroupGrid({
  groups,
  terms,
  onTogglePin,
}: {
  groups: GroupSummaryDto[];
  terms: readonly string[];
  onTogglePin: (args: { groupId: string; pinned: boolean }) => void;
}) {
  return (
    <ul className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {groups.map((group) => (
        <li key={group.id}>
          <GroupCard group={group} terms={terms} onTogglePin={onTogglePin} />
        </li>
      ))}
    </ul>
  );
}

const VISIBILITY_TONE: Record<GroupVisibility, "neutral" | "accent" | "primary"> = {
  PUBLIC: "neutral",
  PRIVATE: "accent",
  SECRET: "primary",
};

function GroupCard({
  group,
  terms,
  onTogglePin,
}: {
  group: GroupSummaryDto;
  terms: readonly string[];
  onTogglePin: (args: { groupId: string; pinned: boolean }) => void;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const image = group.cardUrl ?? group.thumbUrl;
  const photo = image && failedUrl !== image ? image : null;

  return (
    <Link
      to={`/groups/${group.id}`}
      className="group relative flex flex-col overflow-hidden rounded-card-photo border border-line bg-surface shadow-sm transition hover:border-accent hover:shadow-md"
    >
      <button
        type="button"
        aria-label={group.pinned ? `Unstar ${group.title}` : `Star ${group.title}`}
        aria-pressed={group.pinned}
        onClick={(event) => {
          // The card underneath is one big link -- without these this would
          // navigate instead of toggling the pin.
          event.preventDefault();
          event.stopPropagation();
          onTogglePin({ groupId: group.id, pinned: group.pinned });
        }}
        className={`tap-target absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full border transition ${
          group.pinned
            ? "border-accent bg-accent text-white"
            : "border-line bg-surface/90 text-ink-muted hover:text-accent"
        }`}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">
          <path d="M10 1.8l2.4 5.1 5.6.7-4.1 3.9 1 5.5L10 14.2 5.1 17l1-5.5L2 7.6l5.6-.7L10 1.8Z" />
        </svg>
      </button>

      {photo && (
        <div className="aspect-card-photo overflow-hidden border-b border-line bg-surface-muted">
          <img
            src={photo}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setFailedUrl(photo)}
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
          />
        </div>
      )}

      <div className="flex flex-1 flex-col gap-2 p-4">
        {/* With no photo the star button sits over the top-right of this row, so
            the row stops short of it and a long name wraps instead of running under. */}
        <div className={`flex items-start justify-between gap-2 ${photo ? "" : "pr-8"}`}>
          <h3 className="min-w-0 break-words text-lg font-bold leading-snug text-ink transition group-hover:text-accent">
            <Highlight text={group.title} ranges={highlightRanges(group.title, terms)} />
          </h3>
          {group.unreadCount > 0 && <Badge tone="primary">{group.unreadCount} new</Badge>}
        </div>

        {group.description && (
          <p className="line-clamp-2 break-words text-sm text-ink-muted">{group.description}</p>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          <Badge tone={VISIBILITY_TONE[group.visibility]}>
            {groupVisibilityLabel(group.visibility)}
          </Badge>
          <span className="text-sm text-ink-muted">
            {group.memberCount} {group.memberCount === 1 ? "member" : "members"}
          </span>
          {group.myRole === "ADMIN" && <Badge tone="accent">Admin</Badge>}
          {group.pendingJoinRequestId && <Badge tone="accent">Waiting for approval</Badge>}
        </div>
      </div>
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
