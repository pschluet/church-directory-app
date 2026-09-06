import { memo, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  auditActionLabel,
  auditEntityTypeLabel,
  type AuditActorDto,
  type AuditActorLookupDto,
  type AuditLogCursor,
  type AuditLogEntryDto,
  type AuditLogFilterOptionsDto,
  type AuditLogPageDto,
} from "@shared";
import { api } from "../lib/api";
import { qk } from "../lib/queryKeys";
import { useMe } from "../context/MeContext";
import { formatDayLabel, formatPostedAt, formatRelativeDay } from "../lib/format";
import { AuditChanges } from "../components/AuditChanges";
import { useInfiniteScroll } from "../components/useInfiniteScroll";
import { LookupPicker } from "../components/LookupPicker";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNotice,
  Field,
  Modal,
  PageHeading,
  Spinner,
  inputClass,
  useNow,
} from "../components/ui";

/**
 * "Who changed my phone number?"
 *
 * The audit log has been written since the first migration and never read. This
 * is the read half: one parish's trail, newest first, with every filter applied
 * by the API rather than by the browser -- fifty rows arrive at a time out of a
 * table nothing prunes, so filtering what has loaded would search the last
 * fifty entries and present that as the answer.
 *
 * One reflowing list of expandable cards at every width, and deliberately one
 * column even on a wide monitor. `AdminUsers` records what the app's only table
 * cost on a portrait tablet, and a log is read top to bottom besides -- columns
 * would break the one thing its order is for.
 */
export function AuditLog() {
  const { organizationId, isSuperAdmin } = useMe();
  const [params, setParams] = useSearchParams();
  const now = useNow();

  const filters = readFilters(params);
  const range = resolveRange(filters);
  const [sheetOpen, setSheetOpen] = useState(false);

  /*
   * The URL is the only copy of the filter state, as it is on the directory
   * page, so a filtered view can be shared and survives a reload -- and there
   * is no second copy in state to disagree with it.
   *
   * Merged into what is already there rather than replacing it. Handing
   * `setParams` a fresh object is the bug the directory page has a comment
   * about: it wipes every sibling filter, and here there are four of them.
   *
   * Every write pushes. Unlike the directory there is no text box, so nothing
   * fires per keystroke -- each change is one deliberate click, and making the
   * back button undo it is useful. Which is also why nothing here is debounced.
   */
  function update(mutate: (next: URLSearchParams) => void): void {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      mutate(next);
      return next;
    });
  }

  function toggleValue(key: string, value: string): void {
    update((next) => {
      const existing = next.getAll(key);
      next.delete(key);
      for (const kept of existing.filter((item) => item !== value)) next.append(key, kept);
      if (!existing.includes(value)) next.append(key, value);
    });
  }

  function clearDates(): void {
    update((next) => {
      next.delete("from");
      next.delete("to");
    });
  }

  function setCustomDate(key: "from" | "to", value: string): void {
    update((next) => {
      if (value) next.set(key, value);
      else next.delete(key);
    });
  }

  function clearFilters(): void {
    update((next) => {
      for (const key of ["action", "entityType", "actorId", "from", "to"]) next.delete(key);
    });
  }

  /*
   * Keyset pagination accumulated by the cache. The filters are inside the key,
   * so changing one is a different cache entry rather than a race: there is no
   * way to append rows matching the old filter onto the new list, nor to carry
   * a cursor across from the wrong set.
   *
   * The flatten is in `select` rather than in the body so `EntryList` keeps its
   * memo -- `select` is memoized against the pages it was handed, a `flatMap`
   * written in render is a new array every time the clock ticks.
   */
  const log = useInfiniteQuery({
    queryKey: qk.auditLogEntries(organizationId, {
      actions: filters.actions,
      entityTypes: filters.entityTypes,
      actorIds: filters.actorIds,
      from: range.fromInstant,
      to: range.toInstant,
    }),
    queryFn: ({ pageParam, signal }) =>
      api<AuditLogPageDto>("/audit", {
        signal,
        query: {
          limit: PAGE_SIZE,
          from: range.fromInstant ?? undefined,
          to: range.toInstant ?? undefined,
          cursorCreatedAt: pageParam?.createdAt,
          cursorId: pageParam?.id,
        },
        // `query` takes one value per key; these are repeated parameters.
        repeated: {
          action: filters.actions,
          entityType: filters.entityTypes,
          actorId: filters.actorIds,
        },
      }),
    initialPageParam: null as AuditLogCursor | null,
    getNextPageParam: (last: AuditLogPageDto) => last.nextCursor,
    select: (data) => data.pages.flatMap((page) => page.entries),
  });

  const entries = log.data ?? NO_ENTRIES;

  /*
   * The filter options are the values actually present in this parish's log,
   * not a list written down in the source. An action added at a call site and
   * not to `AUDIT_ACTIONS` still appears, and no option is ever offered that
   * would come back empty.
   */
  const options = useQuery({
    queryKey: qk.auditLogFilterOptions(organizationId),
    queryFn: ({ signal }) => api<AuditLogFilterOptionsDto>("/audit/filters", { signal }),
    staleTime: 5 * 60_000,
  });

  /*
   * The names behind the actor ids in the URL.
   *
   * The picker can only name what somebody has just typed, and these arrive in
   * a shared link or a reload with nothing but a uuid to go on -- so the chips
   * would read "Selected person" without this. Keyed on the ids, so returning
   * to a filter combination already looked at costs nothing.
   */
  const selectedActorQuery = useQuery({
    queryKey: qk.auditActorsByIds(organizationId, filters.actorIds),
    queryFn: ({ signal }) =>
      api<AuditActorLookupDto>("/audit/actors", {
        signal,
        repeated: { actorId: filters.actorIds },
      }),
    enabled: filters.actorIds.length > 0,
    staleTime: 5 * 60_000,
  });
  const selectedActors = selectedActorQuery.data?.actors ?? NO_ACTORS;

  const sentinelRef = useInfiniteScroll(() => void log.fetchNextPage(), {
    enabled: log.hasNextPage && !log.isFetchingNextPage,
  });

  const days = useMemo(() => groupByDay(entries), [entries]);
  const activeCount = countActive(filters);

  const subtitle = log.isPending
    ? undefined
    : `${entries.length}${log.hasNextPage ? "+" : ""} ${
        entries.length === 1 ? "entry" : "entries"
      }, newest first`;

  return (
    <>
      <PageHeading
        title="Audit Log"
        subtitle={subtitle}
        filters={
          <div className="w-full space-y-3">
            <Button variant="secondary" onClick={() => setSheetOpen(true)}>
              Filters
              {activeCount > 0 && <Badge tone="primary">{activeCount}</Badge>}
            </Button>

            {activeCount > 0 && (
              <ActiveChips
                filters={filters}
                actors={selectedActors}
                onRemove={toggleValue}
                onClearDates={clearDates}
                onClearAll={clearFilters}
              />
            )}
          </div>
        }
      />

      {sheetOpen && (
        <FilterSheet
          filters={filters}
          options={options.data}
          loading={options.isPending}
          selectedActors={selectedActors}
          onToggle={toggleValue}
          onCustomDate={setCustomDate}
          onClear={clearFilters}
          onClose={() => setSheetOpen(false)}
        />
      )}

      {log.error && <ErrorNotice message={log.error.message} onRetry={() => void log.refetch()} />}

      {log.isPending ? (
        <Spinner label="Loading the audit log" />
      ) : entries.length === 0 ? (
        // "Nothing recorded yet" would be a lie when a filter is what emptied
        // the list, so the way out is offered instead of the wrong reason.
        activeCount > 0 ? (
          <EmptyState title="Nothing matches these filters">
            <p>No activity was recorded for this combination.</p>
            <p className="mt-3">
              <Button variant="ghost" onClick={clearFilters}>
                Clear filters
              </Button>
            </p>
          </EmptyState>
        ) : (
          <EmptyState title="Nothing recorded yet">
            <p>Edits made by administrators will appear here as they happen.</p>
          </EmptyState>
        )
      ) : (
        <>
          <EntryList days={days} now={now} isSuperAdmin={isSuperAdmin} />

          {/*
            Loads the next page as it comes into range, and the button stays --
            it is the only way to page by keyboard, and the only one a screen
            reader will ever find.
          */}
          <div ref={sentinelRef} aria-hidden="true" className="h-px" />

          {log.hasNextPage && (
            <div className="mt-6 flex justify-center">
              <Button
                variant="secondary"
                onClick={() => void log.fetchNextPage()}
                disabled={log.isFetchingNextPage}
              >
                {log.isFetchingNextPage ? "Loading…" : "Show more"}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

const PAGE_SIZE = 50;

/** Stable identity while the first page is in flight, for EntryList's memo. */
const NO_ENTRIES: AuditLogEntryDto[] = [];
const NO_ACTORS: AuditActorDto[] = [];

// ---------------------------------------------------------------------------
// Filter state, which lives entirely in the URL
// ---------------------------------------------------------------------------

interface Filters {
  actions: string[];
  entityTypes: string[];
  actorIds: string[];
  /** yyyy-mm-dd, either end independently optional. */
  from: string | null;
  to: string | null;
}

/*
 * There were Today / 7 days / 30 days presets here.
 *
 * They were removed because they duplicated the scroll. This page is newest
 * first and loads more as you go, so "the last week" is already what the top of
 * it shows -- a button to narrow to it only took away the ability to keep
 * going. What is left is the case scrolling cannot answer: a window somewhere
 * back in the history, which is what an explicit from/to is for.
 */
function readFilters(params: URLSearchParams): Filters {
  return {
    actions: params.getAll("action"),
    entityTypes: params.getAll("entityType"),
    actorIds: params.getAll("actorId"),
    from: params.get("from"),
    to: params.get("to"),
  };
}

function countActive(filters: Filters): number {
  return (
    filters.actions.length +
    filters.entityTypes.length +
    filters.actorIds.length +
    (filters.from || filters.to ? 1 : 0)
  );
}

/**
 * The range as two instants, which is what the API compares against.
 *
 * The conversion happens here, in the browser, because `created_at` is a moment
 * and "yesterday" is a question about the reader's timezone -- the same reason
 * the special dates page starts its window from the browser's `todayIso()`
 * rather than the server's day. A `created_at::date between` on the server
 * would silently answer in UTC and be hours out for most of the world.
 *
 * `to` is local midnight *after* the last day wanted, and the API compares it
 * with `<`, so the final day is included whole.
 */
function resolveRange(filters: Filters): { fromInstant: string | null; toInstant: string | null } {
  return {
    fromInstant: filters.from ? startOfLocalDay(filters.from) : null,
    toInstant: filters.to ? startOfLocalDay(addDays(filters.to, 1)) : null,
  };
}

function startOfLocalDay(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year!, (month ?? 1) - 1, day ?? 1).toISOString();
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const shifted = new Date(year!, (month ?? 1) - 1, (day ?? 1) + days);
  return [
    shifted.getFullYear(),
    String(shifted.getMonth() + 1).padStart(2, "0"),
    String(shifted.getDate()).padStart(2, "0"),
  ].join("-");
}

// ---------------------------------------------------------------------------
// Filter UI
// ---------------------------------------------------------------------------

/**
 * One sheet at every width rather than a dialog on a phone and a row of
 * dropdowns on a desktop.
 *
 * `Modal` is already a bottom sheet below `md` and a centred dialog above it,
 * so this is one control tree instead of two -- and with thirty-odd actions to
 * choose from, checkbox groups with room to breathe beat four cramped selects
 * on a wide screen as well as on a narrow one. What keeps it discoverable is
 * that the count is on the button and every active filter is a chip on the
 * page, so nothing is hidden -- only the choosing is.
 */
function FilterSheet({
  filters,
  options,
  loading,
  selectedActors,
  onToggle,
  onCustomDate,
  onClear,
  onClose,
}: {
  filters: Filters;
  options: AuditLogFilterOptionsDto | undefined;
  loading: boolean;
  selectedActors: AuditActorDto[];
  onToggle: (key: string, value: string) => void;
  onCustomDate: (key: "from" | "to", value: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Filter the audit log" onClose={onClose}>
      {loading ? (
        <Spinner label="Loading filters" />
      ) : (
        <div className="space-y-6">
          <fieldset>
            <legend className="mb-2 font-bold text-ink">Custom dates</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="From">
                <input
                  type="date"
                  className={inputClass}
                  value={filters.from ?? ""}
                  onChange={(event) => onCustomDate("from", event.target.value)}
                />
              </Field>
              <Field label="To" hint="Included in full.">
                <input
                  type="date"
                  className={inputClass}
                  value={filters.to ?? ""}
                  onChange={(event) => onCustomDate("to", event.target.value)}
                />
              </Field>
            </div>
          </fieldset>

          <ActorFilter
            selected={selectedActors}
            onToggle={(appUserId) => onToggle("actorId", appUserId)}
          />

          <CheckboxGroup
            legend="What happened"
            empty="Nothing has been recorded yet."
            items={(options?.actions ?? []).map((action) => ({
              value: action,
              label: auditActionLabel(action),
            }))}
            selected={filters.actions}
            onToggle={(value) => onToggle("action", value)}
          />

          <CheckboxGroup
            legend="What it was about"
            empty="Nothing has been recorded yet."
            items={(options?.entityTypes ?? []).map((entityType) => ({
              value: entityType,
              label: auditEntityTypeLabel(entityType),
            }))}
            selected={filters.entityTypes}
            onToggle={(value) => onToggle("entityType", value)}
          />

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button onClick={onClose}>Done</Button>
            <Button variant="ghost" onClick={onClear}>
              Clear all
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * Who did it, by typing rather than by scrolling.
 *
 * A checkbox per account is fine for a parish of eighty and unusable for one of
 * ten thousand, and these accounts only accumulate -- every one that has ever
 * acted is on the list forever. This is the same typeahead as the "Married to"
 * picker, over `GET /api/audit/actors`, which returns only accounts appearing
 * in this log so it never offers a name whose filter would come back empty.
 *
 * Still multi-select. Picking adds a name and empties the box for the next one,
 * with what has been chosen underneath as removable chips -- a single-choice
 * picker would have quietly dropped the ability to ask about two people at once.
 *
 * Placed second in the sheet, above the checkbox groups, so the dropdown has
 * something to open over. Last -- where it started -- put it hard against the
 * sheet's bottom edge, and the sheet is an overflow-y-auto box, so the list was
 * clipped instead of scrolled to.
 */
function ActorFilter({
  selected,
  onToggle,
}: {
  selected: AuditActorDto[];
  onToggle: (appUserId: string) => void;
}) {
  const { organizationId } = useMe();
  const alreadyChosen = new Set(selected.map((actor) => actor.appUserId));

  return (
    <fieldset>
      <legend className="mb-2 font-bold text-ink">Who did it</legend>

      <LookupPicker
        label="Search the people who have made changes"
        emptyLabel="Nobody has been recorded yet"
        value={null}
        clearAfterPick
        onChange={(option) => {
          if (option) onToggle(option.id);
        }}
        queryKey={(term) => qk.auditActorLookup(organizationId, term)}
        fetchOptions={async (term, signal) => {
          const { actors } = await api<AuditActorLookupDto>("/audit/actors", {
            signal,
            query: { q: term },
          });
          return actors.flatMap((actor) =>
            // Whoever is already a chip is not offered again: picking a name
            // off a list should not toggle a filter back off.
            actor.appUserId && !alreadyChosen.has(actor.appUserId)
              ? [
                  {
                    id: actor.appUserId,
                    name: actorName(actor),
                    // Only when it is not already the name, so an account with
                    // no directory record does not show its address twice.
                    detail: actor.name ? actor.email : null,
                  },
                ]
              : []
          );
        }}
      />

      {selected.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {selected.map((actor) => (
            <li key={actor.appUserId}>
              <button
                type="button"
                onClick={() => actor.appUserId && onToggle(actor.appUserId)}
                className="tap-target inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-3 py-1 text-sm text-ink ring-1 ring-line hover:text-primary"
              >
                <span className="min-w-0 break-words">{actorName(actor)}</span>
                <span aria-hidden="true" className="text-ink-muted">
                  ×
                </span>
                <span className="sr-only">— remove this person</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

function CheckboxGroup({
  legend,
  empty,
  items,
  selected,
  onToggle,
}: {
  legend: string;
  empty: string;
  items: { value: string; label: string }[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-2 font-bold text-ink">{legend}</legend>
      {items.length === 0 ? (
        <p className="text-sm text-ink-muted">{empty}</p>
      ) : (
        // Two columns from `sm` up, because a parish's log grows to thirty-odd
        // actions and one column of those is a lot of scrolling in a sheet.
        <div className="grid gap-1 sm:grid-cols-2">
          {items.map((item) => (
            <label key={item.value} className="tap-target flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="h-4 w-4 shrink-0 accent-primary"
                checked={selected.includes(item.value)}
                onChange={() => onToggle(item.value)}
              />
              <span className="min-w-0 break-words">{item.label}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

/**
 * What is currently narrowing the list, on the page rather than behind the
 * button -- so nobody has to open the sheet to find out why the log looks
 * short, and each one can be taken off where it is.
 */
function ActiveChips({
  filters,
  actors,
  onRemove,
  onClearDates,
  onClearAll,
}: {
  filters: Filters;
  actors: AuditActorDto[];
  onRemove: (key: string, value: string) => void;
  onClearDates: () => void;
  onClearAll: () => void;
}) {
  const chips: { key: string; label: string; remove: () => void }[] = [];

  if (filters.from || filters.to) {
    chips.push({ key: "dates", label: dateRangeLabel(filters), remove: onClearDates });
  }
  for (const action of filters.actions) {
    chips.push({
      key: `action:${action}`,
      label: auditActionLabel(action),
      remove: () => onRemove("action", action),
    });
  }
  for (const entityType of filters.entityTypes) {
    chips.push({
      key: `entityType:${entityType}`,
      label: auditEntityTypeLabel(entityType),
      remove: () => onRemove("entityType", entityType),
    });
  }
  for (const actorId of filters.actorIds) {
    const actor = actors.find((candidate) => candidate.appUserId === actorId);
    chips.push({
      key: `actorId:${actorId}`,
      label: actor ? actorName(actor) : "Selected person",
      remove: () => onRemove("actorId", actorId),
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          onClick={chip.remove}
          className="tap-target inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-3 py-1 text-sm text-ink ring-1 ring-line hover:text-primary"
        >
          <span className="min-w-0 break-words">{chip.label}</span>
          <span aria-hidden="true" className="text-ink-muted">
            ×
          </span>
          <span className="sr-only">— remove this filter</span>
        </button>
      ))}
      <Button variant="ghost" onClick={onClearAll}>
        Clear all
      </Button>
    </div>
  );
}

function dateRangeLabel(filters: Filters): string {
  if (filters.from && filters.to) return `${filters.from} to ${filters.to}`;
  if (filters.from) return `From ${filters.from}`;
  return `Up to ${filters.to}`;
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

interface Day {
  key: string;
  entries: AuditLogEntryDto[];
}

/**
 * Grouped by the reader's calendar day, which is what makes a newest-first list
 * scannable -- forty timestamps in a column are forty things to read, and "18
 * entries under Tuesday" is one.
 */
function groupByDay(entries: AuditLogEntryDto[]): Day[] {
  const days: Day[] = [];
  for (const entry of entries) {
    const key = localDayKey(entry.createdAt);
    const current = days[days.length - 1];
    if (current && current.key === key) current.entries.push(entry);
    else days.push({ key, entries: [entry] });
  }
  return days;
}

function localDayKey(iso: string): string {
  const date = new Date(iso);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * Memoized against the grouped array, whose identity is stable because it comes
 * from a `useMemo` over the query cache. Without this, every tick of `useNow` --
 * once every thirty seconds, and this page accumulates every page it has
 * loaded -- would rebuild every card in the document.
 */
const EntryList = memo(function EntryList({
  days,
  now,
  isSuperAdmin,
}: {
  days: Day[];
  now: Date;
  isSuperAdmin: boolean;
}) {
  return (
    <div className="space-y-6">
      {days.map((day) => (
        <section key={day.key}>
          {/*
            Pinned under the app's own sticky header, so the day being read is
            always named. `top-0` would tuck it behind that header instead --
            hence the measured offset AppShell publishes.

            Sticky is scoped to the <section>, which is what makes each heading
            hand over to the next as its own day scrolls past.

            The gap to the first card is padding rather than a margin, so the
            opaque band covers it. As a margin it was a transparent strip under
            a pinned heading, and the card sliding up behind showed a sliver of
            its own border through it.
          */}
          <h2 className="sticky top-[var(--app-header-height)] z-10 bg-surface pb-3 pt-2 text-sm font-bold text-ink-muted">
            {formatRelativeDay(day.key) ?? formatDayLabel(day.key)}
          </h2>
          <ul className="space-y-2">
            {day.entries.map((entry) => (
              <li key={entry.id}>
                <EntryCard entry={entry} now={now} isSuperAdmin={isSuperAdmin} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
});

function EntryCard({
  entry,
  now,
  isSuperAdmin,
}: {
  entry: AuditLogEntryDto;
  now: Date;
  isSuperAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const absolute = new Date(entry.createdAt).toLocaleString();

  return (
    // min-w-0 so an expanded payload's long values stay inside the card instead
    // of stretching it and taking the page's horizontal scroll with them.
    <div className="min-w-0 rounded-lg border border-line bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="tap-target flex w-full items-start gap-3 p-4 text-left"
      >
        {/*
          Stacked on a phone; from `md` up the two halves sit on one row with
          the actor and time pushed to the right edge, which is what stops a
          wide monitor showing a column of text down its left third.
        */}
        <span className="flex min-w-0 flex-1 flex-col gap-1 md:flex-row md:items-baseline md:justify-between md:gap-4">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge tone={actionTone(entry.action)}>{auditActionLabel(entry.action)}</Badge>
            {/*
              Omitted rather than filled in with the entity type. The badge to
              its left already says "Special date added", so repeating "Special
              date" beside it is noise dressed up as information.
            */}
            {targetLabel(entry) && (
              <span className="min-w-0 break-words font-bold text-ink">{targetLabel(entry)}</span>
            )}
            {entry.unassignedOrganization && isSuperAdmin && <Badge>No parish</Badge>}
          </span>
          <span className="text-sm text-ink-muted md:shrink-0 md:text-right">
            {actorName(entry.actor)} ·{" "}
            <time dateTime={entry.createdAt} title={absolute}>
              {formatPostedAt(entry.createdAt, now)}
            </time>
          </span>
        </span>
        <span
          aria-hidden="true"
          className={`mt-1 shrink-0 text-ink-muted transition-transform ${open ? "rotate-90" : ""}`}
        >
          ›
        </span>
      </button>

      {open && (
        <div className="min-w-0 space-y-4 border-t border-line px-4 py-3">
          <AuditChanges changes={entry.changes} />
          <dl className="grid gap-x-6 gap-y-1 text-xs text-ink-muted sm:grid-cols-2">
            <div>
              <dt className="inline font-bold">When: </dt>
              <dd className="inline">{absolute}</dd>
            </div>
            <div>
              <dt className="inline font-bold">Action: </dt>
              <dd className="inline break-words">{entry.action}</dd>
            </div>
            <div>
              <dt className="inline font-bold">Type: </dt>
              <dd className="inline">{auditEntityTypeLabel(entry.entityType)}</dd>
            </div>
            {entry.entityId && (
              <div>
                <dt className="inline font-bold">Record: </dt>
                <dd className="inline break-all">{entry.entityId}</dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}

/**
 * Whose name to show, and what to say when there is none.
 *
 * `actor_app_user_id` is `on delete set null` and no copy of the name was kept
 * on the row, so a deleted account leaves its entries unattributed. Saying so
 * is the only honest option -- and better than an empty column, which reads as
 * a rendering bug rather than as the fact it is.
 */
function actorName(actor: AuditLogEntryDto["actor"]): string {
  return actor.name ?? actor.email ?? "A deleted account";
}

/**
 * `entity_id` is not a foreign key, on purpose, so that the trail outlives what
 * it describes. That makes a missing target ordinary rather than exceptional,
 * and it still says which kind of thing is missing.
 */
function targetLabel(entry: AuditLogEntryDto): string | null {
  if (entry.target.label) return entry.target.label;
  if (entry.target.missing) {
    return `${auditEntityTypeLabel(entry.entityType).toLowerCase()}, since deleted`;
  }
  // Nothing was pointed at in the first place, so there is nothing to name --
  // as opposed to `missing`, where something was and has since gone.
  return null;
}

/**
 * Colour by consequence, not by entity: something being removed is the thing a
 * reader is scanning for, and it should be the thing that catches the eye.
 */
function actionTone(action: string): "neutral" | "primary" | "accent" {
  if (/\.(delete|remove\w*|reject|deny)$/i.test(action)) return "primary";
  if (/\.(create|post|invite|add\w*|join|approve|merge)$/i.test(action)) return "accent";
  return "neutral";
}
