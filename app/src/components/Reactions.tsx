import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  fullName,
  type GroupMemberDto,
  type GroupPostDto,
  type GroupPostReactionDto,
} from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import {
  emojiShortcode,
  recordReactionUse,
  useEmojiShortcodes,
  useTopReactions,
} from "../lib/emoji";
import { useMe } from "../context/MeContext";
import { Avatar } from "./Avatar";
import { Modal } from "./ui";

/**
 * Emoji reactions on a group message, as Slack does them: pills under the
 * message with a count (yours highlighted, a click toggles yours), a tooltip
 * naming who reacted, an "add reaction" pill at the end, and on a phone a long
 * press on a pill to see everyone. ChatRow in pages/GroupDetail.tsx places
 * these; the rules for who may react are the server's (`canReact`).
 */

// The picker and its data are only wanted once somebody opens one.
const EmojiPickerPanel = lazy(() => import("./EmojiPickerPanel"));

const LONG_PRESS_MS = 450;
/** Names a tooltip lists before it says "and N others". */
const TOOLTIP_NAMES_MAX = 10;

// ---------------------------------------------------------------------------
// Toggling, with the cache updated before the server answers
// ---------------------------------------------------------------------------

interface ReactVars {
  postId: string;
  emoji: string;
  add: boolean;
}

/**
 * The post with the caller's reaction added or taken away. Used for the
 * optimistic update; the server's own answer replaces it moments later.
 */
function applyReaction(
  post: GroupPostDto,
  { emoji, add }: ReactVars,
  me: { appUserId: string; personId: string; name: string }
): GroupPostDto {
  const existing = post.reactions.find((r) => r.emoji === emoji);
  const reactor = { appUserId: me.appUserId, personId: me.personId, name: me.name };
  let reactions: GroupPostReactionDto[];
  if (add) {
    if (existing?.reactedByMe) return post;
    reactions = existing
      ? post.reactions.map((r) =>
          r === existing ? { ...r, reactedByMe: true, reactors: [...r.reactors, reactor] } : r
        )
      : [...post.reactions, { emoji, reactedByMe: true, reactors: [reactor] }];
  } else {
    reactions = post.reactions.flatMap((r) => {
      if (r.emoji !== emoji) return [r];
      const reactors = r.reactors.filter((m) => m.personId !== me.personId);
      return reactors.length === 0 ? [] : [{ ...r, reactedByMe: false, reactors }];
    });
  }
  return { ...post, reactions };
}

/**
 * Applies `fn` to every cached copy of a post, whatever its cache holds: the
 * feed's pages, a thread's root, its replies, or the events tab. Recognised by
 * shape rather than by key, so a new place that lists posts is covered the day
 * it exists.
 */
function mapCachedPosts(data: unknown, fn: (post: GroupPostDto) => GroupPostDto): unknown {
  if (!data || typeof data !== "object") return data;
  const d = data as Record<string, unknown>;
  if (Array.isArray(d.pages)) return { ...d, pages: d.pages.map((p) => mapCachedPosts(p, fn)) };
  for (const key of ["posts", "replies", "events"]) {
    const list = d[key];
    if (Array.isArray(list) && list.every((p) => p && typeof p === "object" && "reactions" in p)) {
      return { ...d, [key]: (list as GroupPostDto[]).map(fn) };
    }
  }
  if (typeof d.id === "string" && Array.isArray(d.reactions))
    return fn(d as unknown as GroupPostDto);
  return data;
}

function patchPost(
  queryClient: QueryClient,
  keys: QueryKey[],
  postId: string,
  patch: (post: GroupPostDto) => GroupPostDto
): void {
  for (const queryKey of keys) {
    queryClient.setQueriesData({ queryKey }, (data: unknown) =>
      mapCachedPosts(data, (post) => (post.id === postId ? patch(post) : post))
    );
  }
}

/**
 * Add or remove the caller's reaction on a post. The pill changes at once and
 * is put right if the server refuses. `react` works out add-or-remove from the
 * post it is handed, so every control -- pill, toolbar, picker -- toggles the
 * same way: using an emoji you already used takes it back, as in Slack.
 */
export function useReactionToggle(groupId: string) {
  const queryClient = useQueryClient();
  const { me, organizationId } = useMe();
  const keys = [
    qk.groupPosts(organizationId, groupId) as QueryKey,
    qk.groupEvents(organizationId, groupId) as QueryKey,
  ];
  const mutationKey = ["group-react", groupId];

  const mutation = useMutation({
    mutationKey,
    mutationFn: ({ postId, emoji, add }: ReactVars) =>
      api<GroupPostDto>(
        `/groups/${groupId}/posts/${postId}/reactions/${encodeURIComponent(emoji)}`,
        { method: add ? "PUT" : "DELETE" }
      ),
    onMutate: async (vars) => {
      await Promise.all(keys.map((queryKey) => queryClient.cancelQueries({ queryKey })));
      const previous = keys.flatMap((queryKey) => queryClient.getQueriesData({ queryKey }));
      if (me?.person) {
        const who = {
          appUserId: me.appUser.id,
          personId: me.person.id,
          name: fullName(me.person),
        };
        patchPost(queryClient, keys, vars.postId, (post) => applyReaction(post, vars, who));
      }
      return { previous };
    },
    onSuccess: (server, vars) => {
      // With several taps in flight, an early answer would briefly undo the
      // later ones; the last to land has the final word.
      if (queryClient.isMutating({ mutationKey }) > 1) return;
      patchPost(queryClient, keys, vars.postId, (post) => ({
        ...post,
        reactions: server.reactions,
      }));
    },
    onError: (_error, _vars, context) => {
      for (const [queryKey, data] of context?.previous ?? [])
        queryClient.setQueryData(queryKey, data);
      void queryClient.invalidateQueries({ queryKey: qk.group(organizationId, groupId) });
    },
  });

  const { mutate } = mutation;
  const react = useCallback(
    (post: GroupPostDto, emoji: string) => {
      const add = !post.reactions.some((r) => r.emoji === emoji && r.reactedByMe);
      if (add) recordReactionUse(emoji);
      mutate({ postId: post.id, emoji, add });
    },
    [mutate]
  );

  return { react, error: mutation.error, reset: mutation.reset };
}

// ---------------------------------------------------------------------------
// The picker, as a popover on a mouse and a sheet on a phone
// ---------------------------------------------------------------------------

/**
 * Keeps pointer events that begin inside an overlay from reaching the message
 * row it was opened from: React bubbles through portals, and the row treats a
 * held finger as a long press that opens its own drawer.
 */
function Isolated({ children }: { children: ReactNode }) {
  return (
    <div className="contents" onPointerDown={(event) => event.stopPropagation()}>
      {children}
    </div>
  );
}

const PICKER_WIDTH = 352;
const PICKER_HEIGHT = 384;

function PickerPopover({
  anchor,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  // Beside its button, on whichever side has the room, and never off-screen.
  useLayoutEffect(() => {
    const box = anchor.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(
      Math.max(margin, box.right - PICKER_WIDTH),
      Math.max(margin, window.innerWidth - PICKER_WIDTH - margin)
    );
    const roomBelow = window.innerHeight - box.bottom;
    const below = roomBelow >= PICKER_HEIGHT + margin || roomBelow >= box.top;
    const top = below
      ? Math.min(box.bottom + 4, Math.max(margin, window.innerHeight - PICKER_HEIGHT - margin))
      : Math.max(margin, box.top - PICKER_HEIGHT - 4);
    setAt({ top, left });
  }, [anchor]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // The button toggles it, so a press on the button must not also close it first.
      if (panelRef.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // Scrolling the pane under it leaves it hanging; the picker's own list scrolls freely.
    const onScroll = (event: Event) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Add reaction"
      style={{ position: "fixed", width: PICKER_WIDTH, ...(at ?? { top: -9999, left: 0 }) }}
      className="z-50 overflow-hidden rounded-lg border border-line bg-surface shadow-xl"
    >
      <PickerBody onPick={onPick} />
    </div>,
    document.body
  );
}

function PickerBody({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <Suspense
      fallback={
        <div className="flex h-[24rem] items-center justify-center text-sm text-ink-muted">
          Loading…
        </div>
      }
    >
      <EmojiPickerPanel onPick={onPick} />
    </Suspense>
  );
}

function SmilePlusIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="h-[1.1rem] w-[1.1rem] fill-none stroke-current"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M17.5 10.4A7.5 7.5 0 1 1 9.6 2.5" />
      <path d="M6.6 11.6a4 4 0 0 0 6.8 0" />
      <path d="M7.2 8h.01M12.2 8h.01" strokeWidth="2.2" />
      <path d="M15 1.5v5M12.5 4h5" />
    </svg>
  );
}

/**
 * A button that opens the picker and hands back the emoji chosen. Wherever one
 * is wanted -- the pills, the hover toolbar, the phone drawer, the message bar
 * -- it is this, so they all look and behave alike.
 */
export function AddReactionButton({
  onPick,
  label = "Add reaction",
  className = "",
  children,
  onOpenChange,
}: {
  onPick: (emoji: string) => void;
  label?: string;
  className?: string;
  children?: ReactNode;
  /** So a row can stay lit while its picker is open. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const close = useCallback(() => {
    setAnchor(null);
    onOpenChange?.(false);
  }, [onOpenChange]);

  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        onClick={(event) => {
          if (anchor) return close();
          setAnchor(event.currentTarget);
          onOpenChange?.(true);
        }}
        className={className}
      >
        {children ?? <SmilePlusIcon />}
      </button>
      {anchor && (
        <Isolated>
          {window.matchMedia?.("(hover: none)").matches ? (
            <Modal title="Add reaction" onClose={close}>
              <div className="-mx-5 -mb-5 overflow-hidden rounded-b-xl border-t border-line md:-mx-6 md:-mb-6">
                <PickerBody
                  onPick={(emoji) => {
                    close();
                    onPick(emoji);
                  }}
                />
              </div>
            </Modal>
          ) : (
            <PickerPopover
              anchor={anchor}
              onClose={() => {
                close();
                anchor.focus();
              }}
              onPick={(emoji) => {
                close();
                onPick(emoji);
              }}
            />
          )}
        </Isolated>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Quick reactions
// ---------------------------------------------------------------------------

/** The emoji this person reaches for most, one tap each -- the hover toolbar's and the drawer's. */
export function QuickReactions({
  post,
  count,
  onReact,
  buttonClassName,
}: {
  post: GroupPostDto;
  count: number;
  onReact: (emoji: string) => void;
  buttonClassName: string;
}) {
  const emojis = useTopReactions(count);
  return (
    <>
      {emojis.map((emoji) => {
        const mine = post.reactions.some((r) => r.emoji === emoji && r.reactedByMe);
        return (
          <button
            key={emoji}
            type="button"
            aria-label={`${mine ? "Remove" : "React with"} ${emoji}`}
            aria-pressed={mine}
            onClick={() => onReact(emoji)}
            className={buttonClassName}
          >
            {emoji}
          </button>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// The pills
// ---------------------------------------------------------------------------

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** "You (click to remove), Alice, and Bob" -- the people behind a pill, you first, as Slack lists them. */
function reactorNames(
  reaction: GroupPostReactionDto,
  canReact: boolean,
  mePersonId: string | null
): string {
  const names = reaction.reactors.filter((r) => r.personId !== mePersonId).map((r) => r.name);
  const shown = names.slice(0, TOOLTIP_NAMES_MAX);
  if (names.length > shown.length) {
    const rest = names.length - shown.length;
    shown.push(`${rest} ${rest === 1 ? "other" : "others"}`);
  }
  const you = reaction.reactedByMe ? [canReact ? "You (click to remove)" : "You"] : [];
  return joinNames([...you, ...shown]);
}

function PillTooltip({
  reaction,
  anchor,
  canReact,
  mePersonId,
}: {
  reaction: GroupPostReactionDto;
  anchor: HTMLElement;
  canReact: boolean;
  mePersonId: string | null;
}) {
  const shortcodes = useEmojiShortcodes();
  const name = emojiShortcode(shortcodes, reaction.emoji);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Centred above the pill, clamped to the screen -- fixed, because the message
  // pane clips anything that hangs out of it.
  useLayoutEffect(() => {
    const box = anchor.getBoundingClientRect();
    const tip = ref.current?.getBoundingClientRect();
    const width = tip?.width ?? 0;
    const height = tip?.height ?? 0;
    const left = Math.min(
      Math.max(8, box.left + box.width / 2 - width / 2),
      Math.max(8, window.innerWidth - width - 8)
    );
    const top = box.top - height - 6 >= 8 ? box.top - height - 6 : box.bottom + 6;
    setAt({ top, left });
  }, [anchor, name, reaction]);

  const who = reactorNames(reaction, canReact, mePersonId);

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={{ position: "fixed", ...(at ?? { top: -9999, left: 0 }) }}
      className="pointer-events-none z-50 w-max max-w-[18rem] rounded-lg bg-ink px-3 py-2.5 text-center text-sm text-white shadow-lg"
    >
      <span className="mx-auto mb-1.5 flex size-14 items-center justify-center rounded-md bg-white text-4xl">
        {reaction.emoji}
      </span>
      <span className="font-bold">{who}</span>
      <span className="text-white/75"> reacted with {name ?? reaction.emoji}</span>
    </div>,
    document.body
  );
}

function ReactionPill({
  reaction,
  canReact,
  mePersonId,
  onToggle,
  onLongPress,
}: {
  reaction: GroupPostReactionDto;
  canReact: boolean;
  mePersonId: string | null;
  onToggle: () => void;
  onLongPress: () => void;
}) {
  const [tip, setTip] = useState<HTMLElement | null>(null);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  /** The lift that ends a long press must not also count as a tap. */
  const swallowClick = useRef(false);
  const count = reaction.reactors.length;

  function cancelPress(): void {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }
  useEffect(() => cancelPress, []);

  const label = `${count} ${count === 1 ? "person" : "people"} reacted with ${reaction.emoji}`;
  const classes = `inline-flex h-7 items-center gap-1 rounded-full border px-2 text-sm leading-none transition ${
    reaction.reactedByMe
      ? "border-accent bg-accent-light/40 text-ink"
      : "border-line bg-surface-muted text-ink-muted hover:border-ink-muted"
  }`;

  return (
    <>
      <button
        type="button"
        aria-pressed={reaction.reactedByMe}
        aria-label={label}
        // A read-only viewer still gets the tooltip; the click just does nothing.
        onClick={(event) => {
          if (swallowClick.current) {
            swallowClick.current = false;
            event.preventDefault();
            return;
          }
          if (canReact) onToggle();
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") setTip(event.currentTarget);
        }}
        onPointerLeave={() => {
          setTip(null);
          cancelPress();
        }}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) setTip(event.currentTarget);
        }}
        onBlur={() => setTip(null)}
        // Held on a touch screen: who reacted. The row's own long press is for
        // the message, so this one must not reach it.
        onPointerDown={(event) => {
          event.stopPropagation();
          if (event.pointerType !== "touch") return;
          cancelPress();
          press.current = {
            x: event.clientX,
            y: event.clientY,
            timer: window.setTimeout(() => {
              press.current = null;
              swallowClick.current = true;
              window.setTimeout(() => {
                swallowClick.current = false;
              }, 400);
              navigator.vibrate?.(10);
              onLongPress();
            }, LONG_PRESS_MS),
          };
        }}
        onPointerMove={(event) => {
          const start = press.current;
          if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
            cancelPress();
          }
        }}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={(event) => {
          if (window.matchMedia?.("(hover: none)").matches) event.preventDefault();
        }}
        className={classes}
      >
        <span aria-hidden="true" className="text-base">
          {reaction.emoji}
        </span>
        <span aria-hidden="true" className="font-bold tabular-nums">
          {count}
        </span>
      </button>
      {tip && (
        <PillTooltip reaction={reaction} anchor={tip} canReact={canReact} mePersonId={mePersonId} />
      )}
    </>
  );
}

/**
 * The row of pills under a message. Nothing at all when there are none -- the
 * way to add the first is the hover toolbar or the long-press drawer, and the
 * "add reaction" pill only appears beside reactions that already exist.
 */
export function ReactionBar({
  post,
  groupId,
  canReact,
  onShowReactions,
}: {
  post: GroupPostDto;
  groupId: string;
  canReact: boolean;
  /** A long press on a pill: the row opens the sheet of who reacted. */
  onShowReactions: () => void;
}) {
  const { me } = useMe();
  const { react, error, reset } = useReactionToggle(groupId);

  if (post.reactions.length === 0) return null;
  const mePersonId = me?.person?.id ?? null;

  return (
    <div className="mt-1">
      <div role="group" aria-label="Reactions" className="flex flex-wrap items-center gap-1">
        {post.reactions.map((reaction) => (
          <ReactionPill
            key={reaction.emoji}
            reaction={reaction}
            canReact={canReact}
            mePersonId={mePersonId}
            onToggle={() => {
              reset();
              react(post, reaction.emoji);
            }}
            onLongPress={onShowReactions}
          />
        ))}
        {canReact && (
          <AddReactionButton
            onPick={(emoji) => {
              reset();
              react(post, emoji);
            }}
            className="inline-flex h-7 items-center rounded-full border border-line bg-surface-muted px-2 text-ink-muted transition hover:border-ink-muted hover:text-ink"
          />
        )}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-primary">
          {error.message}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Who reacted
// ---------------------------------------------------------------------------

/**
 * Everyone who reacted, with a tab per emoji: what a long press on a pill opens
 * on a phone, where there is no hover to read names from. "All" lists each
 * person once with the emoji they used.
 */
export function ReactionsSheet({
  post,
  members,
  onClose,
}: {
  post: GroupPostDto;
  members: GroupMemberDto[];
  onClose: () => void;
}) {
  const { me } = useMe();
  const [tab, setTab] = useState<string>("all");
  const total = post.reactions.reduce((sum, r) => sum + r.reactors.length, 0);
  const thumbOf = (appUserId: string) =>
    members.find((m) => m.appUserId === appUserId)?.thumbUrl ?? null;

  // One line per person under "All", in the order they first reacted.
  const people = new Map<
    string,
    { appUserId: string; personId: string; name: string; emojis: string[] }
  >();
  for (const reaction of post.reactions) {
    for (const reactor of reaction.reactors) {
      const entry = people.get(reactor.personId) ?? { ...reactor, emojis: [] };
      entry.emojis.push(reaction.emoji);
      people.set(reactor.personId, entry);
    }
  }
  const rows =
    tab === "all"
      ? [...people.values()]
      : (post.reactions.find((r) => r.emoji === tab)?.reactors ?? []).map((r) => ({
          ...r,
          emojis: [tab],
        }));

  const tabClass = (active: boolean) =>
    `tap-target inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-4 text-sm font-bold ${
      active ? "border-accent bg-accent-light/40 text-ink" : "border-line text-ink-muted"
    }`;

  return (
    <Isolated>
      <Modal noSelect title="Reactions" onClose={onClose}>
        <div
          role="tablist"
          aria-label="Reactions"
          className="-mx-1 mb-4 flex gap-2.5 overflow-x-auto px-1 pb-2"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "all"}
            onClick={() => setTab("all")}
            className={tabClass(tab === "all")}
          >
            All {total}
          </button>
          {post.reactions.map((reaction) => (
            <button
              key={reaction.emoji}
              type="button"
              role="tab"
              aria-selected={tab === reaction.emoji}
              aria-label={`${reaction.emoji} ${reaction.reactors.length}`}
              onClick={() => setTab(reaction.emoji)}
              className={tabClass(tab === reaction.emoji)}
            >
              <span aria-hidden="true" className="text-base">
                {reaction.emoji}
              </span>
              <span aria-hidden="true">{reaction.reactors.length}</span>
            </button>
          ))}
        </div>
        <ul role="tabpanel" className="divide-y divide-line">
          {rows.map((row) => (
            <li key={row.personId} className="flex items-start gap-3 py-3">
              <Avatar
                thumbUrl={thumbOf(row.appUserId)}
                person={{ firstName: row.name, lastName: null }}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold text-ink">
                  {row.name}
                  {row.personId === me?.person?.id && (
                    <span className="font-normal text-ink-muted"> (you)</span>
                  )}
                </p>
                {/* Under the name, and free to wrap: a person with many reactions
                    must not squeeze their own name down to an ellipsis. */}
                {tab === "all" && (
                  <p
                    aria-hidden="true"
                    className="mt-0.5 flex flex-wrap gap-x-1.5 text-lg leading-snug"
                  >
                    {row.emojis.map((emoji) => (
                      <span key={emoji}>{emoji}</span>
                    ))}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Modal>
    </Isolated>
  );
}
