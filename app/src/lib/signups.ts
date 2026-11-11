import { GROUP_SIGNUP_MAX_SLOTS, type SignupNoteMode, type SignupTemplate } from "@shared";
import { formatDayLabel, parseIsoDate } from "./format";

/**
 * Sign-ups, the pure parts: templates, the "Add dates" helper, how a slot is
 * named, the flyer's rows, and where a public signer's edit tokens are kept.
 * Kept out of the components so each can be tested without rendering.
 */

/** Where a sign-up can be seen without signing in -- see eventShareUrl. */
export function signupShareUrl(token: string): string {
  return `${window.location.origin}/s/${token}`;
}

export interface DraftSlot {
  /** Set for a slot that already exists, so an edit keeps its entries. */
  id?: string;
  date: string;
  label: string;
  /** Blank: unlimited. */
  capacity: string;
  /** What is already signed up, for an existing slot -- what the editor warns about. */
  taken?: number;
}

export interface SignupTemplateSpec {
  template: SignupTemplate;
  name: string;
  blurb: string;
  emoji: string;
  title: string;
  /** Whether slots are dates (a meal train, flowers) rather than items. */
  dated: boolean;
  noteMode: SignupNoteMode;
  notePrompt: string;
  writeInsEnabled: boolean;
  writeInMax: number | null;
  /** Shows "For" and the important-info box up front rather than under More options. */
  forSomeone: boolean;
  infoLabel: string;
  infoPlaceholder: string;
  slots: DraftSlot[];
}

const item = (label: string, capacity: number): DraftSlot => ({
  date: "",
  label,
  capacity: String(capacity),
});

/**
 * The starting points. A template only fills the form in: everything stays
 * editable, and what is stored is the same whichever one was picked.
 */
export const SIGNUP_TEMPLATE_SPECS: SignupTemplateSpec[] = [
  {
    template: "POTLUCK",
    name: "Potluck",
    blurb: "Dish types and how many of each; people say what they're bringing.",
    emoji: "🍲",
    title: "Potluck",
    dated: false,
    noteMode: "REQUIRED",
    notePrompt: "What are you bringing?",
    writeInsEnabled: false,
    writeInMax: null,
    forSomeone: false,
    infoLabel: "Good to know",
    infoPlaceholder: "Allergies to avoid, serving utensils, drop-off time…",
    slots: [item("Main dish", 4), item("Side dish", 4), item("Dessert", 4)],
  },
  {
    template: "MEAL_TRAIN",
    name: "Meal train",
    blurb: "One meal a day for a family: dates, dietary needs, and who's cooking.",
    emoji: "🥘",
    title: "Meals for ",
    dated: true,
    noteMode: "OPTIONAL",
    notePrompt: "What meal are you bringing?",
    writeInsEnabled: false,
    writeInMax: null,
    forSomeone: true,
    infoLabel: "Dietary restrictions & drop-off",
    infoPlaceholder: "No nuts; kids love pasta. Drop off by 5:30pm at the side door.",
    slots: [],
  },
  {
    template: "FLOWERS",
    name: "Flowers",
    blurb: "A list of dates; people pick one. No notes needed.",
    emoji: "💐",
    title: "Altar flowers",
    dated: true,
    noteMode: "NONE",
    notePrompt: "",
    writeInsEnabled: false,
    writeInMax: null,
    forSomeone: false,
    infoLabel: "Good to know",
    infoPlaceholder: "Bring flowers by Saturday afternoon.",
    slots: [],
  },
  {
    template: "STOCKINGS",
    name: "Stockings",
    blurb: "Items and counts, plus a few spots for people's own ideas.",
    emoji: "🧦",
    title: "St. Nicholas stockings",
    dated: false,
    noteMode: "NONE",
    notePrompt: "",
    writeInsEnabled: true,
    writeInMax: 5,
    forSomeone: false,
    infoLabel: "Good to know",
    infoPlaceholder: "Drop items in the bin by the hall door by December 1.",
    slots: [item("Oranges", 30), item("Chocolate coins", 30), item("Candy canes", 30)],
  },
  {
    template: "CUSTOM",
    name: "Something else",
    blurb: "Start blank: volunteers, rides, setup crew…",
    emoji: "📝",
    title: "",
    dated: false,
    noteMode: "OPTIONAL",
    notePrompt: "",
    writeInsEnabled: false,
    writeInMax: null,
    forSomeone: false,
    infoLabel: "Good to know",
    infoPlaceholder: "Anything people should know before signing up.",
    slots: [],
  },
];

export function templateSpec(template: SignupTemplate): SignupTemplateSpec {
  return (
    SIGNUP_TEMPLATE_SPECS.find((spec) => spec.template === template) ??
    SIGNUP_TEMPLATE_SPECS[SIGNUP_TEMPLATE_SPECS.length - 1]!
  );
}

/** yyyy-mm-dd for a local calendar date. */
function toIso(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * Every date from `start` to `end` inclusive that falls on one of `weekdays`
 * (0 = Sunday), capped at what a sign-up can hold. Empty `weekdays` means
 * every day. What "Add dates…" fills the slot list with.
 */
export function datesBetween(start: string, end: string, weekdays: readonly number[]): string[] {
  if (!start || !end || end < start) return [];
  const out: string[] = [];
  const day = parseIsoDate(start);
  const last = parseIsoDate(end);
  while (day <= last && out.length < GROUP_SIGNUP_MAX_SLOTS) {
    if (weekdays.length === 0 || weekdays.includes(day.getDay())) out.push(toIso(day));
    day.setDate(day.getDate() + 1);
  }
  return out;
}

/** "Sunday, 6 December · Dinner", "Main dish", or null for the one general slot. */
export function slotTitle(slot: { date: string | null; label: string | null }): string | null {
  const parts = [slot.date ? formatDayLabel(slot.date) : null, slot.label].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Whether a sign-up is just the one blank, general slot ("bring anything"). */
export function isGeneralOnly(
  slots: readonly { date: string | null; label: string | null; isWriteIn: boolean }[]
): boolean {
  const own = slots.filter((s) => !s.isWriteIn);
  return own.length === 1 && own[0]!.date === null && own[0]!.label === null;
}

/** Spots left in a slot, or null when it is unlimited. */
export function spotsLeft(slot: { capacity: number | null; taken: number }): number | null {
  return slot.capacity === null ? null : Math.max(0, slot.capacity - slot.taken);
}

/**
 * What the flyer lists under the title: the dates, or what is needed, as far
 * as fits in a few lines. The flyer's own layout clamps anything longer.
 */
export function signupFlyerRows(signup: {
  slots: { date: string | null; label: string | null; isWriteIn: boolean }[];
  closesOn: string | null;
  importantInfo: string | null;
}): Array<[string, string]> {
  const own = signup.slots.filter((s) => !s.isWriteIn);
  const rows: Array<[string, string]> = [];
  const dates = [...new Set(own.map((s) => s.date).filter((d): d is string => d !== null))];
  const labels = [...new Set(own.map((s) => s.label).filter((l): l is string => l !== null))];
  if (dates.length > 0) {
    rows.push([
      "DATES",
      dates.length > 6
        ? `${shortDate(dates[0]!)} – ${shortDate(dates[dates.length - 1]!)} (${dates.length} dates)`
        : dates.map(shortDate).join(", "),
    ]);
  }
  if (labels.length > 0) rows.push(["NEEDED", labels.join(", ")]);
  if (signup.closesOn) rows.push(["SIGN UP BY", formatDayLabel(signup.closesOn)]);
  if (rows.length === 0) rows.push(["", "Sign up online"]);
  return rows;
}

function shortDate(iso: string): string {
  return parseIsoDate(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// A public signer's edit tokens
// ---------------------------------------------------------------------------

/**
 * The edit tokens for public entries this browser made, by entry id. The token
 * is also in the "save this link" URL, so losing storage (a private window,
 * cleared data) loses nothing the link cannot bring back. Every access is
 * wrapped: storage can throw.
 */
const storageKey = (shareToken: string) => `signup-entries:${shareToken}`;

export function loadEditTokens(shareToken: string): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(storageKey(shareToken));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function saveEditTokens(shareToken: string, tokens: Record<string, string>): void {
  try {
    window.localStorage.setItem(storageKey(shareToken), JSON.stringify(tokens));
  } catch {
    // Not fatal: the edit link still works.
  }
}

/** `?entry=<id>.<token>` -- what the "save this link" URL carries. */
export function parseEntryParam(value: string | null): { entryId: string; token: string } | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  return { entryId: value.slice(0, dot), token: value.slice(dot + 1) };
}

export function entryEditUrl(shareToken: string, entryId: string, token: string): string {
  return `${signupShareUrl(shareToken)}?entry=${entryId}.${token}`;
}
