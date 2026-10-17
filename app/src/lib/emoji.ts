import { useQuery } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { isSingleEmoji } from "@shared";

/**
 * Where the emoji picker reads its data from. The emojibase plugin in
 * vite.config.ts serves it from our own origin under a versioned path and
 * injects the path; the fallback is for tests, which never fetch it.
 */
export const EMOJIBASE_URL = import.meta.env.VITE_EMOJIBASE_URL ?? "/emojibase";

// ---------------------------------------------------------------------------
// Frequently used
// ---------------------------------------------------------------------------

/** What a new device offers before anyone has reacted: Slack's handy few. */
export const DEFAULT_REACTIONS = ["👍", "❤️", "😂", "🙏", "🙌", "👀"];

const RECENT_KEY = "reactions.recent";
const RECENT_MAX = 24;

/** Most recently used first, one entry per emoji. */
type Recents = string[];

let cached: Recents | null = null;
const listeners = new Set<() => void>();

function readRecents(): Recents {
  if (cached) return cached;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    cached = Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : [];
  } catch {
    // Private mode or a corrupt value: nothing remembered is no worse than nothing.
    cached = [];
  }
  return cached;
}

/** Notes that this emoji was just used, which moves it to the front. */
export function recordReactionUse(emoji: string): void {
  const next = [emoji, ...readRecents().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
  cached = next;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Not remembering is fine; the in-memory list still serves this session.
  }
  for (const listener of listeners) listener();
}

/** Forgets what was remembered. For tests, which share one jsdom between cases. */
export function resetRecentReactions(): void {
  cached = null;
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    // As above.
  }
  for (const listener of listeners) listener();
}

/**
 * The emoji to offer first: what this person used last, then the defaults to
 * fill the row -- so a brand-new device is useful and a regular one is theirs.
 */
export function topReactions(count: number, recents: Recents = readRecents()): string[] {
  const result = [...recents];
  for (const emoji of DEFAULT_REACTIONS) if (!result.includes(emoji)) result.push(emoji);
  return result.slice(0, count);
}

/** Re-renders when a reaction is used anywhere, so every open toolbar stays in step. */
export function useTopReactions(count: number): string[] {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  const recents = useSyncExternalStore(subscribe, readRecents);
  return topReactions(count, recents);
}

/** The picker's own "Frequently used" row: only what was really used, never the padding. */
export function useRecentReactions(): string[] {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  return useSyncExternalStore(subscribe, readRecents);
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

type Shortcodes = Record<string, string | string[]>;

const SKIN_TONES: Record<string, number> = {
  "1F3FB": 2,
  "1F3FC": 3,
  "1F3FD": 4,
  "1F3FE": 5,
  "1F3FF": 6,
};

function hex(emoji: string): string[] {
  return Array.from(emoji, (c) => c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0"));
}

/**
 * ":fire:" for 🔥, the way Slack names an emoji in "reacted with :fire:". A
 * skin tone is named the way Slack does too, as a suffix on the base emoji's
 * name (":+1::skin-tone-4:"). Null for one with no name, which the caller shows
 * as the emoji itself.
 */
export function emojiShortcode(shortcodes: Shortcodes | undefined, emoji: string): string | null {
  if (!shortcodes) return null;
  const nameOf = (codes: string[]): string | null => {
    // Emojibase keys carry the variation selector only on some emoji; try both.
    for (const key of [codes.join("-"), codes.filter((c) => c !== "FE0F").join("-")]) {
      const found = shortcodes[key];
      if (found) return Array.isArray(found) ? found[0]! : found;
    }
    return null;
  };

  const codes = hex(emoji);
  const direct = nameOf(codes);
  if (direct) return `:${direct}:`;

  const tone = codes.find((c) => c in SKIN_TONES);
  if (tone) {
    const base = nameOf(codes.filter((c) => c !== tone));
    if (base) return `:${base}::skin-tone-${SKIN_TONES[tone]}:`;
  }
  return null;
}

/** The shortcode table, fetched the first time a tooltip wants a name and never again. */
export function useEmojiShortcodes(enabled = true): Shortcodes | undefined {
  const { data } = useQuery({
    queryKey: ["emoji", "shortcodes"],
    queryFn: async ({ signal }) => {
      const res = await fetch(`${EMOJIBASE_URL}/en/shortcodes/iamcal.json`, { signal });
      if (!res.ok) throw new Error("Could not load emoji names");
      return (await res.json()) as Shortcodes;
    },
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  return data;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Slack's limit for a message to count as "just emoji" and be shown large. */
const JUMBO_MAX = 23;

/**
 * Whether a message is nothing but emoji (and spaces) -- one to 23 of them --
 * which Slack shows at a larger size, and so does the chat.
 */
export function isEmojiOnly(text: string | null | undefined): boolean {
  if (!text) return false;
  const graphemes = [...new Intl.Segmenter().segment(text)]
    .map((s) => s.segment)
    .filter((g) => g.trim() !== "");
  return graphemes.length >= 1 && graphemes.length <= JUMBO_MAX && graphemes.every(isSingleEmoji);
}
