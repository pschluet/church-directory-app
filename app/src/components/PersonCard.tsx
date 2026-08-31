import { memo } from "react";
import { Link } from "react-router";
import type { PersonSummaryDto } from "@shared";
import { formatAddress, fullName } from "../lib/format";
import { Avatar } from "./Avatar";
import { PhoneLink } from "./PhoneLink";
import { Badge } from "./ui";

/**
 * One person in a directory listing. A single column on a phone, gridded from
 * `md` up -- see BrowseDirectory.
 *
 * Memoized: the directory accumulates every page it has loaded into one array
 * and re-renders the lot when "Show more" appends to it. This was pointless
 * while photoUrl was a freshly-signed URL on every fetch, because no prop was
 * ever referentially equal; photo paths are stable now.
 */
function PersonCardImpl({ person }: { person: PersonSummaryDto }) {
  const name = fullName(person);
  const address = formatAddress(person);

  return (
    <article className="flex gap-4 rounded-lg border border-line bg-surface p-4 transition hover:border-accent">
      {/* Deliberately a link and not a lightbox: from a list, opening the
          record is the useful action, and click-to-enlarge lives on the detail
          page where there is nowhere else for a click to go. */}
      <Link to={`/people/${person.id}`} aria-label={name} className="shrink-0">
        <Avatar thumbUrl={person.thumbUrl} person={person} />
      </Link>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="truncate font-bold text-ink">
            <Link to={`/people/${person.id}`} className="transition hover:text-accent">
              {name}
            </Link>
          </h3>
          {person.appUserId === null && <Badge>No account</Badge>}
        </div>

        {person.familyName && (
          <p className="mt-0.5 truncate text-sm text-ink-muted">{person.familyName} family</p>
        )}

        <dl className="mt-2 space-y-1 text-sm">
          {person.phone && (
            <div className="flex gap-2">
              <dt className="sr-only">Phone</dt>
              <dd>
                <PhoneLink phone={person.phone} label={name} />
              </dd>
            </div>
          )}
          {person.email && (
            <div className="flex gap-2">
              <dt className="sr-only">Email</dt>
              <dd className="min-w-0">
                <a
                  href={`mailto:${person.email}`}
                  className="block truncate text-primary transition hover:text-accent"
                >
                  {person.email}
                </a>
              </dd>
            </div>
          )}
          {address && (
            <div className="flex gap-2">
              <dt className="sr-only">Address</dt>
              <dd className="text-ink-muted">{address}</dd>
            </div>
          )}
        </dl>
      </div>
    </article>
  );
}

export const PersonCard = memo(PersonCardImpl);
