import { displayPhone } from "./format";

/**
 * Finding the typed fragment inside the text a directory card shows.
 *
 * `/directory/search` ANDs one `ilike '%term%'` per term against
 * `persons_resolved.search_text`, a space-joined concat of every field on a
 * person. This module finds those same terms again on the client so a card can
 * mark them.
 *
 * That is exact rather than approximate, and one fact is why: a term can never
 * contain whitespace, because the server split on it. So a term can never
 * straddle two fields of the concatenation, and searching each field on its own
 * with `indexOf` asks precisely the question the SQL asked. Nothing here
 * guesses; if a term is not found in any field the card shows, the card knows
 * to reveal the field that does hold it.
 *
 * Terms arrive lowercased -- see `searchTerms` in @shared for the split, and
 * Directory for the one place the lowercasing happens. Matching is by
 * `indexOf`, never a RegExp built from the query: `%`, `(`, `.` and `+` are all
 * legal things to type, `escapeLike` already makes `%` and `_` literal
 * server-side, and a regex here would either throw or match the wrong thing.
 */

/** A half-open `[start, end)` slice of a string to wrap in a mark. */
export interface Range {
  start: number;
  end: number;
}

/** Whether a term appears in this text at all -- `text` raw, `term` lowercased. */
export function matchesTerm(text: string | null | undefined, term: string): boolean {
  return Boolean(text) && (text as string).toLowerCase().includes(term);
}

/**
 * Every occurrence, appended to `out`.
 *
 * Advances by one rather than by the term's length, so overlapping occurrences
 * of the same term are all found ("aa" twice in "aaa"); `merge` is what stops
 * that becoming two marks.
 */
function pushOccurrences(haystackLower: string, term: string, out: Range[]): void {
  if (term === "") return;
  for (let from = 0; ; ) {
    const at = haystackLower.indexOf(term, from);
    if (at === -1) return;
    out.push({ start: at, end: at + term.length });
    from = at + 1;
  }
}

/**
 * Overlapping and touching ranges collapsed into one.
 *
 * Touching as well as overlapping: two terms that happen to abut ("iva" and
 * "nova" in "Ivanova") are one continuous match to the eye, and two marks
 * side by side would show a seam where the negative margins meet.
 */
function merge(ranges: Range[]): Range[] {
  if (ranges.length < 2) return ranges;
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Range[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function highlightRanges(
  text: string | null | undefined,
  terms: readonly string[]
): Range[] {
  if (!text || terms.length === 0) return [];

  const lower = text.toLowerCase();
  const found: Range[] = [];
  for (const term of terms) pushOccurrences(lower, term, found);
  return merge(found);
}

/** Where each digit of a string sits in it, so a digit span can be mapped back. */
function digitPositions(text: string): { digits: string; at: number[] } {
  let digits = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (char >= "0" && char <= "9") {
      digits += char;
      at.push(i);
    }
  }
  return { digits, at };
}

/**
 * A run of matched digits turned into as few marks as the number allows.
 *
 * One mark for the whole span would be simplest and is wrong: the digits of
 * "3125" sit at "(**312**) **5**55-1234", and washing everything between them
 * drags in the bracket and the space to reach that last 5. So a separator is
 * absorbed only where it is a single character between two matched digits --
 * which keeps "5551234" as the one continuous "555-1234" a reader expects, and
 * splits the awkward case rather than smearing it.
 */
function pushDigitSpan(positions: number[], out: Range[]): void {
  const first = positions[0];
  if (first === undefined) return;

  let start = first;
  let previous = first;
  for (const position of positions.slice(1)) {
    if (position - previous > 2) {
      out.push({ start, end: previous + 1 });
      start = position;
    }
    previous = position;
  }
  out.push({ start, end: previous + 1 });
}

/**
 * The same, for a phone number, which is the one field stored in a different
 * shape from the one it is shown in.
 *
 * `search_text` holds raw E.164, the card shows `displayPhone`'s `(312)
 * 555-0140`, and a plain `indexOf` on the display string only finds the terms
 * that happen to survive the reformatting. Three rules, first one that fires:
 *
 *   1. the term as typed, somewhere in the displayed number -- "312", "0140",
 *      and anything non-numeric;
 *   2. the term's digits against the displayed number's digits, mapped back to
 *      characters and so spanning the separators inside them -- "5550140"
 *      marks "555-0140";
 *   3. the term is in the raw E.164 but cannot be pointed at any narrower --
 *      "+1312", "13125550140" -- so the whole number is marked.
 *
 * Rule 3 is not a nicety. Without it those terms are found in the raw value,
 * count as explained, and nothing on the card is marked at all -- a result with
 * no visible reason, which is the failure the whole feature exists to prevent.
 *
 * Terms with a separator in them ("555-0140") never reach here: the server
 * would not have matched them, so there are no results to highlight.
 */
export function phoneRanges(e164: string | null | undefined, terms: readonly string[]): Range[] {
  const display = e164 ? displayPhone(e164) : null;
  if (!display || terms.length === 0) return [];

  const lower = display.toLowerCase();
  const raw = e164 as string;
  const { digits, at } = digitPositions(display);
  const found: Range[] = [];

  for (const term of terms) {
    const before = found.length;

    pushOccurrences(lower, term, found);
    if (found.length > before) continue;

    const termDigits = term.replace(/\D/g, "");
    if (termDigits !== "") {
      for (let from = 0; ; ) {
        const start = digits.indexOf(termDigits, from);
        if (start === -1) break;
        // Both ends exist: `digits` and `at` were built in one pass, so a hit
        // in the former is always in range of the latter.
        pushDigitSpan(at.slice(start, start + termDigits.length), found);
        from = start + 1;
      }
      if (found.length > before) continue;
    }

    if (raw.toLowerCase().includes(term)) found.push({ start: 0, end: display.length });
  }

  return merge(found);
}

/** How far back it is worth reaching for a word boundary. */
const SNAP_BUDGET = 12;

const ELLIPSIS = "…";

/**
 * A long value windowed around its first match, with the ranges moved to suit.
 *
 * The reveal line is the one place the text can be long -- a full address is
 * "4129 W Newport Ave, Chicago IL 60641, United States" and the card is one of
 * three columns from `lg` up. A match on the country or the postcode would sit
 * past the truncation, and a revealed line whose highlight is off-screen is
 * worse than no line: it reads as an address glued to the card for no reason.
 *
 * The window is placed so the match sits about a third in, which leaves enough
 * of what precedes it to recognise ("...Chicago IL 60641, United..." rather
 * than the match at the very edge). `truncate` stays on the element as the
 * backstop for whatever the character count cannot know about pixels.
 */
export function excerpt(
  text: string,
  ranges: readonly Range[],
  max: number
): { text: string; ranges: Range[] } {
  if (text.length <= max) return { text, ranges: [...ranges] };

  const first = ranges[0];
  if (!first) return { text: `${text.slice(0, max).trimEnd()}${ELLIPSIS}`, ranges: [] };

  /*
   * A third of the window ahead of the match, and deliberately not clamped
   * back so the window still ends at the end of the string. Clamping is the
   * obvious thing and it is wrong: it would leave a match near the end sitting
   * hard against the right edge, which is the one place `truncate` can still
   * take it away. A window shorter than `max` costs a few characters of
   * context; a highlight nobody can see costs the whole point of the line.
   */
  let start = Math.max(0, first.start - Math.floor(max / 3));

  // Begin at a word rather than mid-word. Backwards, not forwards: reaching
  // left only ever shows more, where snapping forward would throw away the
  // very context the window was sized to keep.
  if (start > 0) {
    const space = text.lastIndexOf(" ", start);
    if (space !== -1 && start - space <= SNAP_BUDGET) start = space + 1;
  }

  // The whole of the first match, even where it is longer than the window; a
  // mark cut in half looks like a rendering fault. Later matches can fall
  // outside it -- the line explains the card, it does not itemise it.
  const end = Math.min(text.length, Math.max(start + max, first.end));

  const head = start > 0 ? ELLIPSIS : "";
  const tail = end < text.length ? ELLIPSIS : "";
  // Safe before an ellipsis: a term has no whitespace in it, so trailing
  // whitespace can never be inside a range.
  const body = tail === "" ? text.slice(start, end) : text.slice(start, end).trimEnd();
  const shift = head.length - start;

  const clipped: Range[] = [];
  for (const range of ranges) {
    if (range.end <= start || range.start >= end) continue;
    clipped.push({
      start: Math.max(range.start, start) + shift,
      end: Math.min(range.end, end) + shift,
    });
  }

  return { text: `${head}${body}${tail}`, ranges: clipped };
}
