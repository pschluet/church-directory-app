import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REACTIONS,
  emojiShortcode,
  isEmojiOnly,
  recordReactionUse,
  resetRecentReactions,
  topReactions,
} from "../src/lib/emoji";

/*
 * Node ships a `localStorage` of its own that is unavailable without
 * `--localstorage-file` and shadows jsdom's, so a suite that wants to watch a
 * value round-trip supplies the store (as maps.test.ts does).
 */
function fakeStorage(): Map<string, string> {
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => void entries.set(key, value),
      removeItem: (key: string) => void entries.delete(key),
    },
  });
  return entries;
}

describe("frequently used reactions", () => {
  let stored: Map<string, string>;
  beforeEach(() => {
    stored = fakeStorage();
    resetRecentReactions();
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("starts with the defaults on a device that has never reacted", () => {
    expect(topReactions(3)).toEqual(DEFAULT_REACTIONS.slice(0, 3));
    expect(topReactions(6)).toEqual(DEFAULT_REACTIONS);
  });

  it("puts what was used last first, and fills the rest from the defaults", () => {
    recordReactionUse("🎉");
    recordReactionUse("🔥");
    expect(topReactions(4)).toEqual(["🔥", "🎉", "👍", "❤️"]);
  });

  it("lists an emoji once, moving it to the front when it is used again", () => {
    recordReactionUse("🔥");
    recordReactionUse("🎉");
    recordReactionUse("🔥");
    expect(topReactions(2)).toEqual(["🔥", "🎉"]);
  });

  it("does not repeat a default that was also used", () => {
    recordReactionUse("🙏");
    const top = topReactions(6);
    expect(top[0]).toBe("🙏");
    expect(top.filter((e) => e === "🙏")).toHaveLength(1);
  });

  it("remembers across a reload", () => {
    recordReactionUse("🎉");
    expect(JSON.parse(stored.get("reactions.recent")!)).toEqual(["🎉"]);
    // A reload is a fresh module reading what was written.
    resetRecentReactions();
    stored.set("reactions.recent", JSON.stringify(["🎉"]));
    expect(topReactions(2)).toEqual(["🎉", "👍"]);
  });

  it("keeps only the last two dozen", () => {
    for (let i = 0; i < 30; i++) recordReactionUse(String.fromCodePoint(0x1f600 + i));
    expect(JSON.parse(stored.get("reactions.recent")!)).toHaveLength(24);
  });

  it("survives a corrupt stored value", () => {
    resetRecentReactions();
    stored.set("reactions.recent", "{not json");
    expect(topReactions(2)).toEqual(DEFAULT_REACTIONS.slice(0, 2));
  });

  it("still works for the session where there is no storage at all", () => {
    resetRecentReactions();
    Reflect.deleteProperty(globalThis, "localStorage");
    expect(() => recordReactionUse("🎉")).not.toThrow();
    expect(topReactions(1)).toEqual(["🎉"]);
  });
});

describe("isEmojiOnly", () => {
  it.each(["🎉", "🎉🎉🎉", "🎉 🙏", "👍🏽", "👨‍👩‍👧", "🇺🇸", "  🔥  "])("is true for %j", (text) => {
    expect(isEmojiOnly(text)).toBe(true);
  });

  it.each(["", "   ", null, undefined, "hello", "hi 🎉", "🎉!", "1", "2024"])(
    "is false for %j",
    (text) => {
      expect(isEmojiOnly(text)).toBe(false);
    }
  );

  it("stops at 23, as Slack does", () => {
    expect(isEmojiOnly("🎉".repeat(23))).toBe(true);
    expect(isEmojiOnly("🎉".repeat(24))).toBe(false);
  });
});

describe("emojiShortcode", () => {
  const table = { "1F525": "fire", "1F44D": ["+1", "thumbsup"], "2764": "heart" };

  it("names an emoji the way Slack does", () => {
    expect(emojiShortcode(table, "🔥")).toBe(":fire:");
  });

  it("takes the first of several names", () => {
    expect(emojiShortcode(table, "👍")).toBe(":+1:");
  });

  it("finds an emoji whether or not it carries the variation selector", () => {
    expect(emojiShortcode(table, "❤️")).toBe(":heart:");
    expect(emojiShortcode(table, "❤")).toBe(":heart:");
  });

  it("names a skin tone as a suffix on the base emoji", () => {
    expect(emojiShortcode(table, "👍🏽")).toBe(":+1::skin-tone-4:");
    expect(emojiShortcode(table, "👍🏿")).toBe(":+1::skin-tone-6:");
  });

  it("gives null when there is no name, or the names have not loaded", () => {
    expect(emojiShortcode(table, "🦖")).toBeNull();
    expect(emojiShortcode(undefined, "🔥")).toBeNull();
  });
});
