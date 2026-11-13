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
