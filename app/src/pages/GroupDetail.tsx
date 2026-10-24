import {
  lazy,
  Suspense,
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
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GROUP_DESCRIPTION_MAX,
  GROUP_EVENT_LOCATION_MAX,
  GROUP_EVENT_TITLE_MAX,
  GROUP_MENTION_EVERYONE,
  GROUP_NOTIFICATION_PREFS,
  GROUP_NOTIFICATION_PREF_LABELS,
  GROUP_POST_BODY_MAX,
  GROUP_POST_MAX_ATTACHMENTS,
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
import {
  formatChatDay,
  formatChatTime,
  formatDayLabel,
  formatEventTimes,
  formatPostedAt,
  formatRelativeDay,
  localDayIso,
  parseIsoDate,
  todayIso,
} from "../lib/format";
import { useMe } from "../context/MeContext";
import { Avatar } from "../components/Avatar";
import { LocationAutocomplete } from "../components/AddressAutocomplete";
import { Link } from "../components/nav";
import { useNavStack } from "../components/NavStack";
import { TYPING_SIGNAL_INTERVAL_MS, typingLabel, useGroupLive } from "../components/useGroupLive";
import { useFillViewport } from "../components/useFillViewport";
import { useInfiniteScroll } from "../components/useInfiniteScroll";
import { PhotoLightbox } from "../components/PhotoLightbox";
import { PersonPicker, type PickedPerson } from "../components/PersonPicker";
import { usePhotoPicker } from "../components/usePhotoPicker";
import { useGroupAttachmentPicker } from "../components/useGroupAttachmentPicker";
import {
  AddReactionButton,
  QuickReactions,
  ReactionBar,
  ReactionsSheet,
  useGroupReactionToggle,
} from "../components/Reactions";
import { isEmojiOnly } from "../lib/emoji";
import { parseBody, toPlainText, type Inline, type ListBlock } from "../lib/richText";
import type { Editor } from "@tiptap/react";
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
  Select,
  Spinner,
  inputClass,
  useNow,
  usePageScrollLock,
} from "../components/ui";

// The message bar's editor and its Aa row: one lazily loaded chunk, so Tiptap
// stays out of the main bundle (see RichComposerEditor.tsx).
const RichComposerEditor = lazy(() => import("../components/RichComposerEditor"));
const FormatButtons = lazy(() =>
  import("../components/RichComposerEditor").then((m) => ({ default: m.FormatButtons }))
);

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
  const { id, postId } = useParams<{ id: string; postId?: string }>();
  const groupId = id!;
  const { me, isAdmin, organizationId } = useMe();
  const queryClient = useQueryClient();
  const location = useLocation();
  const { canGoBack, goBack } = useNavStack();

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
      // The list shows membership, member counts and archived groups too, so
      // anything done here can change a row there -- not only a delete.
      queryClient.invalidateQueries({ queryKey: qk.groups(organizationId), exact: true }),
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

  const joinActions: JoinActions = {
    join: () => joinMutation.mutate(),
    joining: joinMutation.isPending,
    requestToJoin: () => requestToJoinMutation.mutate(),
    requesting: requestToJoinMutation.isPending,
  };

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

  /*
   * Live while the page is open: other people's posts arrive on their own and
   * the Messages tab learns who is typing. Marking read here is what keeps the
   * unread badge from climbing under a member who is looking at the group; it
   * refreshes only the groups list, not this page, which would just refetch
   * everything the poll already refreshed.
   */
  const { typing } = useGroupLive(groupId, {
    enabled: Boolean(
      group && (group.visibility === "PUBLIC" || group.myRole !== null || group.viewingAsAdmin)
    ),
    markRead: group?.myRole
      ? () =>
          void api(`/groups/${groupId}/read`, { method: "POST" }).then(() =>
            queryClient.invalidateQueries({ queryKey: qk.groups(organizationId), exact: true })
          )
      : undefined,
  });

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

  return (
    <>
      <header className="mb-2">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-bold text-ink md:text-3xl">
              {postId ? "Thread" : group.title}
            </h1>
            <div className="mt-0.5 flex min-w-0 text-ink-muted">
              {postId ? (
                // The way out of the thread, so it reads as one: a back chevron
                // and the group's name in the accent colour.
                <Link
                  to={`/groups/${groupId}`}
                  viewTransition
                  // Reached from the feed: leaving is a back, not a second push, so
                  // the next Back goes to where you were before the group rather
                  // than bouncing through every feed-to-thread switch. Opened
                  // directly (a link, a reload with no feed behind it) there is
                  // nothing to pop, so it replaces the thread instead.
                  replace
                  onClick={(event) => {
                    if (canGoBack && (location.state as { fromFeed?: boolean } | null)?.fromFeed) {
                      event.preventDefault();
                      goBack();
                    }
                  }}
                  className="-ml-1 inline-flex min-w-0 items-center gap-0.5 rounded-md px-1 font-bold text-accent underline-offset-2 hover:underline focus-visible:underline"
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 20 20"
                    className="h-4 w-4 shrink-0 fill-current"
                  >
                    <path d="M12.7 4.3a1 1 0 0 1 0 1.4L8.4 10l4.3 4.3a1 1 0 0 1-1.4 1.4l-5-5a1 1 0 0 1 0-1.4l5-5a1 1 0 0 1 1.4 0Z" />
                  </svg>
                  <span className="truncate">{group.title}</span>
                </Link>
              ) : (
                // Styled as a link, because it is the way into group settings
                // (members, notifications, leaving) and plain muted text hid that.
                <button
                  type="button"
                  onClick={() => setShowMembers(true)}
                  className="inline-flex items-center gap-0.5 whitespace-nowrap font-bold text-accent underline-offset-2 hover:underline focus-visible:underline"
                >
                  {group.memberCount} {group.memberCount === 1 ? "member" : "members"} ·{" "}
                  {groupVisibilityLabel(group.visibility)}
                  <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">
                    <path d="M7.3 4.3a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4-1.4L11.6 10 7.3 5.7a1 1 0 0 1 0-1.4Z" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* Three small icons at the right of the title row, not a row of text
              tabs: the title line is then the only chrome above the conversation. */}
          {!postId && <SectionIcons tab={tab} onChange={setTab} />}
        </div>
      </header>

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
          You are viewing this group as a parish administrator. You are not a member.
        </div>
      )}

      {group.pendingJoinRequests.length > 0 && (
        <JoinRequestsBanner
          groupId={groupId}
          requests={group.pendingJoinRequests}
          onDecided={refresh}
        />
      )}

      {postId && (
        <ThreadView
          group={group}
          groupId={groupId}
          postId={postId}
          now={now}
          joinActions={joinActions}
          onReport={setReporting}
          onChanged={refresh}
        />
      )}
      {!postId && tab === "messages" && (
        <MessagesTab
          group={group}
          groupId={groupId}
          now={now}
          typing={typing}
          joinActions={joinActions}
          onReport={setReporting}
          onChanged={refresh}
        />
      )}
      {!postId && tab === "files" && <FilesTab groupId={groupId} />}
      {!postId && tab === "events" && (
        <EventsTab
          groupId={groupId}
          members={group.members}
          canReact={group.canReact}
          now={now}
          onReport={setReporting}
          onChanged={refresh}
        />
      )}
      {/* The feed and a thread put this where their message bar would be. */}
      {!postId && tab !== "messages" && joinState(group) && (
        <div className="mt-4">
          <JoinBar group={group} actions={joinActions} />
        </div>
      )}

      {showMembers && (
        <MembersModal
          group={group}
          groupId={groupId}
          isAdmin={isAdmin}
          onClose={() => setShowMembers(false)}
          onChanged={refresh}
          onLeave={() => {
            setShowMembers(false);
            setConfirmLeave(true);
          }}
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

const SECTIONS: { tab: Tab; label: string; icon: ReactNode }[] = [
  {
    tab: "messages",
    label: "Messages",
    icon: (
      <path d="M4 3h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-5.2l-3.6 3.2A.8.8 0 0 1 5.8 16.6V14H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
    ),
  },
  {
    tab: "files",
    label: "Files",
    // A paperclip: files here are attachments to messages.
    icon: (
      <path d="M13.6 3.3a3.4 3.4 0 0 1 4.8 4.8l-7.4 7.4a2.2 2.2 0 0 1-3.1-3.1l6.4-6.4a.8.8 0 1 1 1.1 1.1l-6.4 6.4a.6.6 0 0 0 .9.9l7.4-7.4a1.8 1.8 0 1 0-2.6-2.6L6.4 11.8a3.8 3.8 0 0 0 5.4 5.4l.9-.9a.8.8 0 1 1 1.1 1.1l-.9.9a5.4 5.4 0 0 1-7.6-7.6l7.3-7.4Z" />
    ),
  },
  {
    tab: "events",
    label: "Events",
    icon: (
      <path d="M6 1.8a.8.8 0 0 1 .8.8V4h6.4V2.6a.8.8 0 0 1 1.6 0V4H16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1.2V2.6a.8.8 0 0 1 .8-.8ZM3.6 8v7a.4.4 0 0 0 .4.4h12a.4.4 0 0 0 .4-.4V8H3.6Z" />
    ),
  },
];

/**
 * Messages, Files and Events as three small icons beside the group's title.
 * Icon-only to save the row that text tabs took; each keeps its name for
 * screen readers (`aria-label`) and for a mouse (`title`), and the current one
 * is marked with `aria-current` and a tinted background.
 */
function SectionIcons({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) {
  return (
    <nav aria-label="Group sections" className="flex shrink-0 items-center gap-0.5">
      {SECTIONS.map((section) => {
        const current = tab === section.tab;
        return (
          <button
            key={section.tab}
            type="button"
            aria-label={section.label}
            title={section.label}
            aria-current={current ? "page" : undefined}
            onClick={() => onChange(section.tab)}
            className={`tap-target inline-flex items-center justify-center rounded-lg transition ${
              current
                ? "bg-accent-light/40 text-primary"
                : "text-ink-muted hover:bg-surface-muted hover:text-ink"
            }`}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 fill-current">
              {section.icon}
            </svg>
          </button>
        );
      })}
    </nav>
  );
}

/** Join and Ask to join, run by the page and handed to wherever the bar shows. */
interface JoinActions {
  join: () => void;
  joining: boolean;
  requestToJoin: () => void;
  requesting: boolean;
}

/**
 * What someone outside the group can do about it: join a public group, ask to
 * join a private one, or wait on a request already sent. Null for a member,
 * and for anyone with no way in (an archived private group, a sign-in with no
 * person record).
 */
function joinState(group: GroupDto): "join" | "request" | "pending" | null {
  if (group.myRole) return null;
  if (group.pendingJoinRequestId) return "pending";
  if (group.visibility === "PUBLIC") return "join";
  if (group.canRequestToJoin) return "request";
  return null;
}

/** The button for a join state, or null when there is nothing to press. */
function joinAction(
  state: "join" | "request" | "pending",
  actions: JoinActions
): { label: string; busy: boolean; run: () => void } | null {
  if (state === "join") {
    return {
      label: actions.joining ? "Joining…" : "Join",
      busy: actions.joining,
      run: actions.join,
    };
  }
  if (state === "request") {
    return {
      label: actions.requesting ? "Sending…" : "Ask to join",
      busy: actions.requesting,
      run: actions.requestToJoin,
    };
  }
  return null;
}

/**
 * The way into a group for someone not in it, docked where the message bar
 * would be. A non-member cannot post, so that is otherwise empty space, and it
 * is where anyone looks to take part -- which keeps the header the same for
 * members and everyone else.
 *
 * `compact` is a single line above the message bar, for a parish admin who can
 * post without being a member and so gets the bar as well.
 */
function JoinBar({
  group,
  actions,
  compact = false,
}: {
  group: GroupDto;
  actions: JoinActions;
  compact?: boolean;
}) {
  const state = joinState(group);
  if (!state) return null;

  const action = joinAction(state, actions);

  if (compact) {
    return (
      <div className="mb-2 flex items-center justify-between gap-2 px-1 text-sm text-ink-muted">
        <span className="min-w-0 truncate">
          {state === "pending"
            ? "Your request to join is waiting for approval."
            : "You're not a member."}
        </span>
        {action && (
          <button
            type="button"
            disabled={action.busy}
            onClick={action.run}
            className="shrink-0 rounded-md px-1 font-bold text-accent underline-offset-2 hover:underline focus-visible:underline disabled:opacity-60"
          >
            {action.label}
          </button>
        )}
      </div>
    );
  }

  const message =
    state === "join"
      ? ["You're previewing this group.", "Join to post and get updates."]
      : state === "request"
        ? ["This group is private.", "An admin approves requests."]
        : ["Request sent.", "Waiting for an admin to approve it."];

  return (
    <div className="flex items-center gap-3 rounded-3xl border border-line bg-surface-muted py-2 pl-4 pr-2">
      <p className="min-w-0 flex-1 text-sm leading-snug">
        <span className="block font-bold text-ink">{message[0]}</span>
        <span className="block text-ink-muted">{message[1]}</span>
      </p>
      {action ? (
        <Button className="shrink-0" disabled={action.busy} onClick={action.run}>
          {action.label}
        </Button>
      ) : (
        <Badge tone="accent">Pending</Badge>
      )}
    </div>
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
    <div className="text-ink-muted">
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

/**
 * Where each group's feed was scrolled to when it was last left, so coming
 * Back from a thread lands on the message you were reading rather than at the
 * bottom. "bottom" means it was pinned there, so new messages keep it so.
 * Module-level on purpose: the feed unmounts while a thread is open.
 */
const feedScroll = new Map<string, number | "bottom">();

/**
 * No text selection and no callout on a touch screen, where a long press is how
 * the message actions open. Left to itself the OS reads that same press as "I
 * want to select this" and highlights words (and, on iOS, offers a callout for
 * a link or image). Applied to the whole scrolling pane as well as each row, so
 * a press in a gap or on a divider does not start a selection either; fields
 * keep it, because a textarea you cannot select in is a textarea you cannot use
 * -- and on iOS one with selection off will not even take typing.
 */
const TOUCH_NO_SELECT =
  "[@media(hover:none)]:select-none [@media(hover:none)]:[-webkit-touch-callout:none] [@media(hover:none)]:[&_textarea]:select-text [@media(hover:none)]:[&_input]:select-text";

/** How long a finger must stay down on a message before its drawer opens. */
const LONG_PRESS_MS = 450;

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
  typing,
  joinActions,
  onReport,
  onChanged,
}: {
  group: GroupDto;
  groupId: string;
  now: Date;
  /** Names of the other people typing right now. */
  typing: string[];
  joinActions: JoinActions;
  onReport: (post: GroupPostDto) => void;
  onChanged: () => Promise<unknown>;
}) {
  const { organizationId } = useMe();
  // The message being edited in the bar below, if any.
  const [editing, setEditing] = useState<GroupPostDto | null>(null);

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
  // The page does not scroll here -- the pane does, and the bar stays put.
  usePageScrollLock();
  const paneRef = useRef<HTMLDivElement>(null);
  const paneHeight = useFillViewport(paneRef, {
    gap: 12,
    min: 120,
    holdWhileTyping: true,
    clearHomeIndicator: true,
  });
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
  /** The saved position is applied once, on the first load -- never again after. */
  const restoredScroll = useRef(false);

  function trackBottom(): void {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    feedScroll.set(groupId, atBottom.current ? "bottom" : el.scrollTop);
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
    if (!restoredScroll.current) {
      restoredScroll.current = true;
      const saved = feedScroll.get(groupId);
      if (typeof saved === "number") {
        el.scrollTop = saved;
        atBottom.current = false;
        forceBottom.current = false;
        return;
      }
    }
    if (forceBottom.current || atBottom.current) {
      el.scrollTop = el.scrollHeight;
      forceBottom.current = false;
    }
  }, [posts, scrollEl, groupId]);

  /** An image finishing loading makes its row taller; stay pinned if that is where we were. */
  const onMediaLoad = useCallback(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, []);

  // The keyboard opening or closing resizes the pane; if the member was at the
  // newest message, keep them there rather than leaving it behind the bar.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [paneHeight]);

  const sentinelRef = useInfiniteScroll(loadOlder, {
    enabled: Boolean(postsQuery.hasNextPage) && !postsQuery.isFetchingNextPage,
    root: scrollEl,
    rootMargin: "200px",
  });

  if (!canSeeContent) {
    // A private group shows nothing to a non-member, so the way in goes in
    // this card rather than in a bar under it saying the same thing again.
    const state = joinState(group);
    const action = state && joinAction(state, joinActions);
    return (
      <EmptyState title="Members only">
        {state === "pending"
          ? "Your request to join is waiting for an admin to approve it."
          : state === "request"
            ? "Ask to join, and an admin of the group can let you in."
            : "Join this group to see its messages."}
        {action && (
          <div className="mt-4">
            <Button disabled={action.busy} onClick={action.run}>
              {action.label}
            </Button>
          </div>
        )}
      </EmptyState>
    );
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
            className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${TOUCH_NO_SELECT}`}
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
                    canReact={group.canReact}
                    onEdit={setEditing}
                    editingId={editing?.id ?? null}
                  />
                )
              )}
            </ol>
          </div>

          {/* Always rendered, at a fixed height, so a name appearing does not shove the bar. */}
          <p
            aria-live="polite"
            className="h-6 shrink-0 truncate px-1 pt-1 text-sm italic text-ink-muted"
          >
            {typingLabel(typing)}
          </p>
          <div className="shrink-0 border-t border-line pt-3">
            {group.canPost || editing ? (
              <>
                <JoinBar compact group={group} actions={joinActions} />
                <ChatComposer
                  groupId={groupId}
                  members={group.members}
                  placeholder={`Message ${group.title}`}
                  canStartEvent
                  editing={editing}
                  onEditDone={() => setEditing(null)}
                  onPosted={editing ? async () => void (await onChanged()) : posted}
                />
              </>
            ) : joinState(group) ? (
              <JoinBar group={group} actions={joinActions} />
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

/**
 * A message's thread, on a page of its own: the message at the top as a card,
 * its replies beneath, and the same message bar as the main page at the foot.
 *
 * Laid out like the feed -- the replies scroll inside a fixed-height pane and
 * the bar is docked under it -- so the two pages feel like one conversation at
 * two depths. A new reply arrives by the same live poll as everything else: the
 * message and its replies are keyed under `groupPosts`, which that poll
 * invalidates.
 */
function ThreadView({
  group,
  groupId,
  postId,
  now,
  joinActions,
  onReport,
  onChanged,
}: {
  group: GroupDto;
  groupId: string;
  postId: string;
  now: Date;
  joinActions: JoinActions;
  onReport: (post: GroupPostDto) => void;
  onChanged: () => Promise<unknown>;
}) {
  const { organizationId } = useMe();
  const location = useLocation();
  // Set by "Reply" in a message's menu; a plain tap on the reply count leaves it
  // off, so a phone's keyboard does not open unasked.
  const [editing, setEditing] = useState<GroupPostDto | null>(null);
  const focusComposer = Boolean(
    (location.state as { focusComposer?: boolean } | null)?.focusComposer
  );

  const rootQuery = useQuery({
    queryKey: qk.groupPost(organizationId, groupId, postId),
    queryFn: ({ signal }) => api<GroupPostDto>(`/groups/${groupId}/posts/${postId}`, { signal }),
    refetchOnWindowFocus: true,
  });
  const root = rootQuery.data;

  const repliesQuery = useQuery({
    queryKey: qk.groupReplies(organizationId, groupId, postId),
    queryFn: ({ signal }) =>
      api<{ replies: GroupPostDto[] }>(`/groups/${groupId}/posts/${postId}/replies`, { signal }),
    enabled: Boolean(root) && root?.parentPostId === null,
    refetchOnWindowFocus: true,
  });
  const replies = repliesQuery.data?.replies;
  const items = useMemo(() => buildChatItems(replies ?? [], now), [replies, now]);

  usePageScrollLock();
  const paneRef = useRef<HTMLDivElement>(null);
  const paneHeight = useFillViewport(paneRef, {
    gap: 12,
    min: 120,
    holdWhileTyping: true,
    clearHomeIndicator: true,
  });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  const forceBottom = useRef(true);

  function trackBottom(): void {
    const el = scrollRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  // Same rule as the feed: first load, the member's own reply, or already near
  // the bottom pins to the newest; anything else leaves the view alone.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !replies) return;
    if (forceBottom.current || atBottom.current) {
      el.scrollTop = el.scrollHeight;
      forceBottom.current = false;
    }
  }, [replies]);

  const onMediaLoad = useCallback(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [paneHeight]);

  if (rootQuery.isPending) return <Spinner label="Loading the thread" />;
  if (rootQuery.error || !root) {
    return (
      <div className="space-y-3">
        <ErrorNotice
          message={
            rootQuery.error instanceof ApiError && rootQuery.error.status === 404
              ? "That message was not found."
              : (rootQuery.error?.message ?? "Could not load that message")
          }
        />
        <Link to={`/groups/${groupId}`} className="font-bold text-accent hover:underline">
          Back to {group.title}
        </Link>
      </div>
    );
  }
  // A link to a reply leads to the thread it belongs to.
  if (root.parentPostId) {
    return <Navigate to={threadPath(groupId, root.parentPostId)} replace state={location.state} />;
  }

  const count = replies?.length ?? root.replyCount;

  return (
    <div
      ref={paneRef}
      className="flex h-[70vh] flex-col"
      style={paneHeight ? { height: paneHeight } : undefined}
    >
      <div
        ref={scrollRef}
        onScroll={trackBottom}
        role="log"
        aria-label="Thread"
        className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${TOUCH_NO_SELECT}`}
      >
        <ol>
          <ChatRow
            variant="root"
            post={root}
            showHeader
            groupId={groupId}
            members={group.members}
            now={now}
            onReport={onReport}
            onChanged={onChanged}
            onMediaLoad={onMediaLoad}
            canReact={group.canReact}
            onEdit={setEditing}
            editingId={editing?.id ?? null}
          />
        </ol>

        <div className="my-4 flex items-center gap-3 text-xs font-bold uppercase tracking-wide text-ink-muted">
          <span className="h-px flex-1 bg-line" />
          {count === 0 ? "No replies yet" : `${count} ${count === 1 ? "reply" : "replies"}`}
          <span className="h-px flex-1 bg-line" />
        </div>

        {repliesQuery.isPending ? (
          <Spinner label="Loading replies" />
        ) : repliesQuery.error ? (
          <ErrorNotice
            message={repliesQuery.error.message}
            onRetry={() => void repliesQuery.refetch()}
          />
        ) : (
          <>
            {count === 0 && (
              <p className="px-2 pb-3 text-center text-sm text-ink-muted">
                {group.canReply ? "Be the first to reply." : "Nobody has replied yet."}
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
                    canReact={group.canReact}
                    onEdit={setEditing}
                    editingId={editing?.id ?? null}
                    isReply
                  />
                )
              )}
            </ol>
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-line pt-3">
        {group.canReply || editing ? (
          <>
            <JoinBar compact group={group} actions={joinActions} />
            <ChatComposer
              groupId={groupId}
              members={group.members}
              parentPostId={postId}
              placeholder="Reply…"
              autoFocus={focusComposer}
              editing={editing}
              onEditDone={() => setEditing(null)}
              onPosted={async () => {
                if (!editing) forceBottom.current = true;
                await onChanged();
              }}
            />
          </>
        ) : joinState(group) ? (
          <JoinBar group={group} actions={joinActions} />
        ) : (
          <p className="text-sm text-ink-muted">You cannot reply in this group.</p>
        )}
      </div>
    </div>
  );
}

/** The avatar, linking to the person's page. The name beside it carries the accessible name. */
function AuthorAvatar({ post, size = "sm" }: { post: GroupPostDto; size?: "sm" | "md" }) {
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
        size={size}
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

/** Where a message's thread lives. */
function threadPath(groupId: string, postId: string): string {
  return `/groups/${groupId}/threads/${postId}`;
}

function ChatBubbleIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={`${className} fill-current`}>
      <path d="M4 3h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-5.2l-3.6 3.2A.8.8 0 0 1 5.8 16.6V14H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
    </svg>
  );
}

/**
 * Under a message that has replies: how many, and how long ago the last one
 * was, as a link into the thread. Styled as the tappable thing it is -- a
 * quiet accent pill that tints on hover -- rather than as plain text.
 */
function ReplySummary({ post, groupId, now }: { post: GroupPostDto; groupId: string; now: Date }) {
  return (
    <Link
      to={threadPath(groupId, post.id)}
      // Remembered so the thread's way out can pop this entry rather than push another.
      state={{ fromFeed: true }}
      className="-ml-2 mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm font-bold text-accent transition hover:bg-accent-light/30 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <ChatBubbleIcon />
      <span>
        {post.replyCount} {post.replyCount === 1 ? "reply" : "replies"}
      </span>
      {post.lastReplyAt && (
        <span className="truncate font-normal text-ink-muted">
          · last reply {formatPostedAt(post.lastReplyAt, now)}
        </span>
      )}
      <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0 fill-current">
        <path d="M7.3 4.3a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4-1.4L11.6 10 7.3 5.7a1 1 0 0 1 0-1.4Z" />
      </svg>
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
  canReact = false,
  isReply = false,
  variant = "row",
  onEdit,
  editingId = null,
}: {
  post: GroupPostDto;
  showHeader: boolean;
  /** Whether the caller may reply here; offers "Reply" in the actions menu. */
  canReply?: boolean;
  /** Whether the caller may add reactions here; offers the emoji toolbar, quick reactions and picker. */
  canReact?: boolean;
  /**
   * `root` is the message a thread page is about: a card, with no thread controls
   * of its own. `card` is an event on the Events tab: just the event's card, with
   * a quiet "posted by" line under it instead of an avatar gutter.
   */
  variant?: "row" | "root" | "card";
  /** Edit a message in the page's message bar. Without it a message edits inline. */
  onEdit?: (post: GroupPostDto) => void;
  /** The message currently being edited in the bar, which this row marks. */
  editingId?: string | null;
  groupId: string;
  members: GroupMemberDto[];
  now: Date;
  onReport: (post: GroupPostDto) => void;
  onChanged: () => Promise<unknown>;
  onMediaLoad?: () => void;
  isReply?: boolean;
}) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isRoot = variant === "root";
  const isCard = variant === "card";

  const remove = useMutation({
    mutationFn: () => api(`/groups/${groupId}/posts/${post.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setConfirmDelete(false);
      await onChanged();
    },
  });

  const restore = useMutation({
    mutationFn: () => api(`/groups/${groupId}/posts/${post.id}/restore`, { method: "POST" }),
    onSuccess: async () => {
      await onChanged();
    },
  });

  const isDeleted = post.deletedAt !== null;
  const reactionToggle = useGroupReactionToggle(groupId);
  const { react } = reactionToggle;
  /** The emoji picker opened from the hover toolbar, which keeps the toolbar and row lit. */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const canReactHere = canReact && !isDeleted && !editing;
  // Replying lives in the actions menu rather than inline, so a row stays just
  // the message, and it opens the thread page -- where the reply bar is. Not for
  // a reply (one level of threading), a deleted post, or the thread's own root
  // (the bar is right there).
  const showReplyAction = canReply && !isReply && !isDeleted && !isRoot;
  const header = showHeader || isRoot;

  /*
   * What a message offers, in one list, so the hover menu on a desktop and the
   * drawer on a phone cannot drift apart. "Copy text" is drawer-only: on a
   * phone text selection is switched off on a row (it fights the long press),
   * so this is how you get the text out.
   */
  const actions: { label: string; danger?: boolean; onSelect: () => void }[] = [];
  if (showReplyAction)
    actions.push({
      label: "Reply",
      onSelect: () =>
        void navigate(threadPath(groupId, post.id), {
          viewTransition: true,
          state: { focusComposer: true, fromFeed: true },
        }),
    });
  if (!isDeleted && post.canEdit)
    actions.push({
      label: "Edit",
      onSelect: () => (onEdit && post.kind === "MESSAGE" ? onEdit(post) : setEditing(true)),
    });
  if (!isDeleted && post.canDelete)
    actions.push({ label: "Delete", danger: true, onSelect: () => setConfirmDelete(true) });
  if (!isDeleted && post.canReport)
    actions.push({ label: "Report", onSelect: () => onReport(post) });
  // A cancelled event can be put back by the person who cancelled it.
  if (post.canRestore)
    actions.push({ label: "Re-activate event", onSelect: () => restore.mutate() });

  /*
   * Long press, for a touch screen: it opens a drawer with the actions, because
   * a button on every row covers the message it sits on. Only for a finger --
   * a mouse has the hover menu -- and only when there is something to offer.
   * Moving more than a few pixels is a scroll, not a press; the browser also
   * cancels the pointer once it takes over a scroll, which clears the timer.
   */
  const [sheetOpen, setSheetOpen] = useState(false);
  /** A finger is down and the drawer is about to open -- the row shows it has noticed. */
  const [pressing, setPressing] = useState(false);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  /** The lift that ends a long press must not also click whatever is under the finger. */
  const swallowClick = useRef(false);
  const sheetAvailable =
    (!isDeleted || post.canRestore) &&
    !editing &&
    (actions.length > 0 || Boolean(post.body) || canReactHere);

  function cancelPress(): void {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
    setPressing(false);
  }
  function startPress(event: React.PointerEvent): void {
    if (event.pointerType !== "touch" || !sheetAvailable) return;
    cancelPress();
    setPressing(true);
    press.current = {
      x: event.clientX,
      y: event.clientY,
      timer: window.setTimeout(() => {
        press.current = null;
        setPressing(false);
        // Most browsers fire no click after a long press, so the flag must not
        // outlive the lift or it would eat the first tap in the drawer.
        swallowClick.current = true;
        window.setTimeout(() => {
          swallowClick.current = false;
        }, 400);
        navigator.vibrate?.(10);
        // The OS may have begun a selection during the hold; drop it.
        window.getSelection()?.removeAllRanges();
        setSheetOpen(true);
        // The OS can begin the selection a beat after the hold, once the sheet is
        // already up; clear again on the next frames.
        for (const delay of [50, 250]) {
          window.setTimeout(() => window.getSelection()?.removeAllRanges(), delay);
        }
      }, LONG_PRESS_MS),
    };
  }
  function movePress(event: React.PointerEvent): void {
    const start = press.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancelPress();
  }
  useEffect(() => cancelPress, []);

  return (
    <li
      onPointerDown={startPress}
      onPointerMove={movePress}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
      onClickCapture={(event) => {
        // The drawer is portalled but React still bubbles its clicks through
        // this row; only a click that really landed on the row is swallowed.
        if (!swallowClick.current || !event.currentTarget.contains(event.target as Node)) return;
        swallowClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      // Android raises its own context menu on a long press; ours replaces it.
      onContextMenu={(event) => {
        if (sheetAvailable && window.matchMedia?.("(hover: none)").matches) event.preventDefault();
      }}
      className={`group/row relative flex gap-3 ${
        isCard
          ? "rounded-2xl"
          : isRoot
            ? // The message a thread is about: a card, so it reads as the anchor
              // the replies hang from rather than as one more line. A real border,
              // not a ring: a ring is a shadow drawn outside the box, and the
              // scrolling pane around it clips anything outside its own edge.
              "gap-4 rounded-xl border border-line p-4"
            : // A byline starts a new run and gets some air above it; a continuation
              // sits close under the line before it, as in a chat.
              `rounded-md px-2 ${header ? "pb-0.5 pt-2" : "py-px"}`
      } ${
        // The message the drawer is about stays marked while it is open, and
        // starts to show during the hold, so a long press is never a guess.
        sheetOpen || pressing || editingId === post.id
          ? isCard
            ? "ring-2 ring-accent/60"
            : "bg-accent-light/30 ring-1 ring-inset ring-accent/50"
          : isCard
            ? ""
            : isRoot
              ? "bg-surface-muted/60"
              : `focus-within:bg-surface-muted/60 hover:bg-surface-muted/60 ${
                  pickerOpen ? "bg-surface-muted/60" : ""
                }`
      } ${TOUCH_NO_SELECT}`}
    >
      {/* The same-width gutter on every row keeps a run of messages lined up under its byline. */}
      {!isCard && (
        <div className={`shrink-0 ${isRoot ? "w-14" : "w-10"}`}>
          {header ? (
            <AuthorAvatar post={post} size={isRoot ? "md" : "sm"} />
          ) : (
            <time
              dateTime={post.createdAt}
              title={formatPostedAt(post.createdAt, now)}
              className="block whitespace-nowrap pt-0.5 text-center text-[10px] leading-tight text-ink-muted opacity-0 group-hover/row:opacity-100"
            >
              {formatChatTime(post.createdAt)}
            </time>
          )}
        </div>
      )}

      <div className="min-w-0 flex-1">
        {header && !isCard && (
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

        {isDeleted && post.kind === "EVENT" && post.event ? (
          // What was cancelled stays visible; only the RSVP side goes.
          <EventBlock
            event={post.event}
            mentions={post.mentions}
            mentionsEveryone={post.mentionsEveryone}
            postId={post.id}
            groupId={groupId}
            onChanged={onChanged}
            wide={isCard}
            cancelled
          />
        ) : isDeleted ? (
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
                mentionsEveryone={post.mentionsEveryone}
                postId={post.id}
                groupId={groupId}
                onChanged={onChanged}
                wide={isCard}
              />
            )}
            {post.body && (
              <div
                className={`whitespace-pre-line break-words text-ink ${
                  // A message of nothing but emoji is shown large, as in Slack.
                  isEmojiOnly(toPlainText(post.body)) ? "text-3xl leading-tight" : "leading-snug"
                }`}
              >
                <RichText
                  text={post.body}
                  mentions={post.mentions}
                  mentionsEveryone={post.mentionsEveryone}
                />
                {!header && post.editedAt && (
                  <span className="text-xs text-ink-muted"> (edited)</span>
                )}
              </div>
            )}
            <AttachmentStrip attachments={post.attachments} onMediaLoad={onMediaLoad} />
            <ReactionBar
              post={post}
              toggle={reactionToggle}
              canReact={canReact}
              onShowReactions={() => setReactionsOpen(true)}
            />
          </>
        )}

        {/*
          A deleted post keeps its reply thread reachable -- "a placeholder
          stays in its place so any replies keep their context"
          (requirements/groups.md) means the thread, not just the tombstone
          text -- so the summary shows whenever there are replies.
        */}
        {isCard && (
          <p className="mt-1.5 px-1 text-xs text-ink-muted">
            Posted by <AuthorName post={post} /> · {formatPostedAt(post.createdAt, now)}
            {post.editedAt && " · edited"}
          </p>
        )}

        {!isReply && !isRoot && !isCard && post.replyCount > 0 && (
          <ReplySummary post={post} groupId={groupId} now={now} />
        )}
      </div>

      {/*
        On a mouse: revealed on hover or focus, by opacity and not `hidden` -- a
        hidden control cannot take focus, so a keyboard user could never reach
        it. On a touch screen there is no hover and a button on every row would
        sit on top of the messages, so it is gone and a long press opens the
        drawer below instead.
      */}
      {(actions.length > 0 || canReactHere) && (
        <div
          className={`absolute -top-3 right-2 flex items-center rounded-md border border-line bg-surface shadow-sm transition focus-within:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:hidden ${
            pickerOpen ? "opacity-100" : "opacity-0"
          }`}
        >
          {canReactHere && (
            <>
              <QuickReactions
                post={post}
                count={3}
                onReact={(emoji) => react(post, emoji)}
                buttonClassName="flex size-8 items-center justify-center rounded-md text-base hover:bg-surface-muted aria-pressed:bg-accent-light/40"
              />
              <AddReactionButton
                onOpenChange={setPickerOpen}
                onPick={(emoji) => react(post, emoji)}
                className="flex size-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-muted hover:text-primary"
              />
            </>
          )}
          {actions.length > 0 && (
            <MenuButton portal label={`Actions for this post`}>
              {actions.map((action) => (
                <MenuItem key={action.label} danger={action.danger} onSelect={action.onSelect}>
                  {action.label}
                </MenuItem>
              ))}
            </MenuButton>
          )}
        </div>
      )}

      {reactionsOpen && (
        <ReactionsSheet post={post} members={members} onClose={() => setReactionsOpen(false)} />
      )}

      {sheetOpen && (
        <Modal noSelect title="Message" onClose={() => setSheetOpen(false)}>
          {/* Which message this is for: its author and the start of what it says. */}
          <p className="mb-2 line-clamp-2 break-words rounded-md border-l-4 border-accent bg-accent-light/30 px-3 py-2 text-sm text-ink">
            <span className="font-bold">{post.authorName}</span>
            {post.body ? `: ${toPlainText(post.body)}` : ""}
          </p>
          {canReactHere && (
            <div className="mb-2 flex items-center justify-between gap-1">
              <QuickReactions
                post={post}
                count={6}
                onReact={(emoji) => {
                  setSheetOpen(false);
                  react(post, emoji);
                }}
                buttonClassName="flex size-11 items-center justify-center rounded-full border border-line text-2xl aria-pressed:border-accent aria-pressed:bg-accent-light/40"
              />
              <AddReactionButton
                label="More reactions"
                onPick={(emoji) => {
                  setSheetOpen(false);
                  react(post, emoji);
                }}
                className="flex size-11 items-center justify-center rounded-full border border-line text-ink-muted"
              />
            </div>
          )}
          <ul className="-mx-2 -mb-2 divide-y divide-line">
            {post.reactions.length > 0 && (
              <li>
                <button
                  type="button"
                  className="tap-target block w-full px-2 py-3 text-left font-bold text-ink"
                  onClick={() => {
                    setSheetOpen(false);
                    setReactionsOpen(true);
                  }}
                >
                  View reactions
                </button>
              </li>
            )}
            {post.body && (
              <li>
                <button
                  type="button"
                  className="tap-target block w-full px-2 py-3 text-left font-bold text-ink"
                  onClick={() => {
                    void navigator.clipboard?.writeText(toPlainText(post.body ?? ""));
                    setSheetOpen(false);
                  }}
                >
                  Copy text
                </button>
              </li>
            )}
            {actions.map((action) => (
              <li key={action.label}>
                <button
                  type="button"
                  className={`tap-target block w-full px-2 py-3 text-left font-bold ${
                    action.danger ? "text-primary" : "text-ink"
                  }`}
                  onClick={() => {
                    setSheetOpen(false);
                    action.onSelect();
                  }}
                >
                  {action.label}
                </button>
              </li>
            ))}
          </ul>
        </Modal>
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
  const [zoomed, setZoomed] = useState<GroupPostDto["attachments"][number] | null>(null);
  if (attachments.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2">
      {zoomed?.fullUrl && (
        <PhotoLightbox src={zoomed.fullUrl} alt={zoomed.filename} onClose={() => setZoomed(null)} />
      )}
      {attachments.map((attachment) =>
        attachment.kind === "IMAGE" ? (
          <li key={attachment.id}>
            <button
              type="button"
              onClick={() => setZoomed(attachment)}
              disabled={!attachment.fullUrl}
              aria-label={`Show ${attachment.filename} full screen`}
              className="block rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <img
                src={attachment.thumbUrl ?? undefined}
                alt={attachment.filename}
                width={attachment.width ?? undefined}
                height={attachment.height ?? undefined}
                onLoad={onMediaLoad}
                className="h-24 w-24 rounded-md border border-line object-cover"
                loading="lazy"
              />
            </button>
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
function mentionsName(text: string, name: string): boolean {
  return new RegExp(`(^|\\s)@${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}_])`, "u").test(text);
}

function findMentionedAppUserIds(
  text: string,
  candidates: { appUserId: string; name: string }[]
): string[] {
  return candidates.filter((c) => mentionsName(text, c.name)).map((c) => c.appUserId);
}

/** Whether `text` still says "@everyone", by the same word-boundary rule. */
function hasEveryoneMention(text: string): boolean {
  return mentionsName(text, GROUP_MENTION_EVERYONE);
}

/**
 * Renders `text` with every @ mention in `mentions` picked out in color, each a
 * link to that person's page -- and "@everyone", when the post has it, in the
 * same color with nowhere to link to.
 */
function MentionText({
  text,
  mentions,
  mentionsEveryone = false,
}: {
  text: string;
  mentions: { appUserId: string; personId: string; name: string }[];
  mentionsEveryone?: boolean;
}) {
  if (mentions.length === 0 && !mentionsEveryone) return <>{text}</>;

  // Longest name first, so one mentioned name that happens to be a prefix of
  // another (e.g. two people sharing a first name) doesn't steal the match.
  const names = [...mentions].sort((a, b) => b.name.length - a.name.length);
  const alternatives = names.map((m) => escapeRegExp(m.name));
  if (mentionsEveryone) alternatives.push(GROUP_MENTION_EVERYONE);
  const pattern = new RegExp(`(^|\\s)(@(?:${alternatives.join("|")})(?=$|[^\\p{L}\\p{N}_]))`, "gu");

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
 * A message's body with its formatting (lib/richText.ts) -- bold, italics,
 * links, lists -- and, in its text, @ mentions picked out by `MentionText`.
 * Built from React elements, never HTML, so nothing typed can become markup.
 */
function RichText({
  text,
  mentions,
  mentionsEveryone,
}: {
  text: string;
  mentions: { appUserId: string; personId: string; name: string }[];
  mentionsEveryone?: boolean;
}) {
  const inline = (nodes: Inline[]): ReactNode[] =>
    nodes.map((node, k) => {
      if (node.kind === "text") {
        return (
          <MentionText
            key={k}
            text={node.text}
            mentions={mentions}
            mentionsEveryone={mentionsEveryone}
          />
        );
      }
      const children = inline(node.children);
      switch (node.kind) {
        case "bold":
          return <strong key={k}>{children}</strong>;
        case "italic":
          return <em key={k}>{children}</em>;
        case "underline":
          return <u key={k}>{children}</u>;
        case "strike":
          return <s key={k}>{children}</s>;
        default:
          // A link: the only kind left.
          return (
            <a
              key={k}
              href={node.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline"
            >
              {children}
            </a>
          );
      }
    });

  const lines = (rows: Inline[][]): ReactNode[] =>
    rows.flatMap((row, k) => [...(k > 0 ? [<br key={`br${k}`} />] : []), ...inline(row)]);

  const list = (block: ListBlock, key: number): ReactNode => {
    const items = block.items.map((item, k) => (
      <li key={k}>
        {lines(item.lines)}
        {item.children.map(list)}
      </li>
    ));
    return block.ordered ? (
      <ol key={key} start={block.start} className="list-decimal pl-6">
        {items}
      </ol>
    ) : (
      <ul key={key} className="list-disc pl-6">
        {items}
      </ul>
    );
  };

  // Lines run on with a break between; a list is its own block.
  const out: ReactNode[] = [];
  let lastWasLine = false;
  parseBody(text).forEach((block, k) => {
    if (block.kind === "list") {
      out.push(list(block, k));
      lastWasLine = false;
      return;
    }
    if (lastWasLine) out.push(<br key={`br${k}`} />);
    out.push(<span key={k}>{inline(block.content)}</span>);
    lastWasLine = true;
  });
  return <>{out}</>;
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

/** One row in the @ mention list: a member, or the whole group. */
type MentionOption = { kind: "everyone" } | { kind: "member"; member: GroupMemberDto };

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
 *
 * For an event's description, which stays plain text. The message bar has its
 * own editor with formatting (components/RichComposerEditor.tsx).
 */
function MentionTextarea({
  value,
  onChange,
  members,
  placeholder,
  minHeightClass = "min-h-24",
  maxLength,
}: {
  value: string;
  onChange: (value: string) => void;
  members: GroupMemberDto[];
  placeholder: string;
  minHeightClass?: string;
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

  // "@everyone" leads the list while what's typed could still become it, and
  // only when there is someone besides the writer for it to reach.
  const matches: MentionOption[] =
    query === null
      ? []
      : [
          ...(members.length > 0 && GROUP_MENTION_EVERYONE.startsWith(query.text.toLowerCase())
            ? [{ kind: "everyone" } as const]
            : []),
          ...members
            .filter((m) => m.name.toLowerCase().includes(query.text.toLowerCase()))
            .slice(0, 6)
            .map((member) => ({ kind: "member", member }) as const),
        ];

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

  function pick(option: MentionOption): void {
    if (!query) return;
    const before = value.slice(0, query.atIndex);
    const after = value.slice(query.atIndex + 1 + query.text.length);
    const inserted = `@${option.kind === "everyone" ? GROUP_MENTION_EVERYONE : option.member.name} `;
    onChange(`${before}${inserted}${after}`.slice(0, maxLength));
    setQuery(null);
    setCaret(null);
    setPendingCursor(before.length + inserted.length);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // The picker, when it is open, owns the arrows and Enter.
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
      // Closes the list only; not whatever surrounds this box (a reply, a dialog).
      event.stopPropagation();
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
          {matches.map((option, index) => (
            <li key={option.kind === "everyone" ? "@everyone" : option.member.appUserId}>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(option);
                }}
                className={`block w-full px-3 py-1.5 text-left text-sm ${
                  index === highlighted ? "bg-surface-muted text-primary" : "text-ink"
                }`}
              >
                {option.kind === "everyone" ? (
                  <>
                    @{GROUP_MENTION_EVERYONE}
                    <span className="block text-xs text-ink-muted">
                      Notify everyone in this group
                    </span>
                  </>
                ) : (
                  option.member.name
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Editing a post in place. Only an event is edited inline: a message is edited
 * in the message bar at the foot of the page (see `ChatComposer`'s `editing`),
 * the same box every message is written in.
 */
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
  if (post.kind !== "EVENT" || !post.event) return null;
  return (
    <EventEditForm
      post={post}
      event={post.event}
      groupId={groupId}
      members={members}
      onClose={onClose}
      onSaved={onSaved}
    />
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
          mentionsEveryone: hasEveryoneMention(description),
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

/** A check or an x in a circle, in the colour of whatever wraps it. */
function CircleIcon({ tone }: { tone: "check" | "x" }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-7 w-7">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
      {tone === "check" ? (
        <path
          d="m7.5 12.5 3 3 6-6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="m8.5 8.5 7 7m0-7-7 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 fill-current">
      <path d="M5.3 5.3a1 1 0 0 1 1.4 0L10 8.6l3.3-3.3a1 1 0 1 1 1.4 1.4L11.4 10l3.3 3.3a1 1 0 0 1-1.4 1.4L10 11.4l-3.3 3.3a1 1 0 0 1-1.4-1.4L8.6 10 5.3 6.7a1 1 0 0 1 0-1.4Z" />
    </svg>
  );
}

function SmileIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
      <circle cx="9" cy="10" r="0.6" fill="currentColor" />
      <circle cx="15" cy="10" r="0.6" fill="currentColor" />
    </svg>
  );
}

/** The one-line box shown for the moment the editor's chunk is loading. */
function ComposerEditorFallback({ placeholder }: { placeholder: string }) {
  return (
    <div className="min-w-0 flex-1 truncate px-1 py-2.5 text-ink-muted" aria-hidden="true">
      {placeholder}
    </div>
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
 * Slack's shape: at rest a one-line pill with a round `+`; once it has focus
 * or words, a card with the text on top and a toolbar under it (`+`, `Aa` for
 * the formatting row, emoji, send). The text is a rich editor whose formatting
 * is saved as the plain-text syntax in lib/richText.ts.
 *
 * On a desktop Enter sends and Shift+Enter makes a new line; on a phone Enter
 * is the keyboard's return, a new line, and the send button sends. The mention
 * picker, while open, keeps Enter for choosing a name.
 */
function ChatComposer({
  groupId,
  members,
  parentPostId,
  placeholder,
  canStartEvent = false,
  autoFocus = false,
  editing = null,
  onEditDone,
  onPosted,
}: {
  groupId: string;
  members: GroupMemberDto[];
  parentPostId?: string;
  placeholder: string;
  /** Offer "Event…" in the + menu. Never for a reply: a reply cannot be an event. */
  canStartEvent?: boolean;
  /** Focus the bar on arrival -- for a reply started from a message's menu. */
  autoFocus?: boolean;
  /**
   * A message being edited. The bar takes its text, shows "Editing message", and
   * swaps the send button for accept and cancel -- the same box for writing and
   * for editing, rather than a second input appearing inside the conversation.
   */
  editing?: GroupPostDto | null;
  /** Editing ended, by saving or cancelling. */
  onEditDone?: () => void;
  onPosted: () => Promise<unknown>;
}) {
  const [body, setBody] = useState("");
  const [eventOpen, setEventOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useGroupAttachmentPicker();
  const mentionable = useMentionable(members);
  // While editing: ids of the message's existing attachments taken off it so far.
  const [removedIds, setRemovedIds] = useState<string[]>([]);

  /*
   * "I am typing", at most once per interval and only from the main bar -- a
   * reply is a side conversation and would only make the indicator flicker. The
   * server forgets it after a few seconds, so there is no "stopped" to send; a
   * failure is not worth telling anyone about.
   */
  /*
   * Entering edit mode puts the message's text in the bar; whatever was half
   * typed there is set aside and comes back when editing ends, so starting an
   * edit does not cost anyone their draft.
   */
  const draft = useRef<string | null>(null);
  const editingId = editing?.id;
  useEffect(() => {
    // Attachment changes belong to one edit; neither starting nor ending one carries them over.
    setRemovedIds([]);
    picker.reset();
    if (editing) {
      draft.current ??= body;
      setBody(editing.body ?? "");
      setError(null);
    } else if (draft.current !== null) {
      setBody(draft.current);
      draft.current = null;
    }
    // Only when the message being edited changes, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  const [editor, setEditor] = useState<Editor | null>(null);
  /** Put an emoji from the picker into the text at the caret, replacing any selection. */
  function insertEmoji(emoji: string): void {
    editor?.chain().focus().insertContent({ type: "text", text: emoji }).run();
  }

  /*
   * Open (the card with its toolbar) while the box has focus, and until a press
   * lands somewhere else -- a press in the + menu or the emoji picker, which
   * are drawn outside the bar, does not count as leaving it.
   */
  const barRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(autoFocus);
  const [formatOpen, setFormatOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const isOutside = (target: EventTarget | null) =>
    target instanceof Element &&
    !barRef.current?.contains(target) &&
    !target.closest('[role="menu"], [role="dialog"]');
  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: PointerEvent) => {
      if (isOutside(event.target)) setActive(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [active]);
  const hasText = toPlainText(body).trim() !== "";

  const lastSignal = useRef(0);
  function onBodyChange(next: string): void {
    setBody(next);
    if (editing || parentPostId || toPlainText(next).trim() === "") return;
    const at = Date.now();
    if (at - lastSignal.current < TYPING_SIGNAL_INTERVAL_MS) return;
    lastSignal.current = at;
    void Promise.resolve(api(`/groups/${groupId}/typing`, { method: "POST" })).catch(() => {});
  }

  // What an edited message keeps of its own attachments, and so what it will have in all.
  const keptAttachments = (editing?.attachments ?? []).filter((a) => !removedIds.includes(a.id));
  const attachmentCount = keptAttachments.length + picker.attachments.length;
  const attachmentsFull = attachmentCount >= GROUP_POST_MAX_ATTACHMENTS;

  const unchanged =
    editing !== null &&
    body.trim() === (editing.body ?? "").trim() &&
    removedIds.length === 0 &&
    picker.attachments.length === 0;
  // Words, or at least one picture or file left on it.
  const editHasContent = hasText || attachmentCount > 0;
  const canSaveEdit = !busy && !picker.busy && editHasContent && !unchanged;

  async function saveEdit(): Promise<void> {
    if (!editing || !canSaveEdit) return;
    setBusy(true);
    setError(null);
    try {
      // Mentions are re-read from the text, so adding or deleting an @Name here
      // adds or removes the mention -- and only the newly added are notified.
      await api(`/groups/${groupId}/posts/${editing.id}`, {
        method: "PATCH",
        body: {
          body,
          mentionedAppUserIds: findMentionedAppUserIds(toPlainText(body), mentionable),
          mentionsEveryone: hasEveryoneMention(toPlainText(body)),
          removeAttachmentIds: removedIds,
          addAttachments: picker.attachments,
        },
      });
      picker.reset();
      onEditDone?.();
      await onPosted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that change");
    } finally {
      setBusy(false);
    }
  }

  // Words, or a picture or file with no words. Not while one is still uploading.
  const canSend = hasText || (picker.attachments.length > 0 && !picker.busy);

  async function submit(): Promise<void> {
    if (editing) return void saveEdit();
    if (busy || !canSend) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/groups/${groupId}/posts`, {
        method: "POST",
        body: {
          kind: "MESSAGE",
          body,
          parentPostId,
          mentionedAppUserIds: findMentionedAppUserIds(toPlainText(body), mentionable),
          mentionsEveryone: hasEveryoneMention(toPlainText(body)),
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

  const expanded =
    active || hasText || editing !== null || emojiOpen || attachmentCount > 0 || eventOpen;

  // An edit can add pictures and files, but a message cannot become an event.
  const plusMenu = (
    <MenuButton
      portal
      align="left"
      label="Add to this message"
      trigger={
        <span className="inline-flex size-9 items-center justify-center rounded-full bg-surface-muted text-ink">
          <PlusIcon />
        </span>
      }
      buttonClassName="tap-target inline-flex items-center justify-center rounded-full text-ink transition hover:text-primary"
      className="shrink-0"
    >
      <MenuItem
        onSelect={() => {
          if (!picker.busy && !attachmentsFull) picker.open();
        }}
      >
        Photo or file
      </MenuItem>
      {canStartEvent && !editing && <MenuItem onSelect={() => setEventOpen(true)}>Event…</MenuItem>}
    </MenuButton>
  );

  return (
    // Escape abandons an edit. The mention list stops its own Escape from
    // reaching here, so closing the list does not also cancel the edit.
    <div
      className="space-y-2"
      onKeyDown={(event) => {
        if (editing && event.key === "Escape") onEditDone?.();
      }}
    >
      {editing && (
        <p className="flex items-center gap-1.5 px-1 text-sm font-bold text-accent">
          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">
            <path d="M13.6 2.6a2 2 0 0 1 2.8 0l1 1a2 2 0 0 1 0 2.8L7.6 16.2a1 1 0 0 1-.5.3l-3.4.8a.8.8 0 0 1-1-1l.8-3.4a1 1 0 0 1 .3-.5l9.8-9.8Z" />
          </svg>
          Editing message
        </p>
      )}
      {(picker.attachments.length > 0 || keptAttachments.length > 0) && (
        <ul className="flex flex-wrap gap-2">
          {keptAttachments.map((attachment) => (
            <li key={attachment.id} className="relative">
              {attachment.kind === "IMAGE" ? (
                <img
                  src={attachment.thumbUrl ?? undefined}
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
                onClick={() => setRemovedIds((previous) => [...previous, attachment.id])}
                className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full border border-line bg-surface text-sm leading-none text-ink-muted shadow-sm hover:text-primary"
              >
                ×
              </button>
            </li>
          ))}
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

      <div
        ref={barRef}
        className={`flex border bg-surface focus-within:border-accent ${
          expanded
            ? "flex-col rounded-3xl px-2 pb-1.5 pt-1"
            : "items-center gap-1 rounded-full px-1.5 py-0.5"
        } ${editing ? "border-accent" : "border-line"}`}
        onBlur={(event) => {
          if (event.relatedTarget && isOutside(event.relatedTarget)) setActive(false);
        }}
        onClick={(event) => {
          // A press anywhere on the resting pill, bar its buttons, starts typing.
          if (!(event.target as Element).closest("button")) editor?.commands.focus();
        }}
      >
        {/* Here at rest, in the toolbar once open; the editor keeps its place either way. */}
        {!expanded && plusMenu}

        <div className={`flex min-w-0 ${expanded ? "px-1.5" : "flex-1"}`}>
          <Suspense fallback={<ComposerEditorFallback placeholder={placeholder} />}>
            <RichComposerEditor
              value={body}
              onChange={onBodyChange}
              members={mentionable}
              placeholder={placeholder}
              autoFocus={autoFocus}
              focusToken={editingId}
              ariaLabel={editing ? "Edit message" : parentPostId ? "Reply" : "Message"}
              maxLength={GROUP_POST_BODY_MAX}
              onSubmit={() => void submit()}
              onEditor={setEditor}
              onFocus={() => setActive(true)}
            />
          </Suspense>
        </div>

        {expanded && (
          <div className="flex items-center gap-1">
            {formatOpen ? (
              <>
                <button
                  type="button"
                  aria-label="Hide formatting"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setFormatOpen(false)}
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-white"
                >
                  <CloseIcon />
                </button>
                {/* On a very narrow phone the row scrolls rather than pushing send off the edge. */}
                <div className="flex min-w-0 flex-1 items-center overflow-x-auto sm:gap-0.5">
                  <Suspense fallback={null}>
                    <FormatButtons editor={editor} />
                  </Suspense>
                </div>
              </>
            ) : (
              <>
                {plusMenu}
                <button
                  type="button"
                  aria-label="Show formatting"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setFormatOpen(true)}
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-lg text-ink-muted transition hover:bg-surface-muted hover:text-ink"
                >
                  <span aria-hidden="true">Aa</span>
                </button>
                <AddReactionButton
                  label="Add emoji"
                  onPick={insertEmoji}
                  onOpenChange={setEmojiOpen}
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-ink-muted transition hover:bg-surface-muted hover:text-ink"
                >
                  <SmileIcon />
                </AddReactionButton>
                <div className="flex-1" />
              </>
            )}

            {editing ? (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  aria-label="Cancel editing"
                  disabled={busy}
                  onClick={() => onEditDone?.()}
                  className="tap-target inline-flex items-center justify-center rounded-full text-red-600 transition hover:bg-red-50 disabled:opacity-60"
                >
                  <CircleIcon tone="x" />
                </button>
                <button
                  type="button"
                  aria-label="Save changes"
                  disabled={!canSaveEdit}
                  onClick={() => void saveEdit()}
                  className="tap-target inline-flex items-center justify-center rounded-full text-green-600 transition hover:bg-green-50 disabled:cursor-not-allowed disabled:text-ink-muted disabled:opacity-60"
                >
                  <CircleIcon tone="check" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                aria-label="Send"
                disabled={busy || !canSend}
                onClick={() => void submit()}
                className="tap-target inline-flex shrink-0 items-center justify-center rounded-md text-primary transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:text-ink-muted disabled:opacity-60"
              >
                <SendIcon />
              </button>
            )}
          </div>
        )}
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
          mentionsEveryone: hasEveryoneMention(description),
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

/** A page torn from a calendar: the month on a band, the day large beneath it. */
function EventDateTile({ iso, past }: { iso: string; past: boolean }) {
  const date = parseIsoDate(iso);
  return (
    <div
      aria-hidden="true"
      className="flex h-16 w-14 shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-surface text-center shadow-sm"
    >
      <span
        className={`py-0.5 text-[10px] font-bold uppercase tracking-wider text-white ${
          past ? "bg-ink-muted" : "bg-primary"
        }`}
      >
        {date.toLocaleDateString(undefined, { month: "short" })}
      </span>
      <span className="flex flex-1 items-center justify-center text-2xl font-bold leading-none text-ink">
        {date.getDate()}
      </span>
    </div>
  );
}

function EventMeta({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm text-ink">
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className="mt-0.5 h-4 w-4 shrink-0 fill-current text-ink-muted"
      >
        {icon}
      </svg>
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

/**
 * An event, as a card: the date as a tile, the when and where with icons, then
 * RSVP as a segmented control with a guest stepper, and who is coming. Used in
 * the conversation and, larger, on the Events tab.
 */
function EventBlock({
  event,
  mentions,
  mentionsEveryone,
  postId,
  groupId,
  onChanged,
  wide = false,
  cancelled = false,
}: {
  event: NonNullable<GroupPostDto["event"]>;
  mentions: GroupPostDto["mentions"];
  mentionsEveryone: boolean;
  postId: string;
  groupId: string;
  onChanged: () => Promise<unknown>;
  /** Fill the width (up to a readable limit) -- the Events tab -- rather than a chat-sized card. */
  wide?: boolean;
  /**
   * The event was cancelled. Its details stay, so people can see *what* was
   * cancelled, but the RSVP controls and the who-is-coming line go.
   */
  cancelled?: boolean;
}) {
  const [showRsvps, setShowRsvps] = useState(false);
  const rsvp = useMutation({
    mutationFn: ({ response, guests }: { response: GroupRsvpResponse; guests: number }) =>
      api(`/groups/${groupId}/posts/${postId}/rsvp`, {
        method: "PUT",
        body: { response, guestCount: guests },
      }),
    onSuccess: () => void onChanged(),
  });

  const mine = event.myRsvp;
  const guests = mine?.guestCount ?? 0;
  const past = event.eventDate < todayIso();
  const soon = past || cancelled ? null : formatRelativeDay(event.eventDate);
  const times = formatEventTimes(event.startTime, event.endTime);
  const { yes, maybe, no } = event.rsvpCounts;

  return (
    <div
      className={`mt-1 w-full ${wide ? "max-w-2xl" : "max-w-xl"} overflow-hidden rounded-2xl border border-line bg-surface shadow-sm ${
        past || cancelled ? "opacity-80" : ""
      }`}
    >
      <div className="flex gap-3 p-4">
        <EventDateTile iso={event.eventDate} past={past || cancelled} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3
              className={`min-w-0 break-words text-lg font-bold leading-snug ${
                cancelled ? "text-ink-muted line-through" : "text-ink"
              }`}
            >
              {event.title}
            </h3>
            {cancelled && <Badge tone="primary">Cancelled</Badge>}
            {soon && <Badge tone="accent">{soon}</Badge>}
            {past && !cancelled && <Badge tone="neutral">Past</Badge>}
          </div>
          <EventMeta
            icon={
              <path d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm.8 4.2v3.5l2.7 1.6a.8.8 0 1 1-.8 1.4l-3.1-1.8a.8.8 0 0 1-.4-.7V6.2a.8.8 0 0 1 1.6 0Z" />
            }
          >
            {formatDayLabel(event.eventDate)}
            {times && <span className="text-ink-muted"> · {times}</span>}
          </EventMeta>
          {event.location && (
            <EventMeta
              icon={
                <path d="M10 1.8a6 6 0 0 0-6 6c0 4.2 5.2 9.9 5.4 10.1a.8.8 0 0 0 1.2 0C10.8 17.7 16 12 16 7.8a6 6 0 0 0-6-6Zm0 8.2a2.2 2.2 0 1 1 0-4.4 2.2 2.2 0 0 1 0 4.4Z" />
              }
            >
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`}
                target="_blank"
                rel="noreferrer"
                className="text-accent underline-offset-2 hover:underline"
              >
                {event.location}
              </a>
            </EventMeta>
          )}
          {event.description && (
            <p className="whitespace-pre-line break-words pt-1 text-sm leading-snug text-ink-muted">
              <MentionText
                text={event.description}
                mentions={mentions}
                mentionsEveryone={mentionsEveryone}
              />
            </p>
          )}
        </div>
      </div>

      {!cancelled && (
        <div className="space-y-3 border-t border-line bg-surface-muted/60 px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <div
              role="group"
              aria-label="Your RSVP"
              className="inline-flex overflow-hidden rounded-lg border border-line bg-surface"
            >
              {RSVP_OPTIONS.map((option) => {
                const active = mine?.response === option;
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={active}
                    disabled={rsvp.isPending}
                    onClick={() => rsvp.mutate({ response: option, guests })}
                    className={`px-3 py-1.5 text-sm font-bold transition first:border-l-0 border-l border-line disabled:opacity-60 ${
                      active ? "bg-primary text-white" : "text-ink hover:bg-surface-muted"
                    }`}
                  >
                    {RSVP_LABELS[option]}
                  </button>
                );
              })}
            </div>

            {mine?.response === "YES" && (
              <div className="flex items-center gap-1 text-sm text-ink-muted">
                <span id={`guests-${postId}`}>My guests</span>
                <div
                  role="group"
                  aria-labelledby={`guests-${postId}`}
                  className="inline-flex items-center overflow-hidden rounded-lg border border-line bg-surface"
                >
                  <button
                    type="button"
                    aria-label="Fewer guests"
                    disabled={rsvp.isPending || guests <= 0}
                    onClick={() => rsvp.mutate({ response: "YES", guests: guests - 1 })}
                    className="px-2.5 py-1 text-base font-bold text-ink hover:bg-surface-muted disabled:text-ink-muted/50"
                  >
                    −
                  </button>
                  <span aria-live="polite" className="min-w-6 text-center font-bold text-ink">
                    {guests}
                  </span>
                  <button
                    type="button"
                    aria-label="More guests"
                    disabled={rsvp.isPending || guests >= 50}
                    onClick={() => rsvp.mutate({ response: "YES", guests: guests + 1 })}
                    className="px-2.5 py-1 text-base font-bold text-ink hover:bg-surface-muted disabled:text-ink-muted/50"
                  >
                    +
                  </button>
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setShowRsvps(true)}
            className="flex items-center gap-1.5 text-sm font-bold text-accent hover:underline"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">
              <path d="M7 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm6.5.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1.5 16a5.5 5.5 0 0 1 11 0 .8.8 0 0 1-.8.8H2.3a.8.8 0 0 1-.8-.8Zm11.7.8c.2-.3.3-.5.3-.8 0-1.6-.6-3-1.5-4a4.6 4.6 0 0 1 6.5 4.2.8.8 0 0 1-.8.8h-4.5Z" />
            </svg>
            {yes + maybe + no === 0 ? (
              "No RSVPs yet"
            ) : (
              <span>
                {yes} going · {maybe} maybe · {no} not going
              </span>
            )}
          </button>
        </div>
      )}

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
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(null);
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
      {zoomed && (
        <PhotoLightbox src={zoomed.src} alt={zoomed.alt} onClose={() => setZoomed(null)} />
      )}
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
          {file.attachment.kind === "IMAGE" && file.attachment.fullUrl ? (
            <button
              type="button"
              onClick={() =>
                setZoomed({ src: file.attachment.fullUrl ?? "", alt: file.attachment.filename })
              }
              className="shrink-0 font-bold text-accent hover:underline"
            >
              Open
            </button>
          ) : (
            <a
              href={file.attachment.fullUrl ?? file.attachment.downloadUrl ?? undefined}
              target={file.attachment.fullUrl ? "_blank" : undefined}
              download={file.attachment.downloadUrl ? file.attachment.filename : undefined}
              rel="noreferrer"
              className="shrink-0 font-bold text-accent hover:underline"
            >
              Open
            </a>
          )}
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
  canReact,
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
  canReact: boolean;
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

  const today = todayIso();
  // The API sends newest first. What is coming reads soonest first, and what has
  // gone, most recent first -- so each list starts with the one nearest to now.
  const dateOf = (post: GroupPostDto) => post.event?.eventDate ?? "";
  const upcoming = events
    .filter((e) => dateOf(e) >= today)
    .sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
  const past = events
    .filter((e) => dateOf(e) < today)
    .sort((a, b) => dateOf(b).localeCompare(dateOf(a)));

  const section = (title: string, posts: GroupPostDto[]) => (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-ink-muted">
        {title}
        <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs">{posts.length}</span>
      </h2>
      <ul className="space-y-4">
        {posts.map((post) => (
          <ChatRow
            key={post.id}
            post={post}
            showHeader
            groupId={groupId}
            members={members}
            now={now}
            onReport={onReport}
            onChanged={onChanged}
            canReact={canReact}
            isReply
            variant="card"
          />
        ))}
      </ul>
    </section>
  );

  return (
    <div className="space-y-8">
      {upcoming.length > 0 && section("Upcoming", upcoming)}
      {past.length > 0 && section("Past", past)}
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
  onLeave,
}: {
  group: GroupDto;
  groupId: string;
  isAdmin: boolean;
  onClose: () => void;
  onChanged: () => Promise<unknown>;
  /** Close this and ask to leave the group. */
  onLeave: () => void;
}) {
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const filtered = group.members.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()));
  const admins = group.members.filter((m) => m.role === "ADMIN");

  return (
    <Modal title={group.title} onClose={onClose} wide={group.canModerate}>
      <div className="space-y-6">
        {/* Not on the group's own page: it only took room from the messages. */}
        {group.description && (
          <div>
            <p className="mb-1 font-bold text-ink">About</p>
            <GroupDescription text={group.description} />
          </div>
        )}

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

        {group.myRole && (
          <div className="border-t border-line pt-4">
            <Button variant="danger" onClick={onLeave}>
              Leave group
            </Button>
          </div>
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
      <Select
        aria-label="Your notifications for this group"
        value={notificationPref ?? ""}
        onChange={(value) => {
          const pref = (value || null) as GroupNotificationPref | null;
          setNotificationPref(pref);
          savePref.mutate(pref);
        }}
        options={[
          {
            value: "",
            label: `Use my default (${GROUP_NOTIFICATION_PREF_LABELS[group.notificationPrefDefault]})`,
          },
          ...GROUP_NOTIFICATION_PREFS.map((pref) => ({
            value: pref,
            label: GROUP_NOTIFICATION_PREF_LABELS[pref],
          })),
        ]}
      />
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
    onSuccess: () => {
      void navigate("/groups", { viewTransition: true });
      // Gone for good: drop everything cached about it (which also stops its
      // live poll asking for a group that no longer exists) and refetch the
      // list, or the groups page shows it until a manual reload.
      queryClient.removeQueries({ queryKey: qk.group(organizationId, groupId) });
      void queryClient.invalidateQueries({ queryKey: qk.groups(organizationId), exact: true });
    },
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
