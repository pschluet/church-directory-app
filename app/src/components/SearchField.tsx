import { useRef } from "react";
import { inputClass } from "./ui";

/**
 * The search box in the directory heading.
 *
 * Presentational: the query lives on the page above, which debounces it into
 * the URL. Submitting only dismisses the phone keyboard -- by then the results
 * are already on screen, because typing is what runs the search.
 *
 * The magnifier is inline SVG rather than an icon package, as in PhoneLink and
 * InfoPopover; the app ships no icon dependency.
 */
export function SearchField({
  value,
  onChange,
  placeholder = "Search name, phone, address, saint…",
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <form
      role="search"
      className="w-full md:w-[26rem]"
      onSubmit={(event) => {
        event.preventDefault();
        inputRef.current?.blur();
      }}
    >
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-ink-muted">
          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">
            <path d="M8.5 3a5.5 5.5 0 1 0 3.4 9.83l3.63 3.64a1 1 0 0 0 1.42-1.42l-3.64-3.63A5.5 5.5 0 0 0 8.5 3Zm0 1.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z" />
          </svg>
        </span>
        <input
          ref={inputRef}
          type="search"
          inputMode="search"
          autoComplete="off"
          aria-label="Search the directory"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          /*
           * WebKit's own clear button is suppressed so there is exactly one "x"
           * on screen: ours, which is the only one the other browsers get.
           */
          className={`${inputClass} tap-target pl-9 pr-10 [&::-webkit-search-cancel-button]:appearance-none`}
        />
        {value !== "" && (
          <button
            type="button"
            aria-label="Clear search"
            className="tap-target absolute inset-y-0 right-0 flex items-center pr-3 text-xl leading-none text-ink-muted hover:text-primary"
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
        )}
      </div>
    </form>
  );
}
