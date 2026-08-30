import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { PersonSummaryDto } from "@shared";
import { api } from "../lib/api";
import { PersonCard } from "../components/PersonCard";
import { EmptyState, ErrorNotice, PageHeading, Spinner, inputClass } from "../components/ui";

/**
 * "Search for users where the search contents match anything in any data
 * field." The query lives in the URL so a search can be shared or bookmarked.
 */
export function Search() {
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const [input, setInput] = useState(query);
  const [results, setResults] = useState<PersonSummaryDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the box in step when the URL changes underneath us (back button).
  useEffect(() => setInput(query), [query]);

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const trimmed = input.trim();
    if (trimmed === "") {
      setResults(null);
      setLoading(false);
      return;
    }

    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      api<{ people: PersonSummaryDto[] }>("/directory/search", { query: { q: trimmed } })
        .then((data) => setResults(data.people))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "The search failed"))
        .finally(() => setLoading(false));
    }, 250);

    return () => clearTimeout(timer);
  }, [input]);

  const summary = useMemo(() => {
    if (results === null) return undefined;
    return `${results.length} ${results.length === 1 ? "match" : "matches"}`;
  }, [results]);

  return (
    <>
      <PageHeading title="Search" subtitle={summary} />

      <form
        className="mb-6"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setParams(input.trim() ? { q: input.trim() } : {}, { replace: true });
          inputRef.current?.blur();
        }}
      >
        <label className="block">
          <span className="mb-1 block font-bold text-ink">
            Name, phone, email, address, patron saint…
          </span>
          <input
            ref={inputRef}
            className={inputClass}
            type="search"
            inputMode="search"
            autoComplete="off"
            placeholder="Try “Newport”, “555”, or a family name"
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
        </label>
        <p className="mt-1 text-sm text-ink-muted">
          Every word has to match somewhere, so extra words narrow the results.
        </p>
      </form>

      {error && <ErrorNotice message={error} />}

      {loading && <Spinner label="Searching" />}

      {!loading && results !== null && results.length === 0 && (
        <EmptyState title={`Nothing matches “${input.trim()}”`}>
          <p>Check the spelling, or try a shorter fragment.</p>
        </EmptyState>
      )}

      {!loading && results !== null && results.length > 0 && (
        <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {results.map((person) => (
            <li key={person.id}>
              <PersonCard person={person} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
