import { useState } from "react";
import { EmojiPicker } from "frimousse";
import { EMOJIBASE_URL, topReactions, useRecentReactions } from "../lib/emoji";

/**
 * The emoji picker itself: Slack's shape -- a search box, a "Frequently used"
 * row, the categories to scroll, and under them the emoji under the pointer,
 * named, with the skin-tone hand at the right.
 *
 * Its own module, and loaded lazily by Reactions.tsx, so frimousse and its
 * styling stay out of the main bundle until somebody first opens a picker.
 */

const SKIN_TONE_KEY = "reactions.skinTone";
type SkinTone = "none" | "light" | "medium-light" | "medium" | "medium-dark" | "dark";
const SKIN_TONES: SkinTone[] = ["none", "light", "medium-light", "medium", "medium-dark", "dark"];

function readSkinTone(): SkinTone {
  try {
    const stored = localStorage.getItem(SKIN_TONE_KEY);
    return SKIN_TONES.includes(stored as SkinTone) ? (stored as SkinTone) : "none";
  } catch {
    return "none";
  }
}

export default function EmojiPickerPanel({ onPick }: { onPick: (emoji: string) => void }) {
  const [search, setSearch] = useState("");
  const [skinTone, setSkinTone] = useState<SkinTone>(readSkinTone);
  const recents = useRecentReactions();
  // The picker's own row shows what was really used, topped up so a new device
  // is not an empty row.
  const frequent = topReactions(9, recents);

  return (
    <EmojiPicker.Root
      onEmojiSelect={({ emoji }) => onPick(emoji)}
      emojibaseUrl={EMOJIBASE_URL}
      skinTone={skinTone}
      columns={9}
      className="isolate flex h-[24rem] w-full flex-col bg-surface text-ink"
    >
      <div className="p-2">
        <EmojiPicker.Search
          autoFocus
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search all emoji"
          aria-label="Search all emoji"
          className="w-full rounded-md border border-line bg-surface px-3 py-2 text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/40"
        />
      </div>

      {search === "" && (
        <div className="border-b border-line px-2 pb-2">
          <p className="px-1 pb-1 text-xs font-bold text-ink-muted">Frequently used</p>
          <ul className="flex flex-wrap">
            {frequent.map((emoji) => (
              <li key={emoji}>
                <button
                  type="button"
                  aria-label={`React with ${emoji}`}
                  onClick={() => onPick(emoji)}
                  className="flex size-9 items-center justify-center rounded-md text-xl hover:bg-surface-muted focus-visible:bg-surface-muted"
                >
                  {emoji}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <EmojiPicker.Viewport className="relative min-h-0 flex-1 outline-hidden">
        <EmojiPicker.Loading>
          <span className="absolute inset-0 flex items-center justify-center text-sm text-ink-muted">
            Loading…
          </span>
        </EmojiPicker.Loading>
        <EmojiPicker.Empty>
          <span className="absolute inset-0 flex items-center justify-center text-sm text-ink-muted">
            No emoji found.
          </span>
        </EmojiPicker.Empty>
        <EmojiPicker.List
          className="select-none pb-1.5"
          components={{
            CategoryHeader: ({ category, ...props }) => (
              <div
                className="bg-surface px-3 pb-1 pt-3 text-xs font-bold text-ink-muted"
                {...props}
              >
                {category.label}
              </div>
            ),
            Row: ({ children, ...props }) => (
              <div className="scroll-my-1.5 px-2" {...props}>
                {children}
              </div>
            ),
            Emoji: ({ emoji, ...props }) => (
              <button
                type="button"
                className="flex size-9 items-center justify-center rounded-md text-xl data-[active]:bg-surface-muted"
                {...props}
              >
                {emoji.emoji}
              </button>
            ),
          }}
        />
      </EmojiPicker.Viewport>

      <div className="flex min-h-14 items-center gap-3 border-t border-line bg-surface-muted px-3 py-2">
        <EmojiPicker.ActiveEmoji>
          {({ emoji }) =>
            emoji ? (
              <>
                <span className="text-3xl leading-none">{emoji.emoji}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-bold text-ink">
                  {emoji.label}
                </span>
              </>
            ) : (
              <span className="flex-1 text-sm text-ink-muted">Pick an emoji…</span>
            )
          }
        </EmojiPicker.ActiveEmoji>
        <EmojiPicker.SkinTone>
          {({ skinTone: current, skinToneVariations }) => {
            const index = Math.max(
              0,
              skinToneVariations.findIndex((v) => v.skinTone === current)
            );
            const next = skinToneVariations[(index + 1) % skinToneVariations.length];
            return (
              <button
                type="button"
                aria-label="Change skin tone"
                title="Change skin tone"
                onClick={() => {
                  if (!next) return;
                  setSkinTone(next.skinTone as SkinTone);
                  try {
                    localStorage.setItem(SKIN_TONE_KEY, next.skinTone);
                  } catch {
                    // Not remembering the tone is fine.
                  }
                }}
                className="flex size-9 shrink-0 items-center justify-center rounded-md text-xl hover:bg-surface"
              >
                {skinToneVariations[index]?.emoji ?? "✋"}
              </button>
            );
          }}
        </EmojiPicker.SkinTone>
      </div>
    </EmojiPicker.Root>
  );
}
