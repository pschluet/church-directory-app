import { useState } from "react";
import { Navigate, useLocation, useParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { GroupDto, GroupEventRsvpDto, GroupPostDto, PublicEventRsvpDto } from "@shared";
import { api, ApiError } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { formatDayLabel, formatEventTimes, formatPostedAt, todayIso } from "../lib/format";
import { useMe } from "../context/MeContext";
import { Avatar } from "../components/Avatar";
import { Link } from "../components/nav";
import { useNavStack } from "../components/NavStack";
import { useGroupLive } from "../components/useGroupLive";
import { Button, ConfirmDialog, ErrorNotice, Spinner, useNow } from "../components/ui";
import {
  CLOCK_ICON,
  ChatComposer,
  EventBadges,
  EventDateTile,
  EventEditForm,
  EventMeta,
  EventShareButtons,
  JoinBar,
  MembersOnly,
  MentionText,
  PEOPLE_ICON,
  PIN_ICON,
  ReplyList,
  ReportModal,
  RsvpControl,
  type FeedState,
  RsvpListModal,
  groupTabPath,
  joinState,
  mapsSearchUrl,
  rsvpSummary,
  useEventRsvp,
  useEventShare,
  useGroupPageActions,
  useThreadReplies,
} from "./GroupDetail";

/**
 * One event, on a page of its own -- where the share link sends a signed-in
 * reader, where tapping an event card's header goes, and where "Reply" on an
 * event leads, since an event's discussion lives here rather than in a chat
 * thread.
 *
 * Built to be the event's authoritative page rather than a chat bubble with
 * extra fields: the date large, RSVP as the main action, the share tools and
 * the organizer's controls in plain sight, and the conversation below.
 *
 * Every piece of logic is the group page's own, imported rather than
 * rewritten -- the RSVP mutation, the share actions, the roster, the reply
 * list and composer -- so an event behaves the same wherever it is reached.
 * Access is the group's too: this asks GET /groups/:id/posts/:postId, which
 * enforces groupAccess(), and renders the group page's own wording for a
 * group that cannot be found or content that is members-only.
 */
export function EventDetail() {
  const { id, postId: postIdParam } = useParams<{ id: string; postId: string }>();
  const groupId = id!;
  const postId = postIdParam!;
  const { organizationId } = useMe();
  const location = useLocation();
  const now = useNow();
  const { refresh, joinActions, actionError } = useGroupPageActions(groupId);

  const groupQuery = useQuery({
    queryKey: qk.group(organizationId, groupId),
    queryFn: ({ signal }) => api<GroupDto>(`/groups/${groupId}`, { signal }),
    refetchOnWindowFocus: true,
  });
  const group = groupQuery.data;
  const canSeeContent = Boolean(
    group && (group.visibility === "PUBLIC" || group.myRole !== null || group.viewingAsAdmin)
  );

  const postQuery = useQuery({
    queryKey: qk.groupPost(organizationId, groupId, postId),
    queryFn: ({ signal }) => api<GroupPostDto>(`/groups/${groupId}/posts/${postId}`, { signal }),
    enabled: canSeeContent,
    refetchOnWindowFocus: true,
  });
  const post = postQuery.data;

  // Live, like the group page: a new reply or RSVP arrives on its own.
  useGroupLive(groupId, { enabled: canSeeContent });

  if (groupQuery.isPending) return <Spinner label="Loading the event" />;
  if (groupQuery.error || !group) {
    return (
      <ErrorNotice
        message={
          groupQuery.error instanceof ApiError && groupQuery.error.status === 404
            ? "That group was not found."
            : (groupQuery.error?.message ?? "Could not load that group")
        }
        onRetry={() => void groupQuery.refetch()}
      />
    );
  }

  const header = <EventPageHeader group={group} groupId={groupId} />;

  if (!canSeeContent || (postQuery.error instanceof ApiError && postQuery.error.status === 403)) {
    return (
      <>
        {header}
        <MembersOnly group={group} joinActions={joinActions} what="this event" />
      </>
    );
  }
  if (postQuery.isPending) return <Spinner label="Loading the event" />;
  if (postQuery.error || !post) {
    return (
      <>
        {header}
        <ErrorNotice
          message={
            postQuery.error instanceof ApiError && postQuery.error.status === 404
              ? "That event was not found."
              : (postQuery.error?.message ?? "Could not load that event")
          }
          onRetry={() => void postQuery.refetch()}
        />
      </>
    );
  }
  // A message, or a reply, is not an event: send it where it belongs.
  if (post.kind !== "EVENT" || !post.event) {
    return (
      <Navigate
        to={`/groups/${groupId}/threads/${post.parentPostId ?? post.id}`}
        replace
        state={location.state}
      />
    );
  }

  return (
    <>
      {header}
      {actionError && (
        <div className="mb-4">
          <ErrorNotice message={actionError} />
        </div>
      )}
      <EventPage
        group={group}
        groupId={groupId}
        post={post}
        event={post.event}
        now={now}
        joinActions={joinActions}
        focusComposer={Boolean(
          (location.state as { focusComposer?: boolean } | null)?.focusComposer
        )}
        onChanged={refresh}
      />
    </>
  );
}

/** "Event" over the group's name, which leads back to the tab the event was opened from. */
function EventPageHeader({ group, groupId }: { group: GroupDto; groupId: string }) {
  const { canGoBack, goBack } = useNavStack();
  const state = useLocation().state as FeedState | null;
  return (
    <header className="mb-4">
      <p className="text-xs font-bold uppercase tracking-[0.2em] text-ink-muted">Event</p>
      <Link
        // Opened with no tab behind it (a share link, a reload), the Events tab.
        to={groupTabPath(groupId, state?.fromTab ?? "events")}
        viewTransition
        // As a thread's way out: reached from a tab, leaving is a back rather than
        // a second push; opened directly there is nothing to pop, so it replaces.
        replace
        onClick={(event) => {
          if (canGoBack && state?.fromFeed) {
            event.preventDefault();
            goBack();
          }
        }}
        className="-ml-1 mt-0.5 inline-flex max-w-full items-center gap-0.5 rounded-md px-1 font-bold text-accent underline-offset-2 hover:underline focus-visible:underline"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0 fill-current">
          <path d="M12.7 4.3a1 1 0 0 1 0 1.4L8.4 10l4.3 4.3a1 1 0 0 1-1.4 1.4l-5-5a1 1 0 0 1 0-1.4l5-5a1 1 0 0 1 1.4 0Z" />
        </svg>
        <span className="truncate">{group.title}</span>
      </Link>
    </header>
  );
}

function EventPage({
  group,
  groupId,
  post,
  event,
  now,
  joinActions,
  focusComposer,
  onChanged,
}: {
  group: GroupDto;
  groupId: string;
  post: GroupPostDto;
  event: NonNullable<GroupPostDto["event"]>;
  now: Date;
  joinActions: ReturnType<typeof useGroupPageActions>["joinActions"];
  focusComposer: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const cancelled = post.deletedAt !== null;
  const past = event.eventDate < todayIso();
  const times = formatEventTimes(event.startTime, event.endTime);

  const [editingEvent, setEditingEvent] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [reporting, setReporting] = useState<GroupPostDto | null>(null);
  const [editingReply, setEditingReply] = useState<GroupPostDto | null>(null);

  const share = useEventShare(event, cancelled);

  const cancel = useMutation({
    mutationFn: () => api(`/groups/${groupId}/posts/${post.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setConfirmCancel(false);
      await onChanged();
    },
  });
  const restore = useMutation({
    mutationFn: () => api(`/groups/${groupId}/posts/${post.id}/restore`, { method: "POST" }),
    onSuccess: () => onChanged(),
  });

  const { repliesQuery, replies, items } = useThreadReplies(groupId, post.id, now, true);
  const replyCount = replies?.length ?? post.replyCount;

  return (
    <div className="space-y-6 pb-8">
      {cancelled && (
        <div
          role="status"
          className="rounded-xl border border-primary/40 bg-primary/5 px-4 py-3 font-bold text-primary"
        >
          This event has been cancelled.
        </div>
      )}

      {/* The hero: the date as a calendar page, the title set large, then when and where. */}
      <article
        aria-labelledby="event-title"
        className={`overflow-hidden rounded-3xl border border-line bg-surface shadow-sm ${
          cancelled ? "opacity-80" : ""
        }`}
      >
        <div className="h-2 bg-gradient-to-r from-primary via-primary-light to-accent" />
        <div className="flex flex-col gap-6 p-6 sm:flex-row sm:items-start sm:p-8">
          <EventDateTile iso={event.eventDate} past={past || cancelled} size="xl" />
          <div className="min-w-0 flex-1 space-y-4">
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <EventBadges eventDate={event.eventDate} cancelled={cancelled} />
              </div>
              <h1
                id="event-title"
                className={`break-words text-3xl font-bold leading-tight tracking-tight sm:text-4xl ${
                  cancelled ? "text-ink-muted line-through" : "text-ink"
                }`}
              >
                {event.title}
              </h1>
            </div>
            <div className="space-y-2">
              <EventMeta icon={CLOCK_ICON} large>
                {formatDayLabel(event.eventDate)}
                {times && <span className="text-ink-muted"> · {times}</span>}
              </EventMeta>
              {event.location && (
                <EventMeta icon={PIN_ICON} large>
                  <a
                    href={mapsSearchUrl(event.location)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline-offset-2 hover:underline"
                  >
                    {event.location}
                  </a>
                </EventMeta>
              )}
            </div>
            {event.description && (
              <p className="max-w-prose whitespace-pre-line break-words border-l-4 border-accent-light pl-4 text-base leading-relaxed text-ink">
                <MentionText
                  text={event.description}
                  mentions={post.mentions}
                  mentionsEveryone={post.mentionsEveryone}
                />
              </p>
            )}
            <p className="text-sm text-ink-muted">
              Posted by{" "}
              <Link
                to={`/people/${post.authorPersonId}`}
                className="font-bold text-ink hover:text-accent hover:underline"
              >
                {post.authorName}
              </Link>{" "}
              · {formatPostedAt(post.createdAt, now)}
              {post.editedAt && " · edited"}
            </p>
          </div>
        </div>

        {editingEvent && (
          <div className="border-t border-line px-6 pb-6 sm:px-8">
            <EventEditForm
              post={post}
              event={event}
              groupId={groupId}
              members={group.members}
              onClose={() => setEditingEvent(false)}
              onSaved={onChanged}
            />
          </div>
        )}

        {/* The organizer's controls, in plain sight: this is the event's one authoritative page. */}
        {(post.canEdit || post.canDelete || post.canRestore || post.canReport) && !editingEvent && (
          <div className="flex flex-wrap gap-2 border-t border-line bg-surface-muted/60 px-6 py-3 sm:px-8">
            {post.canEdit && (
              <Button variant="secondary" onClick={() => setEditingEvent(true)}>
                Edit event
              </Button>
            )}
            {post.canDelete && (
              <Button variant="danger" onClick={() => setConfirmCancel(true)}>
                Cancel event
              </Button>
            )}
            {post.canRestore && (
              <Button
                variant="secondary"
                disabled={restore.isPending}
                onClick={() => restore.mutate()}
              >
                Re-activate event
              </Button>
            )}
            {post.canReport && (
              <Button variant="ghost" onClick={() => setReporting(post)}>
                Report
              </Button>
            )}
          </div>
        )}
      </article>

      {!cancelled && (
        <RsvpPanel groupId={groupId} postId={post.id} event={event} onChanged={onChanged} />
      )}

      {!cancelled && (
        <section
          aria-labelledby="event-share"
          className="rounded-2xl border border-line bg-surface p-6 shadow-sm"
        >
          <h2 id="event-share" className="text-lg font-bold text-ink">
            Share this event
          </h2>
          <p className="mb-4 mt-1 text-sm text-ink-muted">
            {event.publicRsvpEnabled
              ? "Anyone with the link can see this event and RSVP without an account."
              : "The link opens this page for members of the directory. Anybody else is asked to sign in."}
          </p>
          <EventShareButtons share={share} size="lg" />
        </section>
      )}

      <section aria-labelledby="event-discussion" className="space-y-3">
        <h2
          id="event-discussion"
          className="flex items-center gap-3 text-xs font-bold uppercase tracking-wide text-ink-muted"
        >
          <span className="h-px flex-1 bg-line" />
          {replyCount === 0
            ? "Discussion"
            : `Discussion · ${replyCount} ${replyCount === 1 ? "reply" : "replies"}`}
          <span className="h-px flex-1 bg-line" />
        </h2>

        {repliesQuery.isPending ? (
          <Spinner label="Loading replies" />
        ) : repliesQuery.error ? (
          <ErrorNotice
            message={repliesQuery.error.message}
            onRetry={() => void repliesQuery.refetch()}
          />
        ) : (
          <>
            {replyCount === 0 && (
              <p className="px-2 text-center text-sm text-ink-muted">
                {group.canReply
                  ? "Ask a question or say you are coming."
                  : "Nobody has replied yet."}
              </p>
            )}
            <ReplyList
              items={items}
              group={group}
              groupId={groupId}
              now={now}
              onReport={setReporting}
              onChanged={onChanged}
              onEdit={setEditingReply}
              editingId={editingReply?.id ?? null}
            />
          </>
        )}

        <div className="border-t border-line pt-3">
          {group.canReply || editingReply ? (
            <>
              <JoinBar compact group={group} actions={joinActions} />
              <ChatComposer
                groupId={groupId}
                members={group.members}
                parentPostId={post.id}
                placeholder="Reply…"
                autoFocus={focusComposer}
                editing={editingReply}
                onEditDone={() => setEditingReply(null)}
                onPosted={onChanged}
              />
            </>
          ) : joinState(group) ? (
            <JoinBar group={group} actions={joinActions} />
          ) : (
            <p className="text-sm text-ink-muted">You cannot reply in this group.</p>
          )}
        </div>
      </section>

      {confirmCancel && (
        <ConfirmDialog
          title="Cancel this event?"
          confirmLabel="Cancel it"
          busy={cancel.isPending}
          onConfirm={() => cancel.mutate()}
          onClose={() => setConfirmCancel(false)}
        >
          <p>
            Its details stay, marked cancelled, so people can see what was called off. Its share
            page says so too.
          </p>
        </ConfirmDialog>
      )}

      {reporting && (
        <ReportModal
          post={reporting}
          groupId={groupId}
          onClose={() => setReporting(null)}
          onReported={async () => {
            setReporting(null);
            await onChanged();
          }}
        />
      )}
    </div>
  );
}

/**
 * RSVP as the page's main action, and who is coming: a few faces and the
 * headcount, opening the full roster.
 */
function RsvpPanel({
  groupId,
  postId,
  event,
  onChanged,
}: {
  groupId: string;
  postId: string;
  event: NonNullable<GroupPostDto["event"]>;
  onChanged: () => Promise<unknown>;
}) {
  const { organizationId } = useMe();
  const rsvp = useEventRsvp(groupId, postId, onChanged);
  const [showRoster, setShowRoster] = useState(false);
  // The same key RsvpListModal reads, so opening it is instant.
  const rosterQuery = useQuery({
    queryKey: qk.groupPostRsvps(organizationId, groupId, postId),
    queryFn: ({ signal }) =>
      api<{
        rsvps: GroupEventRsvpDto[];
        publicRsvps: PublicEventRsvpDto[];
        canManagePublicRsvps: boolean;
      }>(`/groups/${groupId}/posts/${postId}/rsvps`, { signal }),
  });
  const going = (rosterQuery.data?.rsvps ?? []).filter((r) => r.response === "YES");
  const faces = going.slice(0, 5);

  return (
    <section
      aria-labelledby="event-rsvp"
      className="rounded-2xl border border-accent/40 bg-gradient-to-br from-accent-light/25 to-surface p-6 shadow-sm"
    >
      <h2 id="event-rsvp" className="text-lg font-bold text-ink">
        {event.myRsvp ? "Your RSVP" : "Are you going?"}
      </h2>
      <div className="mt-4">
        <RsvpControl event={event} postId={postId} rsvp={rsvp} large />
      </div>
      <button
        type="button"
        onClick={() => setShowRoster(true)}
        className="mt-5 flex items-center gap-3 rounded-lg text-left font-bold text-accent hover:underline"
      >
        {faces.length > 0 ? (
          <span aria-hidden="true" className="flex -space-x-2">
            {faces.map((face) => (
              <span key={face.appUserId} className="rounded-full ring-2 ring-surface">
                <Avatar
                  thumbUrl={face.thumbUrl}
                  person={{ firstName: face.name, lastName: null }}
                  size="sm"
                />
              </span>
            ))}
          </span>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 fill-current">
            {PEOPLE_ICON}
          </svg>
        )}
        <span>{rsvpSummary(event.rsvpCounts)}</span>
      </button>
      {showRoster && (
        <RsvpListModal groupId={groupId} postId={postId} onClose={() => setShowRoster(false)} />
      )}
    </section>
  );
}
