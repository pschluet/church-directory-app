import { useLocation, useSearchParams } from "react-router";
import { MESSAGE_PARAM } from "@shared";

/**
 * Links to one message in a group, and what a page does on arriving by one.
 *
 * A link is the page the message is shown on, with `?message=<id>` naming it:
 * the feed for a message (or event card) of its own, the thread for a reply to
 * a message, the event's page for a reply to an event. The page scrolls the
 * message into view and lights it for a moment (`flashMessage`), so whoever
 * followed the link -- or tapped a bell notification, which uses the same
 * links -- can tell which one it was about.
 *
 * Kept out of pages/GroupDetail.tsx so the notification bell, which is on every
 * page, can build one without importing the whole group page.
 */

// The links themselves live in api/src/notification-links.ts, so the
// notification email builds exactly the links the bell does.
export {
  MESSAGE_PARAM,
  eventDetailPath,
  messagePath,
  signupDetailPath,
  threadPath,
} from "@shared";

/** A group page's tabs, each at its own URL. */
export type Tab = "messages" | "files" | "events" | "signups";

const TABS: readonly Tab[] = ["messages", "files", "events", "signups"];

/**
 * Which tab a group URL is on. `/groups/:id` is Messages -- the canonical
 * group URL that the groups list and every notification already point at --
 * and so is anything this does not recognise.
 */
export function tabFromPathname(pathname: string): Tab {
  const segment = pathname.split("/").filter(Boolean)[2];
  return TABS.find((tab) => tab === segment) ?? "messages";
}

/** A tab's own URL, so it can be linked, bookmarked, and survive a reload. */
export function groupTabPath(groupId: string, tab: Tab): string {
  return `/groups/${groupId}/${tab}`;
}

/**
 * The state a tab hands the page it opens: that it came from the feed, so the
 * page's way out can pop this entry rather than push another, and which tab,
 * so a fallback lands back on it.
 */
export interface FeedState {
  fromFeed?: boolean;
  fromTab?: Tab;
  focusComposer?: boolean;
}

export function feedState(pathname: string, extra?: Omit<FeedState, "fromFeed" | "fromTab">) {
  return { fromFeed: true, fromTab: tabFromPathname(pathname), ...extra } satisfies FeedState;
}

/**
 * The message this navigation was asked to show, and the navigation's own key.
 *
 * The key is what makes it once per arrival rather than once per URL: tapping
 * the same bell entry twice is the same URL but a new navigation, and should
 * light the message again.
 */
export function useMessageTarget(): { targetId: string | null; targetKey: string } {
  const [params] = useSearchParams();
  const { key } = useLocation();
  return { targetId: params.get(MESSAGE_PARAM), targetKey: key };
}

/**
 * Scrolls the message with this id to the middle of `scroller` (or of the
 * window, for a page that scrolls itself) and lights it. Returns false when the
 * message is not on the page.
 *
 * Not `scrollIntoView`: inside a scrolling pane that also scrolls every
 * ancestor, the page included, which the group page holds still on purpose.
 *
 * The flash is a data attribute the stylesheet animates (see `[data-flash]` in
 * theme.css). Taken off and put back, with a reflow between, so a second
 * arrival restarts it rather than being swallowed by the one still running.
 */
export function flashMessage(postId: string, scroller?: HTMLElement | null): boolean {
  const root: ParentNode = scroller ?? document;
  const row = root.querySelector<HTMLElement>(
    `[data-post-id="${postId.replace(/["\\]/g, "\\$&")}"]`
  );
  if (!row) return false;

  const box = row.getBoundingClientRect();
  if (scroller) {
    const pane = scroller.getBoundingClientRect();
    // A row taller than the pane is shown from its top, not from its middle.
    const offset = Math.max(0, (pane.height - box.height) / 2);
    scroller.scrollTop += box.top - pane.top - offset;
  } else {
    const offset = Math.max(0, (window.innerHeight - box.height) / 2);
    window.scrollTo({ top: window.scrollY + box.top - offset });
  }

  delete row.dataset.flash;
  void row.offsetWidth;
  row.dataset.flash = "";
  // A row's own children animate too (a reaction pill, say); only this one ends it.
  const done = (event: AnimationEvent) => {
    if (event.target !== row) return;
    delete row.dataset.flash;
    row.removeEventListener("animationend", done);
  };
  row.addEventListener("animationend", done);
  return true;
}
