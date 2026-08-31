import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { PersonSummaryDto } from "@shared";
import { api } from "../lib/api";
import { useMe } from "../context/MeContext";
import { PersonCard } from "../components/PersonCard";
import { SearchField } from "../components/SearchField";
import { Button, EmptyState, ErrorNotice, PageHeading, Spinner } from "../components/ui";

interface Cursor {
  lastName: string | null;
  firstName: string;
  id: string;
}

interface Page {
  people: PersonSummaryDto[];
  nextCursor: Cursor | null;
}

/** Long enough that typing a name is one request, short enough to feel live. */
const DEBOUNCE_MS = 250;

/** "Show account holders only", carried in the URL beside ?q= -- see below. */
const ACCOUNT_HOLDERS_PARAM = "accountHoldersOnly";

/**
 * "Scrollable view of the entire directory, sorted by last name", together with
 * the search over it -- one page rather than two, because leaving the directory
 * to search the directory was a hop with nothing behind it.
 *
 * One column of cards on a phone, two from `md` and three from `lg`, inside the
 * shell's centred container so it does not stretch across a wide monitor.
 *
 * Browsing and searching hold separate state. Clearing the box then restores the
 * pages already loaded, and their cursor, rather than starting the scroll again.
 */
export function Directory() {
  const { organizationId } = useMe();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";

  /*
   * The filter lives in the URL, like the search, so both halves of "what am I
   * looking at" travel together in a link and survive a reload. There is no
   * separate copy of it in state: the URL is the one answer, exactly as it is
   * for `query`.
   */
  const accountHoldersOnly = params.get(ACCOUNT_HOLDERS_PARAM) === "true";

  // What the box shows, which has to keep up with typing. `query` is what has
  // been committed to the URL, and is what the results on screen correspond to.
  const [input, setInput] = useState(query);

  const [people, setPeople] = useState<PersonSummaryDto[]>([]);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [browseLoading, setBrowseLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  // null is "not searching"; an empty array is "searched, and nobody matched".
  const [results, setResults] = useState<PersonSummaryDto[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  /*
   * Merged into whatever is already in the query string rather than replacing
   * it, so ticking the box mid-search keeps the search.
   *
   * A push rather than a replace, unlike the debounced write below: this is one
   * deliberate click, so making the back button undo it is useful where making
   * it undo single letters would not be.
   */
  function toggleAccountHoldersOnly(next: boolean): void {
    setParams((prev) => {
      const updated = new URLSearchParams(prev);
      if (next) updated.set(ACCOUNT_HOLDERS_PARAM, "true");
      else updated.delete(ACCOUNT_HOLDERS_PARAM);
      return updated;
    });
  }

  /*
   * The same guard the search below uses, and for a reason the checkbox
   * introduces: "Show more" disables its own button while it is in flight but
   * not the checkbox, so toggling mid-page would otherwise append rows from the
   * old filter onto the freshly reloaded list and leave a cursor from the wrong
   * set behind. It covers switching organization mid-page too, which had the
   * same hole.
   */
  const browseRef = useRef(0);

  const load = useCallback(
    async (from: Cursor | null) => {
      browseRef.current += 1;
      const requestId = browseRef.current;

      let page: Page;
      try {
        // `undefined` rather than `false` when off: the serializer drops it, so
        // the param is simply absent, and `query` takes no booleans.
        page = await api<Page>("/directory", {
          query: {
            limit: 50,
            cursorLastName: from?.lastName ?? undefined,
            cursorFirstName: from?.firstName,
            cursorId: from?.id,
            accountHoldersOnly: accountHoldersOnly ? "true" : undefined,
          },
        });
      } catch (err) {
        // Superseded, so the request that replaced this one owns the screen --
        // including reporting its own failure. Staying quiet here leaves the
        // catch blocks in reload and loadMore as the only source of a message.
        if (browseRef.current !== requestId) return;
        throw err;
      }

      if (browseRef.current !== requestId) return;
      setPeople((prev) => (from ? [...prev, ...page.people] : page.people));
      setCursor(page.nextCursor);
    },
    [accountHoldersOnly]
  );

  const reload = useCallback(async () => {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      await load(null);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : "Could not load the directory");
    } finally {
      setBrowseLoading(false);
    }
  }, [load]);

  // Re-run when a super admin switches organization, and when the checkbox
  // moves -- `load` is rebuilt with the flag, so this reloads from no cursor,
  // which is also what resets the pages already accumulated. This loads even
  // while a search is on screen: one page of 50 is a cheap price for clearing
  // the box being instant.
  useEffect(() => {
    void reload();
  }, [reload, organizationId]);

  /*
   * Typing goes into the URL, debounced, so a search can be shared or
   * bookmarked and survives a refresh. `replace` rather than push: one history
   * entry per keystroke would make the back button an undo of single letters.
   *
   * The early return is load-bearing rather than defensive. `setParams` is
   * rebuilt whenever the URL changes, so this effect re-runs on the very write
   * it just made, and without the guard that is a loop.
   */
  useEffect(() => {
    const trimmed = input.trim();
    if (trimmed === query) return;

    // Clearing the box brings the list straight back instead of making someone
    // wait out a debounce for something already in memory.
    //
    // Only `q` is touched: this used to hand `setParams` a whole new object,
    // which wiped every other param, and the filter beside it would not have
    // survived a keystroke.
    const timer = setTimeout(
      () => {
        setParams(
          (prev) => {
            const updated = new URLSearchParams(prev);
            if (trimmed) updated.set("q", trimmed);
            else updated.delete("q");
            return updated;
          },
          { replace: true }
        );
      },
      trimmed === "" ? 0 : DEBOUNCE_MS
    );
    return () => clearTimeout(timer);
  }, [input, query, setParams]);

  // The box follows the URL back when history moves underneath it. Returning
  // the current value unchanged when the two already agree is what stops React
  // re-rendering mid-word and dropping the caret to the end.
  useEffect(() => {
    setInput((current) => (current.trim() === query ? current : query));
  }, [query]);

  /*
   * Results follow the URL, so there is no debounce here -- the URL already is
   * the debounced value. The counter guards against a slow earlier response
   * landing after a fast later one and overwriting it.
   */
  const requestRef = useRef(0);
  useEffect(() => {
    requestRef.current += 1;
    const requestId = requestRef.current;

    if (query === "") {
      setResults(null);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }

    setSearchLoading(true);
    setSearchError(null);
    api<{ people: PersonSummaryDto[] }>("/directory/search", {
      query: { q: query, accountHoldersOnly: accountHoldersOnly ? "true" : undefined },
    })
      .then((data) => {
        if (requestRef.current !== requestId) return;
        setResults(data.people);
      })
      .catch((err: unknown) => {
        if (requestRef.current !== requestId) return;
        setResults(null);
        setSearchError(err instanceof Error ? err.message : "The search failed");
      })
      .finally(() => {
        if (requestRef.current === requestId) setSearchLoading(false);
      });
  }, [query, organizationId, accountHoldersOnly]);

  async function loadMore(): Promise<void> {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      await load(cursor);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : "Could not load more people");
    } finally {
      setLoadingMore(false);
    }
  }

  const searching = query !== "";

  const subtitle = useMemo(() => {
    if (searching) {
      if (searchLoading || results === null) return undefined;
      return `${results.length} ${results.length === 1 ? "match" : "matches"}`;
    }
    if (browseLoading) return undefined;
    // Names what is being counted, so a number shrinking under the filter is
    // never left unexplained.
    const noun = accountHoldersOnly
      ? people.length === 1
        ? "account holder"
        : "account holders"
      : people.length === 1
        ? "person"
        : "people";
    return `${people.length} ${noun}, by last name`;
  }, [searching, searchLoading, results, browseLoading, people.length, accountHoldersOnly]);

  return (
    <>
      <PageHeading
        title="Directory"
        subtitle={subtitle}
        actions={<SearchField value={input} onChange={setInput} />}
        filters={
          <label className="tap-target inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={accountHoldersOnly}
              onChange={(event) => toggleAccountHoldersOnly(event.target.checked)}
            />
            <span className="whitespace-nowrap text-ink-muted">Show account holders only</span>
          </label>
        }
      />

      {/*
        Results change while you type, and the count above is a plain <p> no
        screen reader will read again. This is the announcement for it. Always
        mounted, because assistive tech is unreliable about live regions that
        appear at the same moment as their text, and left empty while a search
        is in flight so it does not talk over Spinner, which is a status too.
      */}
      <p role="status" className="sr-only">
        {searching && !searchLoading && results !== null
          ? `${
              results.length === 0
                ? `Nothing matches ${query}`
                : `${results.length} ${results.length === 1 ? "match" : "matches"} for ${query}`
            }${accountHoldersOnly ? " among account holders" : ""}`
          : ""}
      </p>

      {searching ? (
        <>
          {searchError && <ErrorNotice message={searchError} />}

          {searchError ? null : searchLoading || results === null ? (
            <Spinner label="Searching" />
          ) : results.length === 0 ? (
            <EmptyState title={`Nothing matches “${query}”`}>
              <p>
                Check the spelling, or try a shorter fragment.
                {accountHoldersOnly && " Only account holders are being searched."}
              </p>
              {accountHoldersOnly && (
                <p className="mt-3">
                  <Button variant="ghost" onClick={() => toggleAccountHoldersOnly(false)}>
                    Search everyone
                  </Button>
                </p>
              )}
            </EmptyState>
          ) : (
            <PersonGrid people={results} />
          )}
        </>
      ) : (
        <>
          {browseError && <ErrorNotice message={browseError} onRetry={() => void reload()} />}

          {browseLoading ? (
            <Spinner label="Loading the directory" />
          ) : people.length === 0 ? (
            // "Nobody here yet" would be a lie when the checkbox is what
            // emptied the list, so the way out is offered instead.
            accountHoldersOnly ? (
              <EmptyState title="No account holders">
                <p>Nobody in the directory has an app account yet.</p>
                <p className="mt-3">
                  <Button variant="ghost" onClick={() => toggleAccountHoldersOnly(false)}>
                    Show everyone
                  </Button>
                </p>
              </EmptyState>
            ) : (
              <EmptyState title="Nobody here yet">
                <p>Once an administrator adds people, they will appear here.</p>
              </EmptyState>
            )
          ) : (
            <>
              <PersonGrid people={people} />

              {cursor && (
                <div className="mt-6 flex justify-center">
                  <Button
                    variant="secondary"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? "Loading…" : "Show more"}
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

/**
 * Both branches render the same grid.
 *
 * Memoized as well as PersonCard: a keystroke re-renders this page 250ms before
 * the URL and the fetch catch up, and PersonCard's own memo only skips each
 * card's body -- the <li>/<PersonCard> elements around it would still be rebuilt,
 * a few hundred of them, since browsing accumulates every page it has loaded.
 * The arrays are held in state, so their identity is stable and this bails out.
 */
const PersonGrid = memo(function PersonGrid({ people }: { people: PersonSummaryDto[] }) {
  return (
    <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      {people.map((person) => (
        <li key={person.id}>
          <PersonCard person={person} />
        </li>
      ))}
    </ul>
  );
});
