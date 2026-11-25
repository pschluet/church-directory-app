import type { GroupPostKind, NotificationDto, NotificationType } from "./types";

/**
 * Where a notification leads, and what it is called -- shared by the bell (in
 * the SPA, through `@shared`) and the notification email (sent from the API).
 *
 * One copy because the two must agree: an email whose "Open" button lands
 * somewhere other than the bell entry for the same notification is the kind of
 * thing nobody reports and everybody notices. Dependency-free on purpose, so
 * the SPA can import it without pulling in anything server-side.
 */

/** The query parameter that names the message a link is about. */
export const MESSAGE_PARAM = "message";

/**
 * Set on the message links a push notification or a notification email opens
 * -- "push" or "email" -- to say where the member came from. Nothing reads it
 * to mark anything read any more: the message is scrolled into view on
 * landing, and being seen is what reads it (useMarkReadWhenSeen in the SPA),
 * however the member got there.
 */
export const ARRIVAL_PARAM = "from";
export const ARRIVAL_SOURCES = ["push", "email"] as const;
export type ArrivalSource = (typeof ARRIVAL_SOURCES)[number];

/** A notification link, tagged with where it was opened from. */
export function withArrival(path: string, source: ArrivalSource): string {
  return `${path}${path.includes("?") ? "&" : "?"}${ARRIVAL_PARAM}=${source}`;
}

/** Where a message's thread lives. */
export function threadPath(groupId: string, postId: string): string {
  return `/groups/${groupId}/threads/${postId}`;
}

/**
 * Where an event lives: its own page (EventDetail.tsx), not a chat thread. An
 * event's discussion is there too, so this is where "Reply" on one goes.
 */
export function eventDetailPath(groupId: string, postId: string): string {
  return `/groups/${groupId}/events/${postId}`;
}

/**
 * Where a sign-up lives: its own page (SignupDetail.tsx), the sign-up twin of
 * the event page. Its discussion is there too, so "Reply" on one goes here.
 */
export function signupDetailPath(groupId: string, postId: string): string {
  return `/groups/${groupId}/signups/${postId}`;
}

/**
 * The link to one message. `parentKind` says what a reply hangs off -- a
 * message's thread, an event's page or a sign-up's page -- and is ignored for
 * a post of its own.
 */
export function messagePath(
  groupId: string,
  post: { id: string; parentPostId: string | null },
  parentKind?: GroupPostKind | null
): string {
  const query = `?${MESSAGE_PARAM}=${encodeURIComponent(post.id)}`;
  if (!post.parentPostId) return `/groups/${groupId}${query}`;
  const parent =
    parentKind === "EVENT"
      ? eventDetailPath(groupId, post.parentPostId)
      : parentKind === "SIGNUP"
        ? signupDetailPath(groupId, post.parentPostId)
        : threadPath(groupId, post.parentPostId);
  return `${parent}${query}`;
}

/**
 * Where tapping a notification lands -- the message it is about (which the
 * page then scrolls to and lights), its group when it is about no one message,
 * People & Accounts for a directory request, or the prayer requests page.
 */
export function notificationPath(
  notification: Pick<
    NotificationDto,
    "type" | "groupId" | "groupPostId" | "groupPostParentId" | "groupPostParentKind"
  >
): string {
  if (notification.type === "DIRECTORY_REQUEST") return "/admin/users";
  if (!notification.groupId) return "/prayer-requests";
  if (!notification.groupPostId) return `/groups/${notification.groupId}`;
  return messagePath(
    notification.groupId,
    { id: notification.groupPostId, parentPostId: notification.groupPostParentId },
    notification.groupPostParentKind
  );
}

/**
 * What each kind of notification is, in the reader's words. The bell shows it
 * above the title, and the email puts it on each item -- for a request to be
 * reviewed the title only says *which* request, and this is what says it needs
 * the reader to do something.
 */
export const NOTIFICATION_LABELS: Record<NotificationType, string> = {
  PRAYER_REQUEST: "Prayer request",
  PRAYER_REQUEST_REVIEW: "Needs your approval",
  GROUP_POST: "New activity",
  GROUP_MENTION: "You were mentioned",
  GROUP_JOIN_REQUEST: "Someone wants to join",
  GROUP_EVENT: "Event changed",
  GROUP_POST_REPORT: "A post was reported",
  DIRECTORY_REQUEST: "Asked to be added to the directory",
};

/**
 * An item that can be on screen and, by being seen, read its notifications --
 * a message, a prayer request, the join-requests banner of a group (whose
 * notification is per group, not per request), or a directory request.
 */
export type SeenTarget =
  | { groupPostId: string }
  | { prayerRequestId: string }
  | { directoryRequestId: string }
  | { joinRequestGroupId: string };

const POST_TYPES: readonly NotificationType[] = [
  "GROUP_POST",
  "GROUP_MENTION",
  "GROUP_EVENT",
  "GROUP_POST_REPORT",
];

/**
 * Whether seeing `target` reads `notification`. The client's copy of
 * `markSeenRead` in services/notifications.ts, used for the optimistic update
 * and to skip items with nothing to clear; the two must agree.
 */
export function notificationMatchesTarget(
  notification: Pick<
    NotificationDto,
    "type" | "groupId" | "groupPostId" | "prayerRequestId" | "directoryRequestId"
  >,
  target: SeenTarget
): boolean {
  if ("groupPostId" in target) {
    return (
      POST_TYPES.includes(notification.type) && notification.groupPostId === target.groupPostId
    );
  }
  if ("prayerRequestId" in target) {
    return (
      (notification.type === "PRAYER_REQUEST" || notification.type === "PRAYER_REQUEST_REVIEW") &&
      notification.prayerRequestId === target.prayerRequestId
    );
  }
  if ("directoryRequestId" in target) {
    return (
      notification.type === "DIRECTORY_REQUEST" &&
      notification.directoryRequestId === target.directoryRequestId
    );
  }
  return (
    notification.type === "GROUP_JOIN_REQUEST" && notification.groupId === target.joinRequestGroupId
  );
}
