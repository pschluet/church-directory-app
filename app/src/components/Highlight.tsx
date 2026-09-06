import { Fragment } from "react";
import type { Range } from "../lib/highlight";

/**
 * A gold wash under the fragment somebody typed, wherever it turns up on a
 * directory card.
 *
 * `text-current` is not decoration, it is the fix: the browser's own stylesheet
 * paints `<mark>` black on yellow, Tailwind's preflight does not reset it, and
 * inheriting the colour instead is what lets one class work inside the ink
 * name, the muted family line and the red phone link alike.
 *
 * The rule underneath is an inset box-shadow rather than an underline because
 * `text-decoration` propagates from an ancestor and cannot be cancelled by a
 * descendant: inside PhoneLink's anchor, a decoration here would meet the
 * link's own `hover:decoration-current` and draw red straight through the gold.
 *
 * `-mx-0.5 px-0.5` leaves the total advance unchanged, so marking a fragment
 * never shifts the text around it -- and where the mark starts a truncated
 * line, the 2px bleed is clipped by `truncate`'s own `overflow: hidden` rather
 * than escaping the column. The wash is deliberately light (30%): `text-ink-muted`
 * on white has only about 0.8 of contrast headroom, and a heavier tint spends
 * it. No bold, either -- re-measuring the glyph run would make the truncation
 * point jump about as somebody types.
 */
const MARK_CLASS =
  "-mx-0.5 box-decoration-clone rounded-xs bg-accent-light/30 px-0.5 text-current shadow-[inset_0_-2px_0_0_var(--color-accent)]";

/**
 * Deliberately dumb: it is handed the ranges rather than the terms, so all the
 * matching lives in lib/highlight.ts and can be tested without a DOM, and every
 * caller's decision about *what* counts as a match stays out of here.
 *
 * With nothing to mark it renders the bare string and no wrapper element, so a
 * card that is being browsed rather than searched produces exactly the DOM it
 * did before this existed.
 */
export function Highlight({ text, ranges }: { text: string; ranges: readonly Range[] }) {
  if (ranges.length === 0) return <>{text}</>;

  const parts = [];
  let at = 0;
  for (const range of ranges) {
    if (range.start > at)
      parts.push(<Fragment key={`t${at}`}>{text.slice(at, range.start)}</Fragment>);
    parts.push(
      <mark key={`m${range.start}`} className={MARK_CLASS}>
        {text.slice(range.start, range.end)}
      </mark>
    );
    at = range.end;
  }
  if (at < text.length) parts.push(<Fragment key={`t${at}`}>{text.slice(at)}</Fragment>);

  return <>{parts}</>;
}
