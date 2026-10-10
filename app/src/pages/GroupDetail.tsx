import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { useNavigate, useParams } from "react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GROUP_DESCRIPTION_MAX,
  GROUP_EVENT_LOCATION_MAX,
  GROUP_EVENT_TITLE_MAX,
  GROUP_NOTIFICATION_PREFS,
  GROUP_NOTIFICATION_PREF_LABELS,
  GROUP_POST_BODY_MAX,
  GROUP_REPORT_REASON_MAX,
  GROUP_TITLE_MAX,
  GROUP_VISIBILITIES,
  groupVisibilityLabel,
  type GroupDto,
  type GroupEventRsvpDto,
  type GroupJoinRequestDto,
  type GroupMemberDto,
  type GroupMemberRole,
  type GroupNotificationPref,
  type GroupPostDto,
  type GroupPostReportDto,
  type GroupRsvpResponse,
  type GroupVisibility,
} from "@shared";
import { api, ApiError } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { formatChatDay, formatChatTime, formatPostedAt, localDayIso } from "../lib/format";
import { useMe } from "../context/MeContext";
import { Avatar } from "../components/Avatar";
import { LocationAutocomplete } from "../components/AddressAutocomplete";
import { Link } from "../components/nav";
import { useFillViewport } from "../components/useFillViewport";
import { useInfiniteScroll } from "../components/useInfiniteScroll";
import { PhotoLightbox } from "../components/PhotoLightbox";
import { PersonPicker, type PickedPerson } from "../components/PersonPicker";
import { usePhotoPicker } from "../components/usePhotoPicker";
import { useGroupAttachmentPicker } from "../components/useGroupAttachmentPicker";
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
  useNow,
} from "../components/ui";

/**
 * One group: its messages, files and events, plus everything a group admin or
 * a parish admin can do to it. See requirements/groups.md for the product
 * rules and services/groups.ts (API) for where the capability flags this page
 * renders off of come from -- nothing here re-derives a permission.
 */

type Tab = "messages" | "files" | "events";

interface PostsPage {
  posts: GroupPostDto[];
  nextCursor: { createdAt: string; id: string } | null;
}

export function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const groupId = id!;
  const { me, isAdmin, organizationId } = useMe();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<Tab>("messages");
  const [showMembers, setShowMembers] = useState(false);
  const [reporting, setReporting] = useState<GroupPostDto | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const groupQuery = useQuery({
    queryKey: qk.group(organizationId, groupId),
    queryFn: ({ signal }) => api<GroupDto>(`/groups/${groupId}`, { signal }),
    refetchOnWindowFocus: true,
  });

  const now = useNow();
  const group = groupQuery.data;

  function refresh(): Promise<unknown> {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.group(organizationId, groupId) }),
      queryClient.invalidateQueries({ queryKey: qk.groupPosts(organizationId, groupId) }),
      queryClient.invalidateQueries({ queryKey: qk.notifications() }),
    ]);
  }

  function handleActionError(err: unknown, fallback: string): void {
    if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
      setActionError("Somebody else got there first — this page has been refreshed.");
      void refresh();
      return;
    }
    setActionError(err instanceof Error ? err.message : fallback);
  }

  const joinMutation = useMutation({
    mutationFn: () =>
      api(`/groups/${groupId}/members`, {
        method: "POST",
        body: { personId: me!.appUser.personId },
      }),
    onSuccess: () => {
      setActionError(null);
      void refresh();
    },
    onError: (err) => handleActionError(err, "Could not join that group"),
  });

  const requestToJoinMutation = useMutation({
    mutationFn: () => api(`/groups/${groupId}/join-requests`, { method: "POST" }),
    onSuccess: () => {
      setActionError(null);
      void refresh();
    },
    onError: (err) => handleActionError(err, "Could not send that request"),
  });

  const leaveMutation = useMutation({
    mutationFn: () => api(`/groups/${groupId}/leave`, { method: "POST" }),
    onSuccess: () => {
      setActionError(null);
      setConfirmLeave(false);
      void refresh();
    },
    // Not `handleActionError`: a 409 here is the sole-admin guard with its own
    // specific message ("promote another admin first"), not a stale-page race
    // -- the generic handler's "somebody else got there first" would be wrong
    // about what actually happened and offer nothing useful to do about it.
    onError: (err) => {
      setConfirmLeave(false);
      setActionError(err instanceof Error ? err.message : "Could not leave that group");
    },
  });

  const markReadMutation = useMutation({
    mutationFn: () => api(`/groups/${groupId}/read`, { method: "POST" }),
    // Settled rather than left to the default: a push could land mid-flight
    // and refetch pre-commit state, the same reasoning NotificationBell's own
    // mark-read gives for not trusting an optimistic update alone.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.group(organizationId, groupId) });
      void queryClient.invalidateQueries({ queryKey: qk.groups(organizationId) });
    },
  });

  /*
   * Viewing the group is what clears its badge -- the same convention
   * NotificationBell uses ("opening it marks everything read"), rather than a
   * button a member has to remember to press. Gated on being a member (no
   * reading position otherwise) and on there being something to clear, so this
   * fires once per group per unread batch rather than on every render.
   */
  useEffect(() => {
    if (group?.myRole && group.unreadCount > 0) markReadMutation.mutate();
  }, [groupId, group?.myRole, group?.unreadCount]);

  if (groupQuery.isPending) return <Spinner label="Loading the group" />;
  if (groupQuery.error) {
    return (
      <ErrorNotice
        message={
          groupQuery.error instanceof ApiError && groupQuery.error.status === 404
            ? "That group was not found."
            : groupQuery.error.message
        }
        onRetry={() => void groupQuery.refetch()}
      />
    );
  }
  if (!group) return null;

  const busy = groupQuery.isFetching;

  return (
    <>
      <PageHeading
        title={group.title}
        subtitle={
          <button type="button" onClick={() => setShowMembers(true)} className="hover:underline">
            {group.memberCount} {group.memberCount === 1 ? "member" : "members"} ·{" "}
            {groupVisibilityLabel(group.visibility)}
          </button>
        }
        // Always exactly one action here (Join, Ask to join, a "waiting"
        // badge, or Leave) -- keep it beside the title on a phone rather than
        // giving it a row of its own.
        compactActions
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {!group.myRole && group.visibility === "PUBLIC" && (
              <Button disabled={joinMutation.isPending} onClick={() => joinMutation.mutate()}>
                {joinMutation.isPending ? "Joining…" : "Join"}
              </Button>
            )}
            {!group.myRole && group.canRequestToJoin && !group.pendingJoinRequestId && (
              <Button
                disabled={requestToJoinMutation.isPending}
                onClick={() => requestToJoinMutation.mutate()}
              >
                Ask to join
              </Button>
            )}
            {!group.myRole && group.pendingJoinRequestId && (
              <Badge tone="accent">Waiting for approval</Badge>
            )}
            {group.myRole && (
              <Button variant="ghost" onClick={() => setConfirmLeave(true)}>
                Leave
              </Button>
            )}
          </div>
        }
      />

      {actionError && (
        <div className="mb-4">
          <ErrorNotice message={actionError} />
        </div>
      )}

      {group.archivedAt && (
        <div className="mb-4 rounded-md border border-line bg-surface-muted p-3 text-sm text-ink-muted">
          This group is archived. It is read-only.
        </div>
      )}

      {group.viewingAsAdmin && (
        <div className="mb-4 rounded-md border border-accent/40 bg-accent/5 p-3 text-sm text-ink">
          You are viewing this group as a parish administrator. You are not a member, and this visit
          has been recorded.
        </div>
      )}

      {group.description && <GroupDescription text={group.description} />}

      {group.pendingJoinRequests.length > 0 && (
        <JoinRequestsBanner
          groupId={groupId}
          requests={group.pendingJoinRequests}
          onDecided={refresh}
        />
      )}

      <div className="mb-4 flex items-center justify-between border-b border-line">
        <nav className="flex gap-1" aria-label="Group sections">
          {(["messages", "files", "events"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-3 py-2 font-bold capitalize transition ${
                tab === t
                  ? "border-primary text-primary"
                  : "border-transparent text-ink-muted hover:text-ink"
              }`}
            >
              {t}
            </button>
          ))}
        </nav>
        <RefreshButton
          busy={busy}
          updatedAt={groupQuery.dataUpdatedAt}
          now={now}
          onRefresh={() => void refresh()}
        />
      </div>

      {tab === "messages" && (
        <MessagesTab
          group={group}
          groupId={groupId}
          now={now}
          onReport={setReporting}
          onChanged={refresh}
        />
      )}
      {tab === "files" && <FilesTab groupId={groupId} />}
      {tab === "events" && (
        <EventsTab
          groupId={groupId}
          members={group.members}
          now={now}
          onReport={setReporting}
          onChanged={refresh}
        />
      )}

      {showMembers && (
        <MembersModal
          group={group}
          groupId={groupId}
          isAdmin={isAdmin}
          onClose={() => setShowMembers(false)}
          onChanged={refresh}
        />
      )}

      {reporting && (
        <ReportModal
          post={reporting}
          groupId={groupId}
          onClose={() => setReporting(null)}
          onReported={async () => {
            setReporting(null);
            await refresh();
          }}
        />
      )}

      {confirmLeave && (
        <ConfirmDialog
          title="Leave this group?"
          confirmLabel="Leave it"
          busy={leaveMutation.isPending}
          onConfirm={() => leaveMutation.mutate()}
          onClose={() => setConfirmLeave(false)}
        >
          <p>
            Your past posts stay in the group, still attributed to you. You can rejoin later if the
            group is still open to it.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

/** Past this many characters or lines the description is previewed, not shown whole. */
const DESCRIPTION_PREVIEW_CHARS = 200;
const DESCRIPTION_PREVIEW_LINES = 3;

/**
 * The group's description, collapsed to a few lines when it is long so it does
 * not eat the room the messages need. Judged by length rather than measured:
 * it is deterministic, costs no layout pass, and a line or two of slack either
 * way does not matter for a preview.
 */
function GroupDescription({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long =
    text.length > DESCRIPTION_PREVIEW_CHARS || text.split("\n").length > DESCRIPTION_PREVIEW_LINES;

  return (
    <div className="mb-4 text-ink-muted">
      <p className={`whitespace-pre-line break-words ${long && !expanded ? "line-clamp-3" : ""}`}>
        {text}
      </p>
      {long && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-sm font-bold text-accent hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function RefreshButton({
  busy,
  updatedAt,
  now,
  onRefresh,
}: {
  busy: boolean;
  updatedAt: number;
  now: Date;
  onRefresh: () => void;
}) {
  return (
    <span className="mb-2 flex items-center gap-2">
      {updatedAt > 0 && (
        <span className="text-sm text-ink-muted">
          Updated · {formatPostedAt(new Date(updatedAt).toISOString(), now)}
        </span>
      )}
      <button
        type="button"
        aria-label="Refresh"
        onClick={onRefresh}
        disabled={busy}
        className="tap-target inline-flex items-center justify-center rounded-md text-ink-muted transition hover:bg-surface-muted hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className={`h-5 w-5 fill-current ${busy ? "animate-spin" : ""}`}
        >
          <path
            d="M16 10a6 6 0 1 1-1.76-4.24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path d="M-2.2 0h4.4l-2.2 3.2z" transform="translate(14.24 5.76) rotate(-45)" />
        </svg>
      </button>
    </span>
  );
}

/**
 * The group's cover photo, as the admin's preview in group settings.
 *
 * It is deliberately not shown on the group's own page any more: the photo was
 * framed for the card on the groups page, which is the one place it is for, and
 * on the conversation page it only pushed the messages down (and, with the
 * messages in their own scroll area, off the bottom of a short window). Shown
 * whole rather than as `Avatar` -- the same reasoning FamilyPhoto gives: a
 * group photo is a group, and a circle crops most of one out.
 */
function GroupPhoto({
  thumbUrl,
  fullUrl,
  width,
  height,
  title,
  className = "",
}: {
  className?: string;
  thumbUrl: string;
  fullUrl: string | null;
  width: number | null;
  height: number | null;
  title: string;
}) {
  const [zoomed, setZoomed] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl === thumbUrl) return null;

  const image = (
    <img
      src={thumbUrl}
      alt={title}
      width={width ?? 4}
      height={height ?? 3}
      loading="lazy"
      decoding="async"
      onError={() => setFailedUrl(thumbUrl)}
      className="h-auto w-full rounded-lg border border-line bg-surface-muted object-contain"
    />
  );

  return (
    <div className={`max-w-48 ${className}`}>
      {fullUrl ? (
        <button
          type="button"
          onClick={() => setZoomed(true)}
          aria-label={`Show the ${title} photo full screen`}
          className="block w-full rounded-lg transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {image}
        </button>
      ) : (
        image
      )}
      {zoomed && fullUrl && (
        <PhotoLightbox src={fullUrl} alt={title} onClose={() => setZoomed(false)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Join requests banner
// ---------------------------------------------------------------------------

function JoinRequestsBanner({
  groupId,
  requests,
  onDecided,
}: {
  groupId: string;
  requests: GroupJoinRequestDto[];
  onDecided: () => Promise<unknown>;
}) {
  const decide = useMutation({
    mutationFn: ({ id: requestId, decision }: { id: string; decision: "approve" | "deny" }) =>
      api(`/groups/${groupId}/join-requests/${requestId}/${decision}`, { method: "POST" }),
    onSuccess: () => void onDecided(),
  });

  return (
    <section className="mb-6 rounded-lg border border-accent/40 bg-accent/5 p-4">
      <h2 className="mb-2 font-bold text-ink">
        {requests.length === 1 ? "One request is" : `${requests.length} requests are`} waiting
      </h2>
      <ul className="space-y-2">
        {requests.map((request) => (
          <li key={request.id} className="flex items-center justify-between gap-3">
            <span>{request.personName}</span>
            <div className="flex gap-2">
              <Button
                disabled={decide.isPending}
                onClick={() => decide.mutate({ id: request.id, decision: "approve" })}
              >
                Approve
              </Button>
              <Button
                variant="ghost"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ id: request.id, decision: "deny" })}
              >
                Deny
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Messages tab
// ---------------------------------------------------------------------------

/** Back-to-back messages by one person within this long share a single byline. */
const GROUPING_WINDOW_MS = 5 * 60_000;

type ChatItem =
  | { type: "divider"; key: string; label: string }
  | { type: "post"; key: string; post: GroupPostDto; showHeader: boolean };

/**
 * Posts (oldest first) laid out as a conversation: a divider wherever the day
 * changes, and a byline only where it is needed -- a new author, a gap, a new
 * day, or anything that is not a plain message (an event card or a deleted
 * placeholder reads wrongly hanging under somebody else's name).
 */
function buildChatItems(posts: GroupPostDto[], now: Date): ChatItem[] {
  const items: ChatItem[] = [];
  let previous: GroupPostDto | null = null;
  for (const post of posts) {
    const day = localDayIso(post.createdAt);
    const newDay = previous === null || localDayIso(previous.createdAt) !== day;
    if (newDay) {
      items.push({ type: "divider", key: `day-${day}`, label: formatChatDay(post.createdAt, now) });
    }
    const showHeader =
      newDay ||
      previous === null ||
      previous.authorPersonId !== post.authorPersonId ||
      new Date(post.createdAt).getTime() - new Date(previous.createdAt).getTime() >
        GROUPING_WINDOW_MS ||
      post.kind === "EVENT" ||
      previous.kind === "EVENT" ||
      post.deletedAt !== null ||
      previous.deletedAt !== null;
    items.push({ type: "post", key: post.id, post, showHeader });
    previous = post;
  }
  return items;
}

function MessagesTab({
  group,
  groupId,
  now,
  onReport,
  onChanged,
}: {
  group: GroupDto;
  groupId: string;
  now: Date;
  onReport: (post: GroupPostDto) => void;
  onChanged: () => Promise<unknown>;
}) {
  const { organizationId } = useMe();

  const canSeeContent =
    group.visibility === "PUBLIC" || group.myRole !== null || group.viewingAsAdmin;

  /*
   * Pages arrive newest-first from the API; the conversation reads oldest-first,
   * so `select` flattens and reverses them. Duplicates are dropped by id first:
   * a refetch re-runs every loaded page with the cursor it was fetched with, so
   * after a new post page 0 comes back shifted by one and overlaps page 1.
   */
  const postsQuery = useInfiniteQuery({
    queryKey: qk.groupPosts(organizationId, groupId),
    queryFn: ({ pageParam, signal }) =>
      api<PostsPage>(`/groups/${groupId}/posts`, {
        signal,
        query: { cursorCreatedAt: pageParam?.createdAt, cursorId: pageParam?.id },
      }),
    initialPageParam: null as PostsPage["nextCursor"],
    getNextPageParam: (last) => last.nextCursor,
    select: (data) => {
      const seen = new Set<string>();
      const posts: GroupPostDto[] = [];
      for (const post of data.pages.flatMap((page) => page.posts)) {
        if (seen.has(post.id)) continue;
        seen.add(post.id);
        posts.push(post);
      }
      return posts.reverse();
    },
    enabled: canSeeContent,
    refetchOnWindowFocus: true,
  });

  const posts = postsQuery.data;
  const items = useMemo(() => buildChatItems(posts ?? [], now), [posts, now]);

  /*
   * The pane: the messages scroll inside it and the composer sits under it, so
   * the page itself never scrolls and the message bar is always on screen.
   * Measured rather than a fixed vh for the reason `useFillViewport` gives; the
   * class is the fallback where nothing can be measured.
   */
  const paneRef = useRef<HTMLDivElement>(null);
  const paneHeight = useFillViewport(paneRef, { gap: 16, min: 360 });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const setScroller = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    setScrollEl(node);
  }, []);

  /** scrollHeight before an older page was requested, to hold the view still after it lands. */
  const anchor = useRef<number | null>(null);
  const atBottom = useRef(true);
  /** Set for the first load and after the member's own post: go to the newest. */
  const forceBottom = useRef(true);

  function trackBottom(): void {
    const el = scrollRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function loadOlder(): void {
    if (!scrollRef.current || postsQuery.isFetchingNextPage || !postsQuery.hasNextPage) return;
    anchor.current = scrollRef.current.scrollHeight;
    void postsQuery.fetchNextPage().then((result) => {
      // A failed fetch must not leave the anchor set for the next, unrelated, change.
      if (result.isError) anchor.current = null;
    });
  }

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !posts || posts.length === 0) return;
    if (anchor.current !== null) {
      // Older posts were prepended above the view: move down by what was added,
      // so what the member was reading does not jump.
      el.scrollTop += el.scrollHeight - anchor.current;
      anchor.current = null;
      return;
    }
    if (forceBottom.current || atBottom.current) {
      el.scrollTop = el.scrollHeight;
      forceBottom.current = false;
    }
  }, [posts, scrollEl]);

  /** An image finishing loading makes its row taller; stay pinned if that is where we were. */
  const onMediaLoad = useCallback(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, []);

  const sentinelRef = useInfiniteScroll(loadOlder, {
    enabled: Boolean(postsQuery.hasNextPage) && !postsQuery.isFetchingNextPage,
    root: scrollEl,
    rootMargin: "200px",
  });

  if (!canSeeContent) {
    return <EmptyState title="Members only">Join this group to see its messages.</EmptyState>;
  }

  async function posted(): Promise<void> {
    forceBottom.current = true;
    await onChanged();
  }

  return (
    <>
      {postsQuery.error && (
        <ErrorNotice message={postsQuery.error.message} onRetry={() => void postsQuery.refetch()} />
      )}

      {postsQuery.isPending ? (
        <Spinner label="Loading messages" />
      ) : (
        <div
          ref={paneRef}
          className="flex h-[70vh] flex-col"
          style={paneHeight ? { height: paneHeight } : undefined}
        >
          <div
            ref={setScroller}
            onScroll={trackBottom}
            role="log"
            aria-label="Messages"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            {/* The sentinel loads on its own; the button is for anyone who cannot scroll to it. */}
            <div ref={sentinelRef} aria-hidden="true" />
            {postsQuery.hasNextPage ? (
              <div className="py-2 text-center">
                <Button
                  variant="ghost"
                  disabled={postsQuery.isFetchingNextPage}
                  onClick={loadOlder}
                >
                  {postsQuery.isFetchingNextPage ? "Loading…" : "Load older messages"}
                </Button>
              </div>
            ) : (
              <p className="py-3 text-center text-sm text-ink-muted">
                {items.length === 0
                  ? group.canPost
                    ? "No messages yet. Be the first to post something."
                    : "Nothing has been posted here yet."
                  : `This is the beginning of ${group.title}.`}
              </p>
            )}

            <ol>
              {items.map((item) =>
                item.type === "divider" ? (
                  <li
                    key={item.key}
                    data-day-divider=""
                    className="my-3 flex items-center gap-3 text-xs font-bold uppercase tracking-wide text-ink-muted"
                  >
                    <span className="h-px flex-1 bg-line" />
                    {item.label}
                    <span className="h-px flex-1 bg-line" />
                  </li>
                ) : (
                  <ChatRow
                    key={item.key}
                    post={item.post}
                    showHeader={item.showHeader}
                    groupId={groupId}
                    members={group.members}
                    now={now}
                    onReport={onReport}
                    onChanged={onChanged}
                    onMediaLoad={onMediaLoad}
                    canReply={group.canReply}
                  />
                )
              )}
            </ol>
          </div>

          <div className="shrink-0 border-t border-line pt-3">
            {group.canPost ? (
              <ChatComposer
                groupId={groupId}
                members={group.members}
                placeholder={`Message ${group.title}`}
                canStartEvent
                onPosted={posted}
              />
            ) : group.canReply ? (
              <p className="text-sm text-ink-muted">
                Only admins can start a conversation here. You can reply to a message.
              </p>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

/** The avatar, linking to the person's page. The name beside it carries the accessible name. */
function AuthorAvatar({ post }: { post: GroupPostDto }) {
  return (
    <Link
      to={`/people/${post.authorPersonId}`}
      aria-hidden="true"
      tabIndex={-1}
      className="shrink-0"
    >
      <Avatar
        thumbUrl={post.authorThumbUrl}
        person={{ firstName: post.authorName, lastName: null }}
        size="sm"
      />
    </Link>
  );
}

function AuthorName({ post }: { post: GroupPostDto }) {
  return (
    <Link
      to={`/people/${post.authorPersonId}`}
      className="font-bold text-ink transition hover:text-accent hover:underline"
    >
      {post.authorName}
    </Link>
  );
}

/**
 * One message in the conversation -- no box, just a row. With `isReply` it is a
 * reply inside a thread (and, reused by the Events tab, a post with no thread
 * controls of its own).
 */
function ChatRow({
  post,
  showHeader,
  groupId,
  members,
  now,
  onReport,
  onChanged,
  onMediaLoad,
  canReply = false,
  isReply = false,
}: {
  post: GroupPostDto;
  showHeader: boolean;
  /** Whether the caller may reply here; offers "Reply" in the actions menu. */
  canReply?: boolean;
  groupId: string;
  members: GroupMemberDto[];
  now: Date;
  onReport: (post: GroupPostDto) => void;
  onChanged: () => Promise<unknown>;
  onMediaLoad?: () => void;
  isReply?: boolean;
}) {
  const { organizationId } = useMe();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showReplies, setShowReplies] = useState(false);
  const [replying, setReplying] = useState(false);

  const repliesQuery = useQuery({
    queryKey: qk.groupReplies(organizationId, groupId, post.id),
    queryFn: ({ signal }) =>
      api<{ replies: GroupPostDto[] }>(`/groups/${groupId}/posts/${post.id}/replies`, { signal }),
    enabled: showReplies,
  });

  const remove = useMutation({
    mutationFn: () => api(`/groups/${groupId}/posts/${post.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setConfirmDelete(false);
      await onChanged();
    },
  });

  const isDeleted = post.deletedAt !== null;
  // Replying lives in the actions menu rather than inline, so a row stays just
  // the message. Not for a reply (one level of threading) or a deleted post.
  const showReplyAction = canReply && !isReply && !isDeleted;
  const hasActions =
    !isDeleted && (showReplyAction || post.canEdit || post.canDelete || post.canReport);
  const header = showHeader || isReply;

  return (
    <li className="group/row relative flex gap-3 rounded-md px-2 py-1 focus-within:bg-surface-muted/60 hover:bg-surface-muted/60">
      {/* The same-width gutter on every row keeps a run of messages lined up under its byline. */}
      <div className="w-10 shrink-0">
        {header ? (
          <AuthorAvatar post={post} />
        ) : (
          <time
            dateTime={post.createdAt}
            title={formatPostedAt(post.createdAt, now)}
            className="block pt-1 text-center text-[11px] leading-5 text-ink-muted opacity-0 group-hover/row:opacity-100"
          >
            {formatChatTime(post.createdAt)}
          </time>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {header && (
          <p className="flex flex-wrap items-baseline gap-x-2">
            <AuthorName post={post} />
            <time
              dateTime={post.createdAt}
              title={formatPostedAt(post.createdAt, now)}
              className="text-xs text-ink-muted"
            >
              {formatChatTime(post.createdAt)}
              {post.editedAt && " · edited"}
            </time>
          </p>
        )}

        {isDeleted ? (
          <p className="italic text-ink-muted">
            {post.kind === "EVENT" ? "Event cancelled" : "Message deleted"}
          </p>
        ) : editing ? (
          <EditForm
            post={post}
            groupId={groupId}
            members={members}
            onClose={() => setEditing(false)}
            onSaved={onChanged}
          />
        ) : (
          <>
            {post.kind === "EVENT" && post.event && (
              <EventBlock
                event={post.event}
                mentions={post.mentions}
                postId={post.id}
                groupId={groupId}
                onChanged={onChanged}
              />
            )}
            {post.body && (
              <p className="whitespace-pre-line break-words text-ink">
                <MentionText text={post.body} mentions={post.mentions} />
                {!header && post.editedAt && (
                  <span className="text-xs text-ink-muted"> (edited)</span>
                )}
              </p>
            )}
            <AttachmentStrip attachments={post.attachments} onMediaLoad={onMediaLoad} />
          </>
        )}

        {/*
          A deleted post keeps its reply thread reachable -- "a placeholder
          stays in its place so any replies keep their context"
          (requirements/groups.md) means the thread, not just the tombstone
          text. Only starting a *new* reply is cut off once there is nothing
          left to reply to.
        */}
        {!isReply && post.replyCount > 0 && (
          <div className="mt-1 flex items-center gap-4 text-sm">
            <button
              type="button"
              className="font-bold text-accent hover:underline"
              onClick={() => setShowReplies((v) => !v)}
            >
              {showReplies
                ? "Hide replies"
                : `${post.replyCount} ${post.replyCount === 1 ? "reply" : "replies"}`}
            </button>
          </div>
        )}

        {showReplies && (
          <ul className="mt-2 border-l-2 border-line pl-2">
            {repliesQuery.isPending ? (
              <li>
                <Spinner label="Loading replies" />
              </li>
            ) : (
              (repliesQuery.data?.replies ?? []).map((reply) => (
                <ChatRow
                  key={reply.id}
                  post={reply}
                  showHeader
                  groupId={groupId}
                  members={members}
                  now={now}
                  onReport={onReport}
                  onChanged={async () => {
                    await onChanged();
                    await repliesQuery.refetch();
                  }}
                  isReply
                />
              ))
            )}
          </ul>
        )}

        {replying && (
          <div className="mt-2">
            <ChatComposer
              groupId={groupId}
              members={members}
              parentPostId={post.id}
              placeholder="Write a reply…"
              onPosted={async () => {
                setReplying(false);
                setShowReplies(true);
                await repliesQuery.refetch();
                await onChanged();
              }}
            />
          </div>
        )}
      </div>

      {/*
        Revealed on hover or focus, by opacity and not `hidden`: a hidden
        control cannot take focus, so a keyboard user could never reach it. A
        touch screen has no hover, so there it is always shown.
      */}
      {hasActions && (
        <div className="absolute -top-3 right-2 rounded-md border border-line bg-surface opacity-0 shadow-sm transition focus-within:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100">
          <MenuButton portal label={`Actions for this post`}>
            {showReplyAction && <MenuItem onSelect={() => setReplying(true)}>Reply</MenuItem>}
            {post.canEdit && <MenuItem onSelect={() => setEditing(true)}>Edit</MenuItem>}
            {post.canDelete && (
              <MenuItem danger onSelect={() => setConfirmDelete(true)}>
                Delete
              </MenuItem>
            )}
            {post.canReport && <MenuItem onSelect={() => onReport(post)}>Report</MenuItem>}
          </MenuButton>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={post.kind === "EVENT" ? "Cancel this event?" : "Delete this post?"}
          confirmLabel={post.kind === "EVENT" ? "Cancel it" : "Delete it"}
          busy={remove.isPending}
          onConfirm={() => remove.mutate()}
          onClose={() => setConfirmDelete(false)}
        >
          <p>A placeholder stays in its place so any replies keep their context.</p>
        </ConfirmDialog>
      )}
    </li>
  );
}

function AttachmentStrip({
  attachments,
  onMediaLoad,
}: {
  attachments: GroupPostDto["attachments"];
  onMediaLoad?: (() => void) | undefined;
}) {
  if (attachments.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2">
      {attachments.map((attachment) =>
        attachment.kind === "IMAGE" ? (
          <li key={attachment.id}>
            <a href={attachment.fullUrl ?? undefined} target="_blank" rel="noreferrer">
              <img
                src={attachment.thumbUrl ?? undefined}
                alt={attachment.filename}
                width={attachment.width ?? undefined}
                height={attachment.height ?? undefined}
                onLoad={onMediaLoad}
                className="h-24 w-24 rounded-md border border-line object-cover"
                loading="lazy"
              />
            </a>
          </li>
        ) : (
          <li key={attachment.id}>
            <a
              href={attachment.downloadUrl ?? undefined}
              download={attachment.filename}
              className="flex items-center gap-2 rounded-md border border-line bg-surface-muted px-3 py-2 text-sm font-bold text-ink hover:border-accent hover:text-accent"
            >
              {attachment.filename}
            </a>
          </li>
        )
      )}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// @ mentions -- plain text in, so a post stays "plain text with clickable
// links" (requirements/groups.md) on the wire; the "@Name" is just literal
// characters in `body`. Highlighting and extraction both work by matching
// those literal names against the group's own membership, not by parsing
// out some separate markup.
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Which members are actually still @ mentioned in `text` -- a member only
 * counts if "@" + their exact name appears with a word boundary on both
 * sides, so "@Maria" in "email@Maria.com" or deleting the name after typing
 * it both behave the way you'd expect without any separate tracked state.
 */
function findMentionedAppUserIds(
  text: string,
  candidates: { appUserId: string; name: string }[]
): string[] {
  const found: string[] = [];
  for (const candidate of candidates) {
    const pattern = new RegExp(
      `(^|\\s)@${escapeRegExp(candidate.name)}(?=$|[^\\p{L}\\p{N}_])`,
      "u"
    );
    if (pattern.test(text)) found.push(candidate.appUserId);
  }
  return found;
}

/**
 * Renders `text` with every @ mention in `mentions` picked out in color, each a
 * link to that person's page.
 */
function MentionText({
  text,
  mentions,
}: {
  text: string;
  mentions: { appUserId: string; personId: string; name: string }[];
}) {
  if (mentions.length === 0) return <>{text}</>;

  // Longest name first, so one mentioned name that happens to be a prefix of
  // another (e.g. two people sharing a first name) doesn't steal the match.
  const names = [...mentions].sort((a, b) => b.name.length - a.name.length);
  const pattern = new RegExp(
    `(^|\\s)(@(?:${names.map((m) => escapeRegExp(m.name)).join("|")})(?=$|[^\\p{L}\\p{N}_]))`,
    "gu"
  );

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const leading = match[1]!;
    const mention = match[2]!;
    const start = match.index + leading.length;
    if (start > lastIndex) parts.push(text.slice(lastIndex, start));
    const person = names.find((m) => mention === `@${m.name}`);
    parts.push(
      person ? (
        <Link
          key={key++}
          to={`/people/${person.personId}`}
          className="font-bold text-accent hover:underline"
        >
          {mention}
        </Link>
      ) : (
        <span key={key++} className="font-bold text-accent">
          {mention}
        </span>
      )
    );
    lastIndex = start + mention.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts}</>;
}

/**
 * Where the caret sits inside a `<textarea>`, in pixels relative to the
 * textarea's own padding box. There is no DOM API for this, so the standard
 * trick is to mirror the textarea into an identically-styled, invisible div
 * and measure where a marker span lands inside it.
 */
function getCaretCoordinates(
  textarea: HTMLTextAreaElement,
  position: number
): { top: number; left: number; height: number } {
  const mirror = document.createElement("div");
  const style = window.getComputedStyle(textarea);
  const MIRRORED_PROPERTIES = [
    "box-sizing",
    "width",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "letter-spacing",
    "line-height",
    "text-transform",
    "word-spacing",
    "text-indent",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
  ];
  for (const prop of MIRRORED_PROPERTIES) {
    mirror.style.setProperty(prop, style.getPropertyValue(prop));
  }
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  document.body.appendChild(mirror);

  mirror.textContent = textarea.value.slice(0, position);
  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(position) || ".";
  mirror.appendChild(marker);

  const coordinates = {
    top: marker.offsetTop - textarea.scrollTop,
    left: marker.offsetLeft - textarea.scrollLeft,
    height: marker.offsetHeight,
  };
  document.body.removeChild(mirror);
  return coordinates;
}

/** The members a post may @ mention: everyone in the group but the person writing. */
function useMentionable(members: GroupMemberDto[]): GroupMemberDto[] {
  const { me } = useMe();
  return useMemo(
    () => members.filter((m) => m.appUserId !== me?.appUser.id),
    [members, me?.appUser.id]
  );
}

/**
 * A plain `<textarea>` that turns into a Slack-style @ mention picker the
 * moment you type "@" -- the dropdown tracks the caret, arrow keys/Enter/Tab
 * pick a highlighted member, and the chosen name is inserted as literal text
 * (see the module comment above for why it's not markup). There is no
 * separate "mention mode": an "@" only starts one when it follows the start
 * of the text or whitespace, so an email address typed into a message is
 * left alone.
 */
function MentionTextarea({
  value,
  onChange,
  members,
  placeholder,
  minHeightClass = "min-h-24",
  maxLength,
  rows,
  autoGrow = false,
  onSubmit,
  ariaLabel,
  dropUp = false,
  bare = false,
}: {
  value: string;
  onChange: (value: string) => void;
  members: GroupMemberDto[];
  placeholder: string;
  minHeightClass?: string;
  maxLength: number;
  rows?: number;
  /** Grow with the text, up to a cap -- for the one-line message bar. */
  autoGrow?: boolean;
  /** Enter (without Shift) sends. The mention list keeps Enter while it is open. */
  onSubmit?: () => void;
  ariaLabel?: string;
  /** Open the mention list above the caret, for a box at the bottom of the screen. */
  dropUp?: boolean;
  /** No border or background of its own; a parent draws the box. */
  bare?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<{ atIndex: number; text: string } | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const [caret, setCaret] = useState<{ top: number; left: number; height: number } | null>(null);
  const [pendingCursor, setPendingCursor] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!autoGrow || !el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [autoGrow, value]);

  useEffect(() => {
    if (pendingCursor === null) return;
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(pendingCursor, pendingCursor);
    }
    setPendingCursor(null);
  }, [pendingCursor]);

  const matches =
    query === null
      ? []
      : members.filter((m) => m.name.toLowerCase().includes(query.text.toLowerCase())).slice(0, 6);

  function detectMention(text: string, cursor: number): void {
    let i = cursor - 1;
    while (i >= 0 && text[i] !== "@" && !/\s/.test(text[i]!)) i--;
    if (i >= 0 && text[i] === "@" && (i === 0 || /\s/.test(text[i - 1]!))) {
      setQuery({ atIndex: i, text: text.slice(i + 1, cursor) });
      setHighlighted(0);
      const el = textareaRef.current;
      if (el) setCaret(getCaretCoordinates(el, i));
    } else {
      setQuery(null);
      setCaret(null);
    }
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    onChange(event.target.value);
    detectMention(event.target.value, event.target.selectionStart);
  }

  function handleSelect(event: SyntheticEvent<HTMLTextAreaElement>): void {
    detectMention(event.currentTarget.value, event.currentTarget.selectionStart);
  }

  function pick(member: GroupMemberDto): void {
    if (!query) return;
    const before = value.slice(0, query.atIndex);
    const after = value.slice(query.atIndex + 1 + query.text.length);
    const inserted = `@${member.name} `;
    onChange(`${before}${inserted}${after}`.slice(0, maxLength));
    setQuery(null);
    setCaret(null);
    setPendingCursor(before.length + inserted.length);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // The picker, when it is open, owns the arrows and Enter.
    if (!query || matches.length === 0) {
      if (onSubmit && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        onSubmit();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((h) => (h + 1) % matches.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((h) => (h - 1 + matches.length) % matches.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      pick(matches[highlighted]!);
    } else if (event.key === "Escape") {
      setQuery(null);
      setCaret(null);
    }
  }

  return (
    <div className={bare ? "relative min-w-0 flex-1" : "relative"}>
      <textarea
        ref={textareaRef}
        rows={rows}
        aria-label={ariaLabel}
        className={
          bare
            ? "block max-h-40 w-full resize-none overflow-y-auto bg-transparent px-1 py-1.5 text-ink outline-none placeholder:text-ink-muted"
            : `${inputClass} ${minHeightClass}`
        }
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onSelect={handleSelect}
        onBlur={() => window.setTimeout(() => setQuery(null), 150)}
      />
      {query && caret && matches.length > 0 && (
        <ul
          className="absolute z-20 max-h-48 w-56 overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-lg"
          style={
            dropUp
              ? { bottom: (textareaRef.current?.offsetHeight ?? 0) - caret.top, left: caret.left }
              : { top: caret.top + caret.height, left: caret.left }
          }
        >
          {matches.map((member, index) => (
            <li key={member.appUserId}>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(member);
                }}
                className={`block w-full px-3 py-1.5 text-left text-sm ${
                  index === highlighted ? "bg-surface-muted text-primary" : "text-ink"
                }`}
              >
                {member.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EditForm({
  post,
  groupId,
  members,
  onClose,
  onSaved,
}: {
  post: GroupPostDto;
  groupId: string;
  members: GroupMemberDto[];
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  return post.kind === "EVENT" && post.event ? (
    <EventEditForm
      post={post}
      event={post.event}
      groupId={groupId}
      members={members}
      onClose={onClose}
      onSaved={onSaved}
    />
  ) : (
    <MessageEditForm
      post={post}
      groupId={groupId}
      members={members}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function MessageEditForm({
  post,
  groupId,
  members,
  onClose,
  onSaved,
}: {
  post: GroupPostDto;
  groupId: string;
  members: GroupMemberDto[];
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const [body, setBody] = useState(post.body ?? "");
  const mentionable = useMentionable(members);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // Mentions are re-read from the text, so adding or deleting an @Name here
      // adds or removes the mention -- and only the newly added are notified.
      await api(`/groups/${groupId}/posts/${post.id}`, {
        method: "PATCH",
        body: { body, mentionedAppUserIds: findMentionedAppUserIds(body, mentionable) },
      });
      onClose();
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that change");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-2">
      <MentionTextarea
        value={body}
        onChange={setBody}
        members={mentionable}
        placeholder=""
        minHeightClass="min-h-24"
        maxLength={GROUP_POST_BODY_MAX}
      />
      {error && <p className="text-sm font-bold text-primary">{error}</p>}
      <div className="flex gap-2">
        <Button disabled={busy || body.trim() === ""} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Editing an event's date, time, or location keeps every RSVP as-is and
 * notifies whoever already answered -- "they're notified of the change"
 * (requirements/groups.md) -- which is why this posts the whole `event`
 * object on save rather than patching one field at a time.
 */
function EventEditForm({
  post,
  event,
  groupId,
  members,
  onClose,
  onSaved,
}: {
  post: GroupPostDto;
  event: NonNullable<GroupPostDto["event"]>;
  groupId: string;
  members: GroupMemberDto[];
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const [eventTitle, setEventTitle] = useState(event.title);
  const [eventDate, setEventDate] = useState(event.eventDate);
  const [startTime, setStartTime] = useState(event.startTime ?? "");
  const [endTime, setEndTime] = useState(event.endTime ?? "");
  const [location, setLocation] = useState(event.location ?? "");
  const [description, setDescription] = useState(event.description ?? "");
  const mentionable = useMentionable(members);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/groups/${groupId}/posts/${post.id}`, {
        method: "PATCH",
        body: {
          mentionedAppUserIds: findMentionedAppUserIds(description, mentionable),
          event: {
            eventTitle,
            eventDescription: description || undefined,
            eventDate,
            startTime: startTime || undefined,
            endTime: endTime || undefined,
            location: location || undefined,
          },
        },
      });
      onClose();
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that change");
    } finally {
      setBusy(false);
    }
  }

  const canSave = eventTitle.trim() !== "" && eventDate !== "";

  return (
    <div className="mt-2 space-y-2">
      <Field label="Event title">
        <input
          className={inputClass}
          value={eventTitle}
          maxLength={GROUP_EVENT_TITLE_MAX}
          onChange={(ev) => setEventTitle(ev.target.value)}
        />
      </Field>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Field label="Date">
          <input
            type="date"
            className={inputClass}
            value={eventDate}
            onChange={(ev) => setEventDate(ev.target.value)}
          />
        </Field>
        <Field label="Start time" hint="Optional">
          <input
            type="time"
            className={inputClass}
            value={startTime}
            onChange={(ev) => setStartTime(ev.target.value)}
          />
        </Field>
        <Field label="End time" hint="Optional">
          <input
            type="time"
            className={inputClass}
            value={endTime}
            disabled={!startTime}
            onChange={(ev) => setEndTime(ev.target.value)}
          />
        </Field>
      </div>
      <Field label="Location" hint="Optional">
        <LocationAutocomplete
          value={location}
          onChange={setLocation}
          maxLength={GROUP_EVENT_LOCATION_MAX}
        />
      </Field>
      <Field label="Description" hint="Optional">
        <MentionTextarea
          value={description}
          onChange={setDescription}
          members={mentionable}
          placeholder=""
          minHeightClass="min-h-20"
          maxLength={GROUP_POST_BODY_MAX}
        />
      </Field>
      {error && <p className="text-sm font-bold text-primary">{error}</p>}
      <div className="flex gap-2">
        <Button disabled={busy || !canSave} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 fill-current">
      <path d="M10 3a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H4a1 1 0 1 1 0-2h5V4a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 fill-current">
      <path d="M3.4 3.2a.8.8 0 0 1 .9-.1l12.4 6.2a.8.8 0 0 1 0 1.4L4.3 16.9a.8.8 0 0 1-1.1-.9l1.3-5 6.2-1-6.2-1-1.3-5a.8.8 0 0 1 .2-.8Z" />
    </svg>
  );
}

/**
 * The message bar: a line of text, a `+` for what else can go in the message,
 * and send. Used for a top-level message at the foot of the conversation and,
 * with `parentPostId`, for a reply inside a thread.
 *
 * Enter sends and Shift+Enter makes a new line (the mention picker, while open,
 * keeps Enter for choosing a name). The server requires a message to have text,
 * so attachments ride along with some -- they do not send on their own.
 */
function ChatComposer({
  groupId,
  members,
  parentPostId,
  placeholder,
  canStartEvent = false,
  onPosted,
}: {
  groupId: string;
  members: GroupMemberDto[];
  parentPostId?: string;
  placeholder: string;
  /** Offer "Event…" in the + menu. Never for a reply: a reply cannot be an event. */
  canStartEvent?: boolean;
  onPosted: () => Promise<unknown>;
}) {
  const [body, setBody] = useState("");
  const [eventOpen, setEventOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useGroupAttachmentPicker();
  const mentionable = useMentionable(members);

  async function submit(): Promise<void> {
    if (busy || body.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await api(`/groups/${groupId}/posts`, {
        method: "POST",
        body: {
          kind: "MESSAGE",
          body,
          parentPostId,
          mentionedAppUserIds: findMentionedAppUserIds(body, mentionable),
          attachments: picker.attachments,
        },
      });
      setBody("");
      picker.reset();
      await onPosted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post that");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {picker.attachments.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {picker.attachments.map((attachment) => (
            <li key={attachment.photoKey} className="relative">
              {attachment.kind === "IMAGE" ? (
                <img
                  src={`/${attachment.photoKey}thumb`}
                  alt={attachment.filename}
                  className="h-16 w-16 rounded-md border border-line object-cover"
                />
              ) : (
                <span className="flex h-16 items-center rounded-md border border-line bg-surface-muted px-2 text-xs">
                  {attachment.filename}
                </span>
              )}
              <button
                type="button"
                aria-label={`Remove ${attachment.filename}`}
                onClick={() => picker.remove(attachment.photoKey)}
                className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full border border-line bg-surface text-sm leading-none text-ink-muted shadow-sm hover:text-primary"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-1 rounded-lg border border-line bg-surface px-1 py-1 focus-within:border-accent">
        <MenuButton
          portal
          align="left"
          label="Add to this message"
          trigger={<PlusIcon />}
          className="shrink-0"
        >
          <MenuItem
            onSelect={() => {
              if (!picker.busy && !picker.full) picker.open();
            }}
          >
            Photo or file
          </MenuItem>
          {canStartEvent && <MenuItem onSelect={() => setEventOpen(true)}>Event…</MenuItem>}
        </MenuButton>

        <MentionTextarea
          bare
          rows={1}
          autoGrow
          dropUp
          value={body}
          onChange={setBody}
          members={mentionable}
          placeholder={placeholder}
          ariaLabel={parentPostId ? "Reply" : "Message"}
          maxLength={GROUP_POST_BODY_MAX}
          onSubmit={() => void submit()}
        />

        <button
          type="button"
          aria-label="Send"
          disabled={busy || body.trim() === ""}
          onClick={() => void submit()}
          className="tap-target inline-flex shrink-0 items-center justify-center rounded-md text-primary transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:text-ink-muted disabled:opacity-60"
        >
          <SendIcon />
        </button>
      </div>

      {picker.elements}
      {(picker.error || error) && (
        <p role="alert" className="text-sm font-bold text-primary">
          {picker.error ?? error}
        </p>
      )}

      {eventOpen && (
        <EventComposerModal
          groupId={groupId}
          members={members}
          onClose={() => setEventOpen(false)}
          onPosted={async () => {
            setEventOpen(false);
            await onPosted();
          }}
        />
      )}
    </div>
  );
}

/**
 * Starting an event, from the `+` menu. A modal rather than a form in the
 * message bar so the bar stays one line; events take no attachments, which the
 * old inline form allowed but nothing ever relied on.
 */
function EventComposerModal({
  groupId,
  members,
  onClose,
  onPosted,
}: {
  groupId: string;
  members: GroupMemberDto[];
  onClose: () => void;
  onPosted: () => Promise<unknown>;
}) {
  const [eventTitle, setEventTitle] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mentionable = useMentionable(members);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/groups/${groupId}/posts`, {
        method: "POST",
        body: {
          kind: "EVENT",
          mentionedAppUserIds: findMentionedAppUserIds(description, mentionable),
          attachments: [],
          event: {
            eventTitle,
            eventDescription: description || undefined,
            eventDate,
            startTime: startTime || undefined,
            endTime: endTime || undefined,
            location: location || undefined,
          },
        },
      });
      await onPosted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post that");
      setBusy(false);
    }
  }

  const canSubmit = eventTitle.trim() !== "" && eventDate !== "";

  return (
    <Modal title="New event" onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit && !busy) void submit();
        }}
      >
        <Field label="Event title">
          <input
            className={inputClass}
            value={eventTitle}
            maxLength={GROUP_EVENT_TITLE_MAX}
            onChange={(event) => setEventTitle(event.target.value)}
            autoFocus
          />
        </Field>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Field label="Date">
            <input
              type="date"
              className={inputClass}
              value={eventDate}
              onChange={(event) => setEventDate(event.target.value)}
            />
          </Field>
          <Field label="Start time" hint="Optional">
            <input
              type="time"
              className={inputClass}
              value={startTime}
              onChange={(event) => setStartTime(event.target.value)}
            />
          </Field>
          <Field label="End time" hint="Optional">
            <input
              type="time"
              className={inputClass}
              value={endTime}
              disabled={!startTime}
              onChange={(event) => setEndTime(event.target.value)}
            />
          </Field>
        </div>
        <Field label="Location" hint="Optional">
          <LocationAutocomplete
            value={location}
            onChange={setLocation}
            maxLength={GROUP_EVENT_LOCATION_MAX}
          />
        </Field>
        <Field label="Description" hint="Optional">
          <MentionTextarea
            value={description}
            onChange={setDescription}
            members={mentionable}
            placeholder=""
            minHeightClass="min-h-20"
            maxLength={GROUP_POST_BODY_MAX}
          />
        </Field>

        {error && (
          <p role="alert" className="text-sm font-bold text-primary">
            {error}
          </p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" disabled={busy || !canSubmit}>
            {busy ? "Posting…" : "Post event"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Event block (RSVP)
// ---------------------------------------------------------------------------

const RSVP_OPTIONS: GroupRsvpResponse[] = ["YES", "MAYBE", "NO"];
const RSVP_LABELS: Record<GroupRsvpResponse, string> = {
  YES: "Going",
  MAYBE: "Maybe",
  NO: "Not going",
};

function EventBlock({
  event,
  mentions,
  postId,
  groupId,
  onChanged,
}: {
  event: NonNullable<GroupPostDto["event"]>;
  mentions: GroupPostDto["mentions"];
  postId: string;
  groupId: string;
  onChanged: () => Promise<unknown>;
}) {
  const [guestCount, setGuestCount] = useState(event.myRsvp?.guestCount ?? 0);
  const [showRsvps, setShowRsvps] = useState(false);
  const rsvp = useMutation({
    mutationFn: (response: GroupRsvpResponse) =>
      api(`/groups/${groupId}/posts/${postId}/rsvp`, {
        method: "PUT",
        body: { response, guestCount },
      }),
    onSuccess: () => void onChanged(),
  });

  return (
    <div className="mt-1 max-w-xl rounded-md border border-line bg-surface-muted p-3">
      <p className="font-bold text-ink">{event.title}</p>
      <p className="text-sm text-ink-muted">
        {event.eventDate}
        {event.startTime && ` · ${event.startTime}${event.endTime ? `–${event.endTime}` : ""}`}
        {event.location && ` · ${event.location}`}
      </p>
      {event.description && (
        <p className="mt-1 whitespace-pre-line text-ink">
          <MentionText text={event.description} mentions={mentions} />
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {RSVP_OPTIONS.map((option) => (
          <Button
            key={option}
            variant={event.myRsvp?.response === option ? "primary" : "secondary"}
            disabled={rsvp.isPending}
            onClick={() => rsvp.mutate(option)}
          >
            {RSVP_LABELS[option]}
          </Button>
        ))}
        {event.myRsvp?.response === "YES" && (
          <label className="flex items-center gap-1 text-sm text-ink-muted">
            +guests
            <input
              type="number"
              min={0}
              max={50}
              value={guestCount}
              onChange={(ev) => setGuestCount(Number(ev.target.value))}
              onBlur={() => rsvp.mutate("YES")}
              className="w-14 rounded-md border border-line px-1 py-0.5"
            />
          </label>
        )}
      </div>

      <button
        type="button"
        onClick={() => setShowRsvps(true)}
        className="mt-2 text-sm text-ink-muted hover:underline"
      >
        {event.rsvpCounts.yes} going · {event.rsvpCounts.maybe} maybe · {event.rsvpCounts.no} not
        going
      </button>

      {showRsvps && (
        <RsvpListModal groupId={groupId} postId={postId} onClose={() => setShowRsvps(false)} />
      )}
    </div>
  );
}

const RESPONSE_SECTIONS: { response: GroupRsvpResponse; heading: string }[] = [
  { response: "YES", heading: "Going" },
  { response: "MAYBE", heading: "Maybe" },
  { response: "NO", heading: "Not going" },
];

/**
 * The roster behind the aggregate line -- every RSVP by name, and how many
 * guests each "going" is bringing, since the post's own `rsvpCounts` is only
 * ever a headcount. Fetched lazily, the same reasoning `MembersModal` gives
 * for not loading this until someone actually opens it.
 */
function RsvpListModal({
  groupId,
  postId,
  onClose,
}: {
  groupId: string;
  postId: string;
  onClose: () => void;
}) {
  const { organizationId } = useMe();
  const rsvpsQuery = useQuery({
    queryKey: qk.groupPostRsvps(organizationId, groupId, postId),
    queryFn: ({ signal }) =>
      api<{ rsvps: GroupEventRsvpDto[] }>(`/groups/${groupId}/posts/${postId}/rsvps`, { signal }),
  });

  const rsvps = rsvpsQuery.data?.rsvps ?? [];
  const going = rsvps.filter((r) => r.response === "YES");
  const totalGuests = going.reduce((sum, r) => sum + r.guestCount, 0);
  const totalAttending = going.length + totalGuests;

  return (
    <Modal title="Who's RSVP'd" onClose={onClose}>
      {rsvpsQuery.isPending ? (
        <Spinner label="Loading RSVPs" />
      ) : rsvps.length === 0 ? (
        <p className="text-ink-muted">Nobody has RSVP'd yet.</p>
      ) : (
        <div className="space-y-4">
          <p className="font-bold text-ink">
            {totalAttending} total attending ({going.length}{" "}
            {going.length === 1 ? "member" : "members"}
            {totalGuests > 0 && ` + ${totalGuests} ${totalGuests === 1 ? "guest" : "guests"}`})
          </p>
          {RESPONSE_SECTIONS.map(({ response, heading }) => {
            const rows = rsvps.filter((r) => r.response === response);
            if (rows.length === 0) return null;
            return (
              <div key={response}>
                <p className="mb-1 font-bold text-ink">
                  {heading} ({rows.length})
                </p>
                <ul className="space-y-1">
                  {rows.map((row) => (
                    <li key={row.appUserId} className="flex items-center gap-2 text-ink">
                      <Link
                        to={`/people/${row.personId}`}
                        aria-hidden="true"
                        tabIndex={-1}
                        className="shrink-0"
                      >
                        <Avatar
                          thumbUrl={row.thumbUrl}
                          person={{ firstName: row.name, lastName: null }}
                          size="sm"
                        />
                      </Link>
                      <span>
                        <Link
                          to={`/people/${row.personId}`}
                          className="hover:text-accent hover:underline"
                        >
                          {row.name}
                        </Link>
                        {response === "YES" && row.guestCount > 0 && (
                          <span className="text-ink-muted">
                            {" "}
                            +{row.guestCount} {row.guestCount === 1 ? "guest" : "guests"}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Files tab
// ---------------------------------------------------------------------------

function FilesTab({ groupId }: { groupId: string }) {
  const { organizationId } = useMe();
  const filesQuery = useQuery({
    queryKey: qk.groupFiles(organizationId, groupId),
    queryFn: ({ signal }) =>
      api<{ files: import("@shared").GroupFileDto[] }>(`/groups/${groupId}/files`, { signal }),
  });

  const files = filesQuery.data?.files ?? [];

  if (filesQuery.isPending) return <Spinner label="Loading files" />;
  if (files.length === 0) {
    return (
      <EmptyState title="Nothing shared yet">
        Pictures and documents posted to Messages show up here.
      </EmptyState>
    );
  }

  return (
    <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
      {files.map((file) => (
        <li key={file.attachment.id} className="flex items-start justify-between gap-3 p-3">
          <div className="flex min-w-0 items-start gap-3">
            {file.attachment.kind === "IMAGE" ? (
              <img
                src={file.attachment.thumbUrl ?? undefined}
                alt=""
                className="h-12 w-12 shrink-0 rounded-md border border-line object-cover"
              />
            ) : (
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-line bg-surface-muted text-xs text-ink-muted">
                File
              </span>
            )}
            <div className="min-w-0">
              <p className="break-words font-bold text-ink [overflow-wrap:anywhere]">
                {file.attachment.filename}
              </p>
              <p className="text-sm text-ink-muted">
                <Link
                  to={`/people/${file.authorPersonId}`}
                  className="hover:text-accent hover:underline"
                >
                  {file.authorName}
                </Link>{" "}
                · {new Date(file.postCreatedAt).toLocaleDateString()}
              </p>
            </div>
          </div>
          <a
            href={file.attachment.fullUrl ?? file.attachment.downloadUrl ?? undefined}
            target={file.attachment.fullUrl ? "_blank" : undefined}
            download={file.attachment.downloadUrl ? file.attachment.filename : undefined}
            rel="noreferrer"
            className="shrink-0 font-bold text-accent hover:underline"
          >
            Open
          </a>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Events tab
// ---------------------------------------------------------------------------

function EventsTab({
  groupId,
  members,
  now,
  onReport,
  onChanged,
}: {
  groupId: string;
  /*
   * The real members, not an empty list: editing an event re-derives its
   * mentions from the description against this list, so an empty one would
   * silently strip every mention from any event edited from this tab.
   */
  members: GroupMemberDto[];
  now: Date;
  onReport: (post: GroupPostDto) => void;
  onChanged: () => Promise<unknown>;
}) {
  const { organizationId } = useMe();
  const eventsQuery = useQuery({
    queryKey: qk.groupEvents(organizationId, groupId),
    queryFn: ({ signal }) =>
      api<{ events: GroupPostDto[] }>(`/groups/${groupId}/events`, { signal }),
  });

  const events = eventsQuery.data?.events ?? [];
  if (eventsQuery.isPending) return <Spinner label="Loading events" />;
  if (events.length === 0)
    return <EmptyState title="No events yet">Events posted to Messages show up here.</EmptyState>;

  const todayIso = new Date().toISOString().slice(0, 10);
  const upcoming = events.filter((e) => (e.event?.eventDate ?? "") >= todayIso);
  const past = events.filter((e) => (e.event?.eventDate ?? "") < todayIso);

  return (
    <div className="space-y-6">
      {upcoming.length > 0 && (
        <section>
          <h2 className="mb-2 font-bold text-ink">Upcoming</h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {upcoming.map((post) => (
              <ChatRow
                key={post.id}
                post={post}
                showHeader
                groupId={groupId}
                members={members}
                now={now}
                onReport={onReport}
                onChanged={onChanged}
                isReply
              />
            ))}
          </ul>
        </section>
      )}
      {past.length > 0 && (
        <section>
          <h2 className="mb-2 font-bold text-ink">Past</h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface opacity-80">
            {past.map((post) => (
              <ChatRow
                key={post.id}
                post={post}
                showHeader
                groupId={groupId}
                members={members}
                now={now}
                onReport={onReport}
                onChanged={onChanged}
                isReply
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Members modal, with admin settings
// ---------------------------------------------------------------------------

function MembersModal({
  group,
  groupId,
  isAdmin,
  onClose,
  onChanged,
}: {
  group: GroupDto;
  groupId: string;
  isAdmin: boolean;
  onClose: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const filtered = group.members.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()));
  const admins = group.members.filter((m) => m.role === "ADMIN");

  return (
    <Modal title={group.title} onClose={onClose} wide={group.canModerate}>
      <div className="space-y-6">
        <div>
          <p className="mb-1 font-bold text-ink">Admins</p>
          <p className="text-sm text-ink-muted">{admins.map((a) => a.name).join(", ") || "None"}</p>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="font-bold text-ink">Members</p>
            {group.canInvite && (
              <Button variant="secondary" onClick={() => setAdding(true)}>
                Add someone
              </Button>
            )}
          </div>
          <input
            className={`${inputClass} mb-2`}
            placeholder="Search members…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-md border border-line">
            {filtered.map((member) => (
              <MemberRow
                key={member.appUserId}
                member={member}
                groupId={groupId}
                canModerate={group.canModerate}
                onChanged={onChanged}
              />
            ))}
          </ul>
        </div>

        {group.myRole && (
          <NotificationPrefPanel group={group} groupId={groupId} onChanged={onChanged} />
        )}

        {group.canModerate && (
          <AdminSettingsPanel
            group={group}
            groupId={groupId}
            isAdmin={isAdmin}
            onChanged={onChanged}
          />
        )}

        {adding && (
          <AddMemberModal
            groupId={groupId}
            onClose={() => setAdding(false)}
            onAdded={async () => {
              setAdding(false);
              await onChanged();
            }}
          />
        )}
      </div>
    </Modal>
  );
}

function MemberRow({
  member,
  groupId,
  canModerate,
  onChanged,
}: {
  member: GroupMemberDto;
  groupId: string;
  canModerate: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const { me } = useMe();
  const isSelf = member.appUserId === me?.appUser.id;
  const [error, setError] = useState<string | null>(null);

  const setRole = useMutation({
    mutationFn: (role: GroupMemberRole) =>
      api(`/groups/${groupId}/members/${member.personId}/role`, { method: "POST", body: { role } }),
    onSuccess: () => {
      setError(null);
      void onChanged();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not change their role"),
  });
  const removeMember = useMutation({
    mutationFn: () => api(`/groups/${groupId}/members/${member.personId}`, { method: "DELETE" }),
    onSuccess: () => {
      setError(null);
      void onChanged();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not remove them"),
  });

  return (
    <li className="flex flex-col gap-1 p-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Avatar
            thumbUrl={member.thumbUrl}
            person={{ firstName: member.name, lastName: null }}
            size="sm"
          />
          <span>
            {member.name}
            {member.role === "ADMIN" && (
              <span className="ml-2 inline-block">
                <Badge tone="accent">Admin</Badge>
              </span>
            )}
          </span>
        </div>
        {/* Portalled: the members list sits in a modal whose own scrolling clips a
            panel that hangs off the bottom of it, hiding the menu. */}
        {canModerate && !isSelf && (
          <MenuButton portal label={`Actions for ${member.name}`}>
            {member.role === "MEMBER" ? (
              <MenuItem onSelect={() => setRole.mutate("ADMIN")}>Make admin</MenuItem>
            ) : (
              <MenuItem onSelect={() => setRole.mutate("MEMBER")}>Remove as admin</MenuItem>
            )}
            <MenuItem danger onSelect={() => removeMember.mutate()}>
              Remove from group
            </MenuItem>
          </MenuButton>
        )}
      </div>
      {error && <p className="text-sm font-bold text-primary">{error}</p>}
    </li>
  );
}

function AddMemberModal({
  groupId,
  onClose,
  onAdded,
}: {
  groupId: string;
  onClose: () => void;
  onAdded: () => Promise<unknown>;
}) {
  const [picked, setPicked] = useState<PickedPerson | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/groups/${groupId}/members`, { method: "POST", body: { personId: picked.id } });
      await onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add them");
      setBusy(false);
    }
  }

  return (
    <Modal title="Add someone to the group" onClose={onClose}>
      <div className="min-h-72 space-y-4">
        <PersonPicker
          label="Search for someone with an account"
          value={picked}
          onChange={setPicked}
          accounts="only"
        />
        {error && <p className="font-bold text-primary">{error}</p>}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button disabled={!picked || busy} onClick={() => void submit()}>
            {busy ? "Adding…" : "Add"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * A member's own notification preference for this group -- personal to every
 * member, not an admin power, so this is shown for anyone with a membership
 * row rather than folded into `AdminSettingsPanel` below.
 */
function NotificationPrefPanel({
  group,
  groupId,
  onChanged,
}: {
  group: GroupDto;
  groupId: string;
  onChanged: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  // Null is "follow my default": the member has no exception for this group.
  const [notificationPref, setNotificationPref] = useState<GroupNotificationPref | null>(
    group.notificationPref
  );

  const savePref = useMutation({
    mutationFn: (pref: GroupNotificationPref | null) =>
      api(`/groups/${groupId}/notification-preference`, {
        method: "PUT",
        body: { notificationPref: pref },
      }),
    onSuccess: () => {
      // The Settings page lists exactly these exceptions.
      void queryClient.invalidateQueries({ queryKey: qk.notificationPreferences() });
      void onChanged();
    },
  });

  return (
    <div className="border-t border-line pt-4">
      <p className="mb-1 font-bold text-ink">Your notifications for this group</p>
      <select
        aria-label="Your notifications for this group"
        className={inputClass}
        value={notificationPref ?? ""}
        onChange={(event) => {
          const pref = (event.target.value || null) as GroupNotificationPref | null;
          setNotificationPref(pref);
          savePref.mutate(pref);
        }}
      >
        <option value="">
          Use my default ({GROUP_NOTIFICATION_PREF_LABELS[group.notificationPrefDefault]})
        </option>
        {GROUP_NOTIFICATION_PREFS.map((pref) => (
          <option key={pref} value={pref}>
            {GROUP_NOTIFICATION_PREF_LABELS[pref]}
          </option>
        ))}
      </select>
      <p className="mt-1 text-sm text-ink-muted">
        Your default for every group is in{" "}
        <Link to="/settings" className="font-bold text-accent hover:underline">
          Settings
        </Link>
        .
      </p>
    </div>
  );
}

function AdminSettingsPanel({
  group,
  groupId,
  isAdmin,
  onChanged,
}: {
  group: GroupDto;
  groupId: string;
  isAdmin: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const [postingRestricted, setPostingRestricted] = useState(group.postingRestricted);
  const [invitesRestricted, setInvitesRestricted] = useState(group.invitesRestricted);
  const [repliesRestricted, setRepliesRestricted] = useState(group.repliesRestricted);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { organizationId } = useMe();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(group.title);
  const [description, setDescription] = useState(group.description ?? "");
  const navigate = useNavigate();

  const saveDetails = useMutation({
    mutationFn: () =>
      api(`/groups/${groupId}`, {
        method: "PATCH",
        body: { title, description },
      }),
    onSuccess: () => {
      // The groups page shows the same title and description.
      void queryClient.invalidateQueries({ queryKey: qk.groups(organizationId) });
      void onChanged();
    },
  });
  const detailsChanged =
    title.trim() !== group.title || description.trim() !== (group.description ?? "");

  const saveSettings = useMutation({
    mutationFn: () =>
      api(`/groups/${groupId}/settings`, {
        method: "POST",
        body: { postingRestricted, invitesRestricted, repliesRestricted },
      }),
    onSuccess: () => void onChanged(),
  });

  const convert = useMutation({
    mutationFn: (visibility: GroupVisibility) =>
      api(`/groups/${groupId}/visibility`, { method: "POST", body: { visibility } }),
    onSuccess: () => void onChanged(),
  });

  const archive = useMutation({
    mutationFn: () => api(`/groups/${groupId}/archive`, { method: "POST" }),
    onSuccess: () => {
      setConfirmArchive(false);
      void onChanged();
    },
  });

  const remove = useMutation({
    mutationFn: () => api(`/groups/${groupId}`, { method: "DELETE" }),
    onSuccess: () => void navigate("/groups", { viewTransition: true }),
  });

  async function attachPhoto(
    photoKey: string | null,
    width?: number,
    height?: number,
    hasCard?: boolean
  ): Promise<void> {
    await api(`/groups/${groupId}/photo`, {
      method: "PUT",
      body: photoKey
        ? { photoKey, photoWidth: width, photoHeight: height, hasCard }
        : { photoKey: null },
    });
    await onChanged();
  }

  const photoPicker = usePhotoPicker({
    owner: { groupId },
    onUploaded: ({ photoKey, width, height, hasCard }) =>
      attachPhoto(photoKey, width, height, hasCard),
  });

  return (
    <div className="space-y-4 border-t border-line pt-4">
      <p className="font-bold text-ink">Group settings</p>

      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (detailsChanged && title.trim() !== "") saveDetails.mutate();
        }}
      >
        <Field label="Title">
          <input
            className={inputClass}
            value={title}
            maxLength={GROUP_TITLE_MAX}
            onChange={(event) => setTitle(event.target.value)}
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
        {saveDetails.error && (
          <p role="alert" className="text-sm font-bold text-primary">
            {saveDetails.error.message}
          </p>
        )}
        <Button
          type="submit"
          disabled={saveDetails.isPending || !detailsChanged || title.trim() === ""}
        >
          {saveDetails.isPending ? "Saving…" : "Save details"}
        </Button>
      </form>

      {group.thumbUrl && (
        <GroupPhoto
          thumbUrl={group.thumbUrl}
          fullUrl={group.fullUrl}
          width={group.photoWidth}
          height={group.photoHeight}
          title={group.title}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={photoPicker.open} disabled={photoPicker.busy}>
          {photoPicker.busy ? "Uploading…" : group.thumbUrl ? "Change photo" : "Add a photo"}
        </Button>
        {group.thumbUrl && (
          <Button variant="ghost" onClick={() => void attachPhoto(null)}>
            Remove photo
          </Button>
        )}
      </div>
      {photoPicker.error && (
        <p className="mt-1 text-sm font-bold text-primary">{photoPicker.error}</p>
      )}
      {photoPicker.elements}

      <ReportQueue groupId={groupId} onChanged={onChanged} />

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={postingRestricted}
            onChange={(event) => setPostingRestricted(event.target.checked)}
          />
          Only admins can post
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={repliesRestricted}
            onChange={(event) => setRepliesRestricted(event.target.checked)}
          />
          Only admins can reply
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={invitesRestricted}
            onChange={(event) => setInvitesRestricted(event.target.checked)}
          />
          Only admins can invite
        </label>
        <Button disabled={saveSettings.isPending} onClick={() => saveSettings.mutate()}>
          {saveSettings.isPending ? "Saving…" : "Save settings"}
        </Button>
      </div>

      {group.canConvertVisibility.length > 0 && (
        <div>
          <p className="mb-1 font-bold text-ink">Visibility</p>
          <div className="flex flex-wrap gap-2">
            {GROUP_VISIBILITIES.filter((v) => group.canConvertVisibility.includes(v)).map((v) => (
              <Button
                key={v}
                variant="secondary"
                disabled={convert.isPending}
                onClick={() => convert.mutate(v)}
              >
                Make {groupVisibilityLabel(v)}
              </Button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        {!group.archivedAt && (
          <Button variant="danger" onClick={() => setConfirmArchive(true)}>
            Archive group
          </Button>
        )}
        {isAdmin && (
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            Delete group
          </Button>
        )}
      </div>

      {confirmArchive && (
        <ConfirmDialog
          title="Archive this group?"
          confirmLabel="Archive it"
          busy={archive.isPending}
          onConfirm={() => archive.mutate()}
          onClose={() => setConfirmArchive(false)}
        >
          <p>It becomes read-only and drops out of the groups list for everyone but its members.</p>
        </ConfirmDialog>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete this group?"
          confirmLabel="Delete it"
          busy={remove.isPending}
          onConfirm={() => remove.mutate()}
          onClose={() => setConfirmDelete(false)}
        >
          <p>Every message, file and event in it is deleted for good. This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * A group admin's own moderation queue -- the per-group counterpart to the
 * parish-wide banner on the Groups page. Resolving is either dismissing the
 * report or deleting the post it is about; either way the report closes, and
 * the reporter is never told which.
 */
function ReportQueue({
  groupId,
  onChanged,
}: {
  groupId: string;
  onChanged: () => Promise<unknown>;
}) {
  const { organizationId } = useMe();
  const queryClient = useQueryClient();
  const reportsQuery = useQuery({
    queryKey: qk.groupReports(organizationId, groupId),
    queryFn: ({ signal }) =>
      api<{ reports: GroupPostReportDto[] }>(`/groups/${groupId}/reports`, { signal }),
  });

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "dismiss" | "delete" }) =>
      api(`/groups/${groupId}/reports/${id}/${decision}`, { method: "POST" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.groupReports(organizationId, groupId) });
      await onChanged();
    },
  });

  const reports = reportsQuery.data?.reports ?? [];
  if (reports.length === 0) return null;

  return (
    <div className="rounded-md border border-accent/40 bg-accent/5 p-3">
      <p className="mb-2 font-bold text-ink">
        {reports.length === 1 ? "One reported post" : `${reports.length} reported posts`}
      </p>
      <ul className="space-y-3">
        {reports.map((report) => (
          <li key={report.id} className="space-y-1">
            <p className="text-sm text-ink">“{report.postExcerpt}”</p>
            {report.reason && <p className="text-sm text-ink-muted">Reason: {report.reason}</p>}
            <div className="flex gap-2">
              <Button
                variant="danger"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ id: report.id, decision: "delete" })}
              >
                Delete post
              </Button>
              <Button
                variant="ghost"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ id: report.id, decision: "dismiss" })}
              >
                Dismiss
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Report modal
// ---------------------------------------------------------------------------

function ReportModal({
  post,
  groupId,
  onClose,
  onReported,
}: {
  post: GroupPostDto;
  groupId: string;
  onClose: () => void;
  onReported: () => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/groups/${groupId}/posts/${post.id}/report`, {
        method: "POST",
        body: { reason: reason.trim() || undefined },
      });
      await onReported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not report that post");
      setBusy(false);
    }
  }

  return (
    <Modal title="Report this post" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-ink-muted">
          This goes to the group's admins and to parish administrators. You will not be told what
          they decide.
        </p>
        <Field label="Anything you want them to know?" hint="Optional.">
          <textarea
            className={`${inputClass} min-h-24`}
            value={reason}
            maxLength={GROUP_REPORT_REASON_MAX}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        {error && <p className="font-bold text-primary">{error}</p>}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="danger" disabled={busy} onClick={() => void submit()}>
            {busy ? "Reporting…" : "Report it"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
