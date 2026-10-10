import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GROUP_EVENT_LOCATION_MAX,
  GROUP_EVENT_TITLE_MAX,
  GROUP_NOTIFICATION_PREFS,
  GROUP_POST_BODY_MAX,
  GROUP_REPORT_REASON_MAX,
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
import { formatPostedAt } from "../lib/format";
import { useMe } from "../context/MeContext";
import { Avatar } from "../components/Avatar";
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

      {group.thumbUrl && (
        <GroupPhoto
          thumbUrl={group.thumbUrl}
          fullUrl={group.fullUrl}
          width={group.photoWidth}
          height={group.photoHeight}
          title={group.title}
        />
      )}

      {group.description && <p className="mb-4 text-ink-muted">{group.description}</p>}

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
      {tab === "events" && <EventsTab groupId={groupId} now={now} onChanged={refresh} />}

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
 * The group's own cover photo, shown whole -- the same reasoning FamilyPhoto
 * gives for not using `Avatar`: a group photo is a group, and a circle crops
 * most of one out. `object-contain` inside a box built from the stored crop
 * dimensions means nothing is cut off and nothing shifts as it loads.
 */
function GroupPhoto({
  thumbUrl,
  fullUrl,
  width,
  height,
  title,
}: {
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
    <div className="mb-4 max-w-sm">
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
  const queryClient = useQueryClient();

  const postsQuery = useQuery({
    queryKey: qk.groupPosts(organizationId, groupId),
    queryFn: ({ signal }) => api<PostsPage>(`/groups/${groupId}/posts`, { signal }),
    refetchOnWindowFocus: true,
  });

  const loadMore = useMutation({
    mutationFn: (cursor: { createdAt: string; id: string }) =>
      api<PostsPage>(`/groups/${groupId}/posts`, {
        query: { cursorCreatedAt: cursor.createdAt, cursorId: cursor.id },
      }),
    onSuccess: (page) => {
      queryClient.setQueryData<PostsPage>(qk.groupPosts(organizationId, groupId), (previous) =>
        previous ? { posts: [...previous.posts, ...page.posts], nextCursor: page.nextCursor } : page
      );
    },
  });

  const canSeeContent =
    group.visibility === "PUBLIC" || group.myRole !== null || group.viewingAsAdmin;
  if (!canSeeContent) {
    return <EmptyState title="Members only">Join this group to see its messages.</EmptyState>;
  }

  const posts = postsQuery.data?.posts ?? [];

  return (
    <div className="space-y-4">
      {(group.canPost || group.canReply) && (
        <Composer groupId={groupId} members={group.members} onPosted={onChanged} />
      )}

      {postsQuery.error && (
        <ErrorNotice message={postsQuery.error.message} onRetry={() => void postsQuery.refetch()} />
      )}

      {postsQuery.isPending ? (
        <Spinner label="Loading messages" />
      ) : posts.length === 0 ? (
        <EmptyState title="No messages yet">
          {group.canPost ? "Be the first to post something." : "Nothing has been posted here yet."}
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              groupId={groupId}
              members={group.members}
              now={now}
              onReport={onReport}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}

      {postsQuery.data?.nextCursor && (
        <div className="pt-2">
          <Button
            variant="secondary"
            disabled={loadMore.isPending}
            onClick={() => loadMore.mutate(postsQuery.data!.nextCursor!)}
          >
            {loadMore.isPending ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}

function PostCard({
  post,
  groupId,
  members,
  now,
  onReport,
  onChanged,
  isReply = false,
}: {
  post: GroupPostDto;
  groupId: string;
  members: GroupMemberDto[];
  now: Date;
  onReport: (post: GroupPostDto) => void;
  onChanged: () => Promise<unknown>;
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

  return (
    <li className={`rounded-lg border border-line bg-surface p-4 ${isReply ? "ml-6" : ""}`}>
      <div className="flex items-start gap-3">
        <Avatar
          thumbUrl={post.authorThumbUrl}
          person={{ firstName: post.authorName, lastName: null }}
          size="sm"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-bold text-ink">{post.authorName}</p>
              <p className="text-sm text-ink-muted">
                {formatPostedAt(post.createdAt, now)}
                {post.editedAt && " · edited"}
              </p>
            </div>
            {!isDeleted && (post.canEdit || post.canDelete || post.canReport) && (
              <MenuButton label={`Actions for this post`}>
                {post.canEdit && <MenuItem onSelect={() => setEditing(true)}>Edit</MenuItem>}
                {post.canDelete && (
                  <MenuItem danger onSelect={() => setConfirmDelete(true)}>
                    Delete
                  </MenuItem>
                )}
                {post.canReport && <MenuItem onSelect={() => onReport(post)}>Report</MenuItem>}
              </MenuButton>
            )}
          </div>

          {isDeleted ? (
            <p className="mt-2 italic text-ink-muted">
              {post.kind === "EVENT" ? "Event cancelled" : "Message deleted"}
            </p>
          ) : editing ? (
            <EditForm
              post={post}
              groupId={groupId}
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
                <p className="mt-2 whitespace-pre-line text-ink">
                  <MentionText text={post.body} mentions={post.mentions} />
                </p>
              )}
              <AttachmentStrip attachments={post.attachments} />
            </>
          )}

          {/*
            A deleted post keeps its reply thread reachable -- "a placeholder
            stays in its place so any replies keep their context"
            (requirements/groups.md) means the thread, not just the tombstone
            text. Only starting a *new* reply is cut off once there is nothing
            left to reply to.
          */}
          {!isReply && (!isDeleted || post.replyCount > 0) && (
            <div className="mt-3 flex items-center gap-4 text-sm">
              {post.replyCount > 0 && (
                <button
                  type="button"
                  className="font-bold text-ink-muted hover:text-primary"
                  onClick={() => setShowReplies((v) => !v)}
                >
                  {showReplies
                    ? "Hide replies"
                    : `${post.replyCount} ${post.replyCount === 1 ? "reply" : "replies"}`}
                </button>
              )}
              {!isDeleted && (post.replyCount === 0 || showReplies) && (
                <button
                  type="button"
                  className="font-bold text-ink-muted hover:text-primary"
                  onClick={() => setReplying((v) => !v)}
                >
                  {post.replyCount === 0 ? "Reply" : "Write a reply"}
                </button>
              )}
            </div>
          )}

          {showReplies && (
            <ul className="mt-3 space-y-3">
              {repliesQuery.isPending ? (
                <li>
                  <Spinner label="Loading replies" />
                </li>
              ) : (
                (repliesQuery.data?.replies ?? []).map((reply) => (
                  <PostCard
                    key={reply.id}
                    post={reply}
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
            <div className="mt-3">
              <Composer
                groupId={groupId}
                members={members}
                parentPostId={post.id}
                compact
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
      </div>

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

function AttachmentStrip({ attachments }: { attachments: GroupPostDto["attachments"] }) {
  if (attachments.length === 0) return null;
  return (
    <ul className="mt-3 flex flex-wrap gap-2">
      {attachments.map((attachment) =>
        attachment.kind === "IMAGE" ? (
          <li key={attachment.id}>
            <a href={attachment.fullUrl ?? undefined} target="_blank" rel="noreferrer">
              <img
                src={attachment.thumbUrl ?? undefined}
                alt={attachment.filename}
                width={attachment.width ?? undefined}
                height={attachment.height ?? undefined}
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

/** Renders `text` with every @ mention in `mentions` picked out in color. */
function MentionText({
  text,
  mentions,
}: {
  text: string;
  mentions: { appUserId: string; name: string }[];
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
    parts.push(
      <span key={key++} className="font-bold text-accent">
        {mention}
      </span>
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
  minHeightClass,
  maxLength,
}: {
  value: string;
  onChange: (value: string) => void;
  members: GroupMemberDto[];
  placeholder: string;
  minHeightClass: string;
  maxLength: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<{ atIndex: number; text: string } | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const [caret, setCaret] = useState<{ top: number; left: number; height: number } | null>(null);
  const [pendingCursor, setPendingCursor] = useState<number | null>(null);

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
    if (!query || matches.length === 0) return;
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
    <div className="relative">
      <textarea
        ref={textareaRef}
        className={`${inputClass} ${minHeightClass}`}
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
          style={{ top: caret.top + caret.height, left: caret.left }}
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
  onClose,
  onSaved,
}: {
  post: GroupPostDto;
  groupId: string;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  return post.kind === "EVENT" && post.event ? (
    <EventEditForm
      post={post}
      event={post.event}
      groupId={groupId}
      onClose={onClose}
      onSaved={onSaved}
    />
  ) : (
    <MessageEditForm post={post} groupId={groupId} onClose={onClose} onSaved={onSaved} />
  );
}

function MessageEditForm({
  post,
  groupId,
  onClose,
  onSaved,
}: {
  post: GroupPostDto;
  groupId: string;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const [body, setBody] = useState(post.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/groups/${groupId}/posts/${post.id}`, { method: "PATCH", body: { body } });
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
      <textarea
        className={`${inputClass} min-h-24`}
        value={body}
        maxLength={GROUP_POST_BODY_MAX}
        onChange={(event) => setBody(event.target.value)}
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
  onClose,
  onSaved,
}: {
  post: GroupPostDto;
  event: NonNullable<GroupPostDto["event"]>;
  groupId: string;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const [eventTitle, setEventTitle] = useState(event.title);
  const [eventDate, setEventDate] = useState(event.eventDate);
  const [startTime, setStartTime] = useState(event.startTime ?? "");
  const [endTime, setEndTime] = useState(event.endTime ?? "");
  const [location, setLocation] = useState(event.location ?? "");
  const [description, setDescription] = useState(event.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/groups/${groupId}/posts/${post.id}`, {
        method: "PATCH",
        body: {
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
        <input
          className={inputClass}
          value={location}
          maxLength={GROUP_EVENT_LOCATION_MAX}
          onChange={(ev) => setLocation(ev.target.value)}
        />
      </Field>
      <Field label="Description" hint="Optional">
        <textarea
          className={`${inputClass} min-h-20`}
          value={description}
          onChange={(ev) => setDescription(ev.target.value)}
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

function Composer({
  groupId,
  members,
  parentPostId,
  compact = false,
  onPosted,
}: {
  groupId: string;
  members: GroupMemberDto[];
  parentPostId?: string;
  compact?: boolean;
  onPosted: () => Promise<unknown>;
}) {
  const { me } = useMe();
  const [body, setBody] = useState("");
  const [isEvent, setIsEvent] = useState(false);
  const [eventTitle, setEventTitle] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useGroupAttachmentPicker();

  const mentionable = members.filter((m) => m.appUserId !== me?.appUser.id);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/groups/${groupId}/posts`, {
        method: "POST",
        body: {
          kind: isEvent ? "EVENT" : "MESSAGE",
          body: isEvent ? undefined : body,
          parentPostId,
          mentionedAppUserIds: findMentionedAppUserIds(body, mentionable),
          attachments: picker.attachments,
          event: isEvent
            ? {
                eventTitle,
                eventDescription: body || undefined,
                eventDate,
                startTime: startTime || undefined,
                endTime: endTime || undefined,
                location: location || undefined,
              }
            : undefined,
        },
      });
      setBody("");
      setEventTitle("");
      setEventDate("");
      setStartTime("");
      setEndTime("");
      setLocation("");
      setIsEvent(false);
      picker.reset();
      await onPosted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post that");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = isEvent ? eventTitle.trim() !== "" && eventDate !== "" : body.trim() !== "";

  return (
    <div className={`rounded-lg border border-line bg-surface p-4 ${compact ? "" : "mb-2"}`}>
      {!parentPostId && (
        <label className="mb-2 flex items-center gap-2 text-sm text-ink-muted">
          <input
            type="checkbox"
            checked={isEvent}
            onChange={(event) => setIsEvent(event.target.checked)}
          />
          This is an event
        </label>
      )}

      {isEvent ? (
        <div className="space-y-2">
          <Field label="Event title">
            <input
              className={inputClass}
              value={eventTitle}
              maxLength={GROUP_EVENT_TITLE_MAX}
              onChange={(event) => setEventTitle(event.target.value)}
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
            <input
              className={inputClass}
              value={location}
              maxLength={GROUP_EVENT_LOCATION_MAX}
              onChange={(event) => setLocation(event.target.value)}
            />
          </Field>
          <Field label="Description" hint="Optional">
            <MentionTextarea
              value={body}
              onChange={setBody}
              members={mentionable}
              placeholder=""
              minHeightClass="min-h-20"
              maxLength={GROUP_POST_BODY_MAX}
            />
          </Field>
        </div>
      ) : (
        <MentionTextarea
          value={body}
          onChange={setBody}
          members={mentionable}
          placeholder={parentPostId ? "Write a reply…" : "Write something…"}
          minHeightClass={compact ? "min-h-16" : "min-h-24"}
          maxLength={GROUP_POST_BODY_MAX}
        />
      )}

      {picker.attachments.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
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

      {picker.elements}
      {picker.error && <p className="mt-1 text-sm font-bold text-primary">{picker.error}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button disabled={busy || !canSubmit} onClick={() => void submit()}>
          {busy ? "Posting…" : parentPostId ? "Reply" : "Post"}
        </Button>
        <Button variant="secondary" onClick={picker.open} disabled={picker.busy || picker.full}>
          {picker.busy ? "Adding…" : "Attach"}
        </Button>
      </div>

      {error && <p className="mt-2 text-sm font-bold text-primary">{error}</p>}
    </div>
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
    <div className="mt-2 rounded-md border border-line bg-surface-muted p-3">
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
                      <Avatar
                        thumbUrl={row.thumbUrl}
                        person={{ firstName: row.name, lastName: null }}
                        size="sm"
                      />
                      <span>
                        {row.name}
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
                {file.authorName} · {new Date(file.postCreatedAt).toLocaleDateString()}
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
  now,
  onChanged,
}: {
  groupId: string;
  now: Date;
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
          <ul className="space-y-3">
            {upcoming.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                groupId={groupId}
                members={[]}
                now={now}
                onReport={() => undefined}
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
          <ul className="space-y-3 opacity-80">
            {past.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                groupId={groupId}
                members={[]}
                now={now}
                onReport={() => undefined}
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
              <Badge tone="accent">
                <span className="ml-1">Admin</span>
              </Badge>
            )}
          </span>
        </div>
        {canModerate && !isSelf && (
          <MenuButton label={`Actions for ${member.name}`}>
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
  const [notificationPref, setNotificationPref] = useState<GroupNotificationPref>(
    group.notificationPref
  );

  const savePref = useMutation({
    mutationFn: (pref: GroupNotificationPref) =>
      api(`/groups/${groupId}/notification-preference`, {
        method: "PUT",
        body: { notificationPref: pref },
      }),
    onSuccess: () => void onChanged(),
  });

  return (
    <div className="border-t border-line pt-4">
      <p className="mb-1 font-bold text-ink">Your notifications for this group</p>
      <select
        className={inputClass}
        value={notificationPref}
        onChange={(event) => {
          const pref = event.target.value as GroupNotificationPref;
          setNotificationPref(pref);
          savePref.mutate(pref);
        }}
      >
        {GROUP_NOTIFICATION_PREFS.map((pref) => (
          <option key={pref} value={pref}>
            {pref === "ALL" ? "All posts" : pref === "MENTIONS" ? "Only when mentioned" : "None"}
          </option>
        ))}
      </select>
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
  const navigate = useNavigate();

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
