import { memo } from "react";
import { Link } from "react-router";
import type { PersonSummaryDto } from "@shared";
import { displayPhone, formatSingleLineAddress, fullName } from "../lib/format";
import { excerpt, highlightRanges, matchesTerm, phoneRanges, type Range } from "../lib/highlight";
import { Avatar } from "./Avatar";
import { Highlight } from "./Highlight";
import { PhoneLink } from "./PhoneLink";
import { Badge } from "./ui";

/**
 * A field the card does not otherwise show, ready to be revealed if that is
 * where the search found its match.
 *
 * `find` rather than a plain `indexOf` because the alternate phone is stored in
 * a different shape from the one it is shown in, exactly like the main one --
 * see phoneRanges. For the rest the text on screen and the text the server
 * searched are the same string; the address is comma-joined where `search_text`
 * is space-joined, which cannot matter, because a term with a comma in it would
 * not have matched the server and a term without one cannot straddle either
 * separator.
 */
interface RevealGroup {
  label: string;
  text: (person: PersonSummaryDto) => string | null;
  find: (person: PersonSummaryDto, text: string, terms: readonly string[]) => Range[];
}

const plain: RevealGroup["find"] = (_person, text, terms) => highlightRanges(text, terms);

/**
 * In the order they are shown, which is also the order ties are broken in.
 *
 * A tie only happens when one term sits in two groups -- "chicago" in both an
 * address and an @chicago.org email -- and on a directory card the address is
 * the more useful of the two to have put there.
 *
 * Between them these four cover every field of `search_text` that the card does
 * not already show: address line 1 and 2, city, state, postcode and country all
 * live in the address line, and the name, family and phone are on the card
 * already. That exhaustiveness is what makes "every result shows a reason it
 * matched" true rather than hopeful.
 */
const REVEAL_GROUPS: RevealGroup[] = [
  { label: "Address", text: (p) => formatSingleLineAddress(p) || null, find: plain },
  { label: "Email", text: (p) => p.email, find: plain },
  { label: "Saint", text: (p) => p.patronSaint, find: plain },
  {
    label: "Other phone",
    text: (p) => displayPhone(p.altPhone),
    find: (person, _text, terms) => phoneRanges(person.altPhone, terms),
  },
];

/**
 * Two lines, because a third inflates the whole grid row: every card beside a
 * greedy one grows to match it, so one record with a lot of matching fields
 * would tax its neighbours. Anything past the second is dropped in silence -- a
 * "+1 more" would be a promise the card cannot keep.
 */
const REVEAL_LIMIT = 2;

/**
 * Deliberately under what the narrowest column fits, so that `excerpt` is what
 * decides where the line ends and not `truncate`.
 *
 * The difference matters: the window keeps the mark, CSS does not know there is
 * one. At 44 a postcode match on "4129 W Newport Ave, Chicago IL 60641" was
 * left unwindowed -- short enough to pass -- and then clipped by the column to
 * "...Chicago IL 6", which showed one character of the reason the card was
 * there.
 */
const REVEAL_MAX_CHARS = 28;

interface Reveal {
  label: string;
  text: string;
  ranges: Range[];
}

/**
 * Which hidden fields this card has to show to account for the search.
 *
 * Terms already visible on the card explain themselves and are dropped first,
 * so searching a name never grows a line. What is left is covered greedily
 * rather than by walking the groups in order: "newport 60641" is two terms and
 * *one* address line, and a line-per-term rule would spend both slots saying so
 * twice.
 *
 * The chosen lines are then re-sorted back into REVEAL_GROUPS order, so a
 * card's shape does not depend on which term happened to be more widely held --
 * scanning a page of results, the address is always in the same place.
 *
 * A group only marks the terms it was picked for. A term already accounted for
 * by the name is not marked again three lines down, where it would look like a
 * second, weaker reason.
 */
function revealsFor(person: PersonSummaryDto, terms: readonly string[]): Reveal[] {
  if (terms.length === 0) return [];

  const name = fullName(person);
  const remaining = new Set(
    terms.filter(
      (term) =>
        !matchesTerm(name, term) &&
        !matchesTerm(person.familyName, term) &&
        phoneRanges(person.phone, [term]).length === 0
    )
  );
  if (remaining.size === 0) return [];

  const candidates = REVEAL_GROUPS.map((group) => ({ group, text: group.text(person) })).filter(
    (candidate): candidate is { group: RevealGroup; text: string } => Boolean(candidate.text)
  );

  const chosen: { order: number; label: string; text: string; ranges: Range[] }[] = [];

  while (remaining.size > 0 && chosen.length < REVEAL_LIMIT) {
    let best: { order: number; text: string; group: RevealGroup; covered: string[] } | null = null;

    for (const [order, candidate] of candidates.entries()) {
      if (chosen.some((line) => line.order === order)) continue;
      const covered = [...remaining].filter(
        (term) => candidate.group.find(person, candidate.text, [term]).length > 0
      );
      // Strictly greater, so a tie leaves the earlier group in place.
      if (covered.length > 0 && (!best || covered.length > best.covered.length)) {
        best = { order, text: candidate.text, group: candidate.group, covered };
      }
    }
    if (!best) break;

    for (const term of best.covered) remaining.delete(term);
    chosen.push({
      order: best.order,
      label: best.group.label,
      text: best.text,
      ranges: best.group.find(person, best.text, best.covered),
    });
  }

  return chosen
    .sort((a, b) => a.order - b.order)
    .map(({ label, text, ranges }) => {
      const windowed = excerpt(text, ranges, REVEAL_MAX_CHARS);
      return { label, text: windowed.text, ranges: windowed.ranges };
    });
}

/**
 * One person in a directory listing. A single column on a phone, gridded from
 * `md` up -- see Directory.
 *
 * Every card carries the same four things -- photo, name, account pill, family,
 * phone -- and nothing else, so the grid does not go ragged as records vary. The
 * text column is a fixed height (the three lines below, which is as tall as a
 * card ever needs to be) with its content centred in it, so a record missing its
 * family or phone reads as trimmed rather than as a card with a hole in it.
 *
 * Searching is the one exception, and it earns it. `terms` marks the typed
 * fragment wherever it already appears, and where the match was in a field this
 * card deliberately leaves off -- an address, an email, a patron saint -- the
 * card grows a line to say so, because a result with no visible reason for
 * being in the list is worse than a slightly taller card. The column becomes
 * `min-h-22` only when that happens, and the article is `h-full` so the taller
 * card lifts its whole grid row rather than sitting in a well of dead space.
 *
 * Memoized: the directory accumulates every page it has loaded into one array
 * and re-renders the lot when "Show more" appends to it. This was pointless
 * while photoUrl was a freshly-signed URL on every fetch, because no prop was
 * ever referentially equal; photo paths are stable now, and `terms` arrives from
 * a useMemo for the same reason.
 */
function PersonCardImpl({
  person,
  terms = [],
}: {
  person: PersonSummaryDto;
  /** Lowercased search terms to mark; empty while browsing. See lib/highlight.ts. */
  terms?: readonly string[];
}) {
  const name = fullName(person);
  const reveals = revealsFor(person, terms);

  return (
    <article className="flex h-full items-center gap-4 rounded-lg border border-line bg-surface p-4 transition hover:border-accent">
      {/* Deliberately a link and not a lightbox: from a list, opening the
          record is the useful action, and click-to-enlarge lives on the detail
          page where there is nowhere else for a click to go. */}
      <Link to={`/people/${person.id}`} aria-label={name} className="shrink-0">
        <Avatar thumbUrl={person.thumbUrl} person={person} />
      </Link>

      {/* 5.5rem = the name (1.5) + the family line (1.25) + the phone, which is
          a 2.75rem tap target. A revealed line is allowed past that; nothing
          else is. */}
      <div
        className={`flex min-w-0 flex-1 flex-col justify-center ${reveals.length > 0 ? "min-h-22" : "h-22"}`}
      >
        <div className="flex items-center gap-2">
          <h3 className="truncate font-bold text-ink">
            <Link to={`/people/${person.id}`} className="transition hover:text-accent">
              <Highlight text={name} ranges={highlightRanges(name, terms)} />
            </Link>
          </h3>
          {person.appUserId === null && <Badge>No account</Badge>}
        </div>

        {person.familyName && (
          <p className="truncate text-sm text-ink-muted">
            {/* The name only. Marking the word "family" would credit the search
                with matching a label the server never saw. */}
            <Highlight
              text={person.familyName}
              ranges={highlightRanges(person.familyName, terms)}
            />{" "}
            family
          </p>
        )}

        {person.phone && (
          <p className="text-sm">
            <PhoneLink phone={person.phone} label={name} terms={terms} />
          </p>
        )}

        {reveals.map((reveal) => (
          <p key={reveal.label} className="mt-0.5 truncate text-xs text-ink-muted">
            <span className="font-bold uppercase tracking-wide">{reveal.label}</span>
            {" · "}
            <Highlight text={reveal.text} ranges={reveal.ranges} />
          </p>
        ))}
      </div>
    </article>
  );
}

export const PersonCard = memo(PersonCardImpl);
