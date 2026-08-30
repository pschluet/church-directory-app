import { Link } from "react-router";
import type { PersonSummaryDto } from "@shared";
import { formatAddress, fullName } from "../lib/format";
import { Avatar } from "./Avatar";
import { PhoneLink } from "./PhoneLink";
import { Badge } from "./ui";

/**
 * One person in a directory listing. A single column on a phone, gridded from
 * `md` up -- see BrowseDirectory.
 */
export function PersonCard({ person }: { person: PersonSummaryDto }) {
  const name = fullName(person);
  const address = formatAddress(person);

  return (
    <article className="flex gap-4 rounded-lg border border-line bg-surface p-4 transition hover:border-accent">
      <Link to={`/people/${person.id}`} aria-label={name} className="shrink-0">
        <Avatar photoUrl={person.photoUrl} person={person} />
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
