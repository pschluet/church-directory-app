import { memo } from "react";
import { Link } from "react-router";
import type { PersonSummaryDto } from "@shared";
import { fullName } from "../lib/format";
import { Avatar } from "./Avatar";
import { PhoneLink } from "./PhoneLink";
import { Badge } from "./ui";

/**
 * One person in a directory listing. A single column on a phone, gridded from
 * `md` up -- see BrowseDirectory.
 *
 * Every card carries the same four things -- photo, name, account pill, family,
 * phone -- and nothing else, so the grid does not go ragged as records vary. The
 * text column is a fixed height (the three lines below, which is as tall as a
 * card ever needs to be) with its content centred in it, so a record missing its
 * family or phone reads as trimmed rather than as a card with a hole in it.
 *
 * Memoized: the directory accumulates every page it has loaded into one array
 * and re-renders the lot when "Show more" appends to it. This was pointless
 * while photoUrl was a freshly-signed URL on every fetch, because no prop was
 * ever referentially equal; photo paths are stable now.
 */
function PersonCardImpl({ person }: { person: PersonSummaryDto }) {
  const name = fullName(person);

  return (
    <article className="flex items-center gap-4 rounded-lg border border-line bg-surface p-4 transition hover:border-accent">
      {/* Deliberately a link and not a lightbox: from a list, opening the
          record is the useful action, and click-to-enlarge lives on the detail
          page where there is nowhere else for a click to go. */}
      <Link to={`/people/${person.id}`} aria-label={name} className="shrink-0">
        <Avatar thumbUrl={person.thumbUrl} person={person} />
      </Link>

      {/* 5.5rem = the name (1.5) + the family line (1.25) + the phone, which is
          a 2.75rem tap target. */}
      <div className="flex h-22 min-w-0 flex-1 flex-col justify-center">
        <div className="flex items-center gap-2">
          <h3 className="truncate font-bold text-ink">
            <Link to={`/people/${person.id}`} className="transition hover:text-accent">
              {name}
            </Link>
          </h3>
          {person.appUserId === null && <Badge>No account</Badge>}
        </div>

        {person.familyName && (
          <p className="truncate text-sm text-ink-muted">{person.familyName} family</p>
        )}

        {person.phone && (
          <p className="text-sm">
            <PhoneLink phone={person.phone} label={name} />
          </p>
        )}
      </div>
    </article>
  );
}

export const PersonCard = memo(PersonCardImpl);
