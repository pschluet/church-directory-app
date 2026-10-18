import { useEffect, useId, useRef, useState } from "react";
import { useQuery, type QueryKey } from "@tanstack/react-query";
import { Field, inputClass } from "./ui";

/**
 * A text box that suggests, but does not insist.
 *
 * The sibling of `LookupPicker` for the opposite case: there the answer has to
 * be one of the options, here it is whatever is typed and the options are only
 * a nudge towards spellings other people have already used. So the value is the
 * text itself, there is no "chosen" state to keep in step with it, and an empty
 * or unmatched list is simply not shown.
 *
 * The fiddly parts are the same ones `LookupPicker` documents, and are done the
 * same way: selecting on mousedown because click fires after blur, Enter
 * belonging to the list only while an option is highlighted, Escape closing the
 * list without also closing the Modal around it, and options that are not
 * focusable.
 */

const DEBOUNCE_MS = 250;
const NO_SUGGESTIONS: string[] = [];

export function SuggestInput({
  label,
  hint,
  value,
  onChange,
  queryKey,
  fetchSuggestions,
  maxLength,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  /** Keyed on the debounced term, so a slow earlier answer cannot overwrite a later one. */
  queryKey: (term: string) => QueryKey;
  fetchSuggestions: (term: string, signal: AbortSignal) => Promise<string[]>;
  maxLength?: number;
}) {
  const [open, setOpen] = useState(false);
  // Whether the list is being navigated: Enter only belongs to it then.
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  // `null` until the first pause, so focusing the box asks for nothing.
  const [term, setTerm] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setTerm(null);
      return;
    }
    const timer = setTimeout(() => setTerm(value.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, open]);

  const lookup = useQuery({
    queryKey: queryKey(term ?? ""),
    queryFn: ({ signal }) => fetchSuggestions(term ?? "", signal),
    enabled: open && term !== null,
  });

  // A failed lookup shows no list: this is a nicety on a field that works without it.
  const typed = value.trim().toLowerCase();
  const suggestions = (lookup.data ?? NO_SUGGESTIONS).filter(
    (suggestion) => suggestion.toLowerCase() !== typed
  );
  const showList = open && suggestions.length > 0;

  useEffect(() => {
    setActiveIndex(-1);
  }, [lookup.data]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function pick(suggestion: string): void {
    onChange(suggestion);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (suggestions.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => {
        const from = index < 0 ? (step > 0 ? -1 : 0) : index;
        return (from + step + suggestions.length) % suggestions.length;
      });
      return;
    }
    if (event.key === "Enter") {
      // Only when an option is highlighted: otherwise Enter submits the form
      // with whatever has been typed, which is a perfectly good answer here.
      const active = showList ? suggestions[activeIndex] : undefined;
      if (active) {
        event.preventDefault();
        pick(active);
      }
      return;
    }
    if (event.key === "Escape") {
      if (showList) {
        event.preventDefault();
        // Stops the Modal's document-level keydown listener closing the whole
        // form along with the list. See LookupPicker.
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (event.key === "Tab") setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <Field label={label} hint={hint}>
        <input
          role="combobox"
          type="text"
          autoComplete="off"
          aria-label={label}
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          className={inputClass}
          maxLength={maxLength}
          value={value}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
      </Field>

      {showList && (
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute inset-x-0 z-20 mt-1 max-h-60 overflow-y-auto rounded-md border border-line bg-surface shadow-lg"
        >
          {suggestions.map((suggestion, index) => (
            // Not focusable: focus stays on the input and aria-activedescendant
            // points here, per the WAI-ARIA combobox pattern.
            // biome-ignore lint/a11y/useFocusableInteractive: see above
            <div
              key={suggestion}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              className={`tap-target flex cursor-pointer items-center px-3 py-2 text-ink ${
                index === activeIndex ? "bg-surface-muted" : ""
              }`}
              // Mousedown, not click: click fires after blur, by which point the
              // list has gone.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(suggestion);
              }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              {suggestion}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
