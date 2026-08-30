import { Link } from "react-router";
import type { SpecialDateOccurrenceDto } from "@shared";
import {
  formatDayLabel,
  formatRelativeDay,
  specialDateDetail,
  specialDateLabel,
} from "../lib/format";
import { EmptyState } from "./ui";

/**
 * Dates "grouped by date then special date type". The grouping and ordering are
 * done by the API; this renders it.
 */
export function SpecialDateList({
  days,
  emptyTitle = "Nothing coming up",
}: {
  days: { date: string; dates: SpecialDateOccurrenceDto[] }[];
  emptyTitle?: string;
}) {
  const withEntries = days.filter((day) => day.dates.length > 0);

  if (withEntries.length === 0) {
    return (
      <EmptyState title={emptyTitle}>
        <p>Try a longer range, or add birthdays and name days from a person's page.</p>
      </EmptyState>
    );
  }

  return (
    <ol className="space-y-6">
      {withEntries.map((day) => (
        <li key={day.date}>
          <h3 className="mb-2 flex flex-wrap items-baseline gap-2 border-b border-line pb-1">
            <span className="font-bold text-ink">{formatDayLabel(day.date)}</span>
            {formatRelativeDay(day.date) && (
              <span className="text-sm font-bold text-accent">{formatRelativeDay(day.date)}</span>
            )}
          </h3>

          <ul className="space-y-2">
            {day.dates.map((entry) => (
              <SpecialDateRow key={`${day.date}-${entry.id}`} entry={entry} />
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function SpecialDateRow({ entry }: { entry: SpecialDateOccurrenceDto }) {
  const detail = specialDateDetail(entry);

  return (
    <li className="flex flex-col gap-0.5 rounded-md bg-surface-muted px-3 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <span className="min-w-0">
        <Link
          to={`/people/${entry.personId}`}
          className="font-bold text-primary transition hover:text-accent"
        >
          {entry.personName}
        </Link>
        {entry.relatedPersonName && (
          <>
            <span className="text-ink-muted"> &amp; </span>
            <Link
              to={`/people/${entry.relatedPersonId}`}
              className="font-bold text-primary transition hover:text-accent"
            >
              {entry.relatedPersonName}
            </Link>
          </>
        )}
      </span>

      <span className="flex flex-wrap items-baseline gap-x-2 text-sm text-ink-muted">
        <span>{specialDateLabel(entry.type)}</span>
        {detail && <span className="font-bold text-accent">{detail}</span>}
      </span>
    </li>
  );
}
