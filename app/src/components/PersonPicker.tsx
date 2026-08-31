import { useEffect, useId, useRef, useState } from "react";
import type { PersonLookupDto } from "@shared";
import { api } from "../lib/api";
import { Field, inputClass } from "./ui";

/**
 * Choosing one person out of the parish by typing.
 *
 * The plain <select> this replaces listed everyone, which meant scrolling a
 * few hundred options -- a full-screen wheel on a phone -- and it was capped at
 * the first 200 people with nothing on screen to say so. Matching happens on
 * the server (`GET /api/directory/lookup`) rather than over a preloaded array,
 * which is what lifts that cap.
 *
 * The list is deliberately a sibling of `Field` rather than a child: Field
 * wraps what it is given in a <label>, and a listbox inside a label means
 * clicking an option also fires the label's activation behaviour.
 */

export interface PickedPerson {
  id: string;
  name: string;
}

/** Long enough that typing a name is one request, short enough to feel live. */
const DEBOUNCE_MS = 250;

export function PersonPicker({
  label,
  hint,
  value,
  onChange,
  excludePersonId,
  placeholder = "Start typing a name…",
}: {
  label: string;
  hint?: string;
  value: PickedPerson | null;
  onChange: (person: PickedPerson | null) => void;
  /** Whoever the picker is for, so they cannot be picked as their own partner. */
  excludePersonId?: string;
  placeholder?: string;
}) {
  const [query, setQuery] = useState(value?.name ?? "");
  const [results, setResults] = useState<PersonLookupDto[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  // Debounced, like the directory's search box. The counter guards against a slow earlier
  // response landing after a fast later one and overwriting it.
  const requestRef = useRef(0);
  useEffect(() => {
    if (!open) return;
    requestRef.current += 1;
    const requestId = requestRef.current;
    const timer = setTimeout(() => {
      setLoading(true);
      api<{ people: PersonLookupDto[] }>("/directory/lookup", {
        query: { q: query.trim(), exclude: excludePersonId },
      })
        .then((data) => {
          if (requestRef.current !== requestId) return;
          setResults(data.people);
          setActiveIndex(0);
        })
        .catch(() => {
          if (requestRef.current === requestId) setResults([]);
        })
        .finally(() => {
          if (requestRef.current === requestId) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, open, excludePersonId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, value?.name]);

  /** Leaving the box must never show a name that is not what is stored. */
  function close(): void {
    setOpen(false);
    setQuery(value?.name ?? "");
  }

  function pick(person: PersonLookupDto): void {
    onChange({ id: person.id, name: person.name });
    setQuery(person.name);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (results.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (index + step + results.length) % results.length);
      return;
    }
    if (event.key === "Enter") {
      // While the list is open Enter belongs to the list, not to the form the
      // picker sits in -- including when nothing matches, where submitting on
      // a name that was never chosen would be the worst outcome.
      if (!open) return;
      event.preventDefault();
      const active = results[activeIndex];
      if (active) pick(active);
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        close();
      }
      return;
    }
    if (event.key === "Tab" && open) setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <Field label={label} hint={hint}>
        <div className="relative">
          <input
            ref={inputRef}
            role="combobox"
            type="text"
            autoComplete="off"
            // Field wraps its children in a <label>, so without this the
            // accessible name would swallow the clear button's own label and
            // the hint: "Married to Clear Boris Popov A wedding anniversary...".
            aria-label={label}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && results[activeIndex] ? optionId(activeIndex) : undefined}
            className={`${inputClass} ${value ? "pr-10" : ""}`}
            placeholder={placeholder}
            value={query}
            onFocus={() => setOpen(true)}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
              // Typing over a chosen name un-chooses it, so the stored id can
              // never disagree with what the box says.
              if (value) onChange(null);
            }}
            onKeyDown={onKeyDown}
          />
          {value && (
            <button
              type="button"
              aria-label={`Clear ${value.name}`}
              className="absolute inset-y-0 right-0 flex items-center pr-3 text-xl leading-none text-ink-muted hover:text-primary"
              onClick={() => {
                onChange(null);
                setQuery("");
                setOpen(true);
                inputRef.current?.focus();
              }}
            >
              ×
            </button>
          )}
        </div>
      </Field>

      {open && (
        // Bounded and scrollable: the form this sits in is inside Modal, which
        // is itself an overflow-y-auto box and will clip a taller list.
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute inset-x-0 z-20 mt-1 max-h-60 overflow-y-auto rounded-md border border-line bg-surface shadow-lg"
        >
          {results.map((person, index) => (
            // An option must not be focusable: focus stays on the input and
            // aria-activedescendant points here, per the WAI-ARIA combobox
            // pattern. A tabIndex would put every match in the tab order.
            // biome-ignore lint/a11y/useFocusableInteractive: see above
            <div
              key={person.id}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              className={`tap-target flex cursor-pointer flex-col justify-center px-3 py-2 ${
                index === activeIndex ? "bg-surface-muted" : ""
              }`}
              // Selecting on mousedown, not click: click fires after blur, by
              // which point the list has closed and there is nothing to hit.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(person);
              }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <span className="font-bold text-ink">{person.name}</span>
              {person.familyName && (
                <span className="text-sm text-ink-muted">{person.familyName} family</span>
              )}
            </div>
          ))}

          {results.length === 0 && (
            <p className="px-3 py-2 text-ink-muted">
              {loading
                ? "Searching…"
                : query.trim() === ""
                  ? "Nobody to choose from"
                  : `No one matches “${query.trim()}”`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
