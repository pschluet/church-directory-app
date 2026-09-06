import { useEffect, useId, useRef, useState } from "react";
import { useQuery, type QueryKey } from "@tanstack/react-query";
import { Field, inputClass } from "./ui";

/**
 * Choosing one thing out of a set too big to list, by typing.
 *
 * The combobox mechanics only -- open/close, the debounce, the arrow keys, the
 * WAI-ARIA wiring. What is being searched is the caller's business: it hands in
 * a query key and a fetch, so the matching happens on the server and the list
 * has no ceiling. `PersonPicker` is this over the directory; the audit log's
 * actor filter is this over the accounts that appear in the log.
 *
 * Extracted rather than copied because the fiddly parts here are the ones that
 * are easy to get subtly wrong -- selecting on mousedown because click fires
 * after blur, Enter belonging to the list rather than to the surrounding form,
 * an option that must not be focusable -- and each is a comment below that
 * should not have to be maintained twice.
 *
 * The list is deliberately a sibling of `Field` rather than a child: Field
 * wraps what it is given in a <label>, and a listbox inside a label means
 * clicking an option also fires the label's activation behaviour.
 */

export interface PickedOption {
  id: string;
  name: string;
  /** A second line under the name -- a family, an email address. */
  detail?: string | null;
}

/** Long enough that typing a name is one request, short enough to feel live. */
const DEBOUNCE_MS = 250;

const NO_RESULTS: PickedOption[] = [];

export function LookupPicker({
  label,
  hint,
  value,
  onChange,
  queryKey,
  fetchOptions,
  placeholder = "Start typing a name…",
  emptyLabel = "Nobody to choose from",
  /**
   * For a picker that adds to a list rather than holding one answer: the box
   * empties itself so the next name can be typed straight away, and what has
   * been chosen is shown by the caller instead.
   */
  clearAfterPick = false,
}: {
  label: string;
  hint?: string;
  value: PickedOption | null;
  onChange: (option: PickedOption | null) => void;
  /** Keyed on the debounced term, so a slow earlier answer cannot overwrite a fast later one. */
  queryKey: (term: string) => QueryKey;
  fetchOptions: (term: string, signal: AbortSignal) => Promise<PickedOption[]>;
  placeholder?: string;
  emptyLabel?: string;
  clearAfterPick?: boolean;
}) {
  const [query, setQuery] = useState(value?.name ?? "");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  /*
   * Debounced, like the directory's search box, but only as far as the term the
   * query is keyed on -- a slow earlier response can no longer land after a
   * fast later one, because the two are separate cache entries. That is what
   * the request counter here used to be for.
   */
  // `null` until the first pause after opening, which is what keeps the list
  // from asking for anything the moment the box is focused.
  const [term, setTerm] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setTerm(null);
      return;
    }
    const timer = setTimeout(() => setTerm(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, open]);

  const lookup = useQuery({
    queryKey: queryKey(term ?? ""),
    queryFn: ({ signal }) => fetchOptions(term ?? "", signal),
    enabled: open && term !== null,
  });

  // A failed lookup shows an empty list rather than an error: this is a
  // typeahead inside a form, and there is nowhere sensible to put a notice.
  const results = lookup.data ?? NO_RESULTS;
  const loading = open && lookup.isPending;

  // Whatever is on top of a fresh list is the one Enter picks.
  useEffect(() => {
    setActiveIndex(0);
  }, [lookup.data]);

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
    setQuery(clearAfterPick ? "" : (value?.name ?? ""));
  }

  function pick(option: PickedOption): void {
    onChange(option);
    setQuery(clearAfterPick ? "" : option.name);
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
        /*
         * Escape belongs to the list while the list is open, and nothing else.
         * `Modal` dismisses itself from a keydown listener on `document`, which
         * a preventDefault does not reach -- so one Escape used to close the
         * dropdown and the dialog around it together, throwing away everything
         * else the form had collected. Stopping propagation keeps the native
         * event from reaching that listener.
         */
        event.stopPropagation();
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
          {results.map((option, index) => (
            // An option must not be focusable: focus stays on the input and
            // aria-activedescendant points here, per the WAI-ARIA combobox
            // pattern. A tabIndex would put every match in the tab order.
            // biome-ignore lint/a11y/useFocusableInteractive: see above
            <div
              key={option.id}
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
                pick(option);
              }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <span className="font-bold text-ink">{option.name}</span>
              {option.detail && <span className="text-sm text-ink-muted">{option.detail}</span>}
            </div>
          ))}

          {results.length === 0 && (
            <p className="px-3 py-2 text-ink-muted">
              {loading
                ? "Searching…"
                : query.trim() === ""
                  ? emptyLabel
                  : `No one matches “${query.trim()}”`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
