import { useCallback, useEffect, useState } from "react";
import type { PersonSummaryDto } from "@shared";
import { api } from "../lib/api";
import { useMe } from "../context/MeContext";
import { PersonCard } from "../components/PersonCard";
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

/**
 * "Scrollable view of the entire directory, sorted by last name."
 *
 * One column of cards on a phone, two from `md` and three from `lg`, inside the
 * shell's centred container so it does not stretch across a wide monitor.
 */
export function BrowseDirectory() {
  const { organizationId } = useMe();
  const [people, setPeople] = useState<PersonSummaryDto[]>([]);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (from: Cursor | null) => {
    const page = await api<Page>("/directory", {
      query: {
        limit: 50,
        cursorLastName: from?.lastName ?? undefined,
        cursorFirstName: from?.firstName,
        cursorId: from?.id,
      },
    });
    setPeople((prev) => (from ? [...prev, ...page.people] : page.people));
    setCursor(page.nextCursor);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await load(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the directory");
    } finally {
      setLoading(false);
    }
  }, [load]);

  // Re-run when a super admin switches organization.
  useEffect(() => {
    void reload();
  }, [reload, organizationId]);

  async function loadMore(): Promise<void> {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      await load(cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more people");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <PageHeading
        title="Directory"
        subtitle={
          loading
            ? undefined
            : `${people.length} ${people.length === 1 ? "person" : "people"}, by last name`
        }
      />

      {error && <ErrorNotice message={error} onRetry={() => void reload()} />}

      {loading ? (
        <Spinner label="Loading the directory" />
      ) : people.length === 0 ? (
        <EmptyState title="Nobody here yet">
          <p>Once an administrator adds people, they will appear here.</p>
        </EmptyState>
      ) : (
        <>
          <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {people.map((person) => (
              <li key={person.id}>
                <PersonCard person={person} />
              </li>
            ))}
          </ul>

          {cursor && (
            <div className="mt-6 flex justify-center">
              <Button variant="secondary" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Show more"}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
