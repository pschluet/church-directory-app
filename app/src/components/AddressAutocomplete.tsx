import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useMe } from "../context/MeContext";
import { inputClass } from "./ui";

/**
 * The street line, with Google's suggestions under it.
 *
 * This exists so that an address is mappable *before* it is saved. The
 * alternative -- geocode on save and warn on failure -- is still here as the
 * fallback, because somebody will always paste an address or edit one field of
 * six, but it puts the discovery after the decision: you find out the address
 * cannot be placed once you have already typed it out.
 *
 * Costing, since the requirement guessed this would be too expensive. It is
 * not, and the reason is the session token below. Autocomplete requests carrying
 * one are billed under the *session* SKU, which is free without limit, and the
 * single `fetchFields` call that closes the session is Place Details Essentials
 * -- 10,000 free per month against a parish's few dozen address edits a year.
 * Without the token the same keystrokes are billed per request. So the token is
 * not an optimisation, it is the whole reason this is affordable, and it has to
 * be minted fresh after each selection or the next session silently reverts to
 * per-request billing.
 *
 * Degrades to a plain text input in four cases: this parish has Map View off,
 * the deployment has no key, the script is blocked, or the browser cannot run
 * it. The house style is to lose the enhancement and keep the field -- the same
 * shape as the absent-IntersectionObserver path in useInfiniteScroll.
 */

export interface PickedAddress {
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  placeId: string;
}

interface Suggestion {
  placeId: string;
  /** The whole address on one line, as Google formats it for a dropdown. */
  text: string;
}

/** Minimum characters before asking Google anything. */
const MIN_QUERY = 3;
const DEBOUNCE_MS = 250;

export function AddressAutocomplete({
  value,
  onChange,
  onPick,
  id,
  autoComplete = "address-line1",
}: {
  value: string;
  /** A keystroke. The caller clears its stored `placeId` on one of these. */
  onChange: (value: string) => void;
  /** A suggestion was chosen, and every address field is now known. */
  onPick: (address: PickedAddress) => void;
  id?: string;
  autoComplete?: string;
}) {
  const { maps } = useMe();
  const places = usePlacesLibrary(maps?.browserKey ?? null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;
  const boxRef = useRef<HTMLDivElement>(null);

  /*
   * One token spans the keystrokes and the `fetchFields` that ends them, which
   * is what makes the typing free. Held in a ref rather than state because
   * changing it must not re-render, and replaced only after a selection.
   */
  const sessionToken = useRef<google.maps.places.AutocompleteSessionToken | null>(null);

  const query = value.trim();

  useEffect(() => {
    if (!places || query.length < MIN_QUERY) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        sessionToken.current ??= new places.AutocompleteSessionToken();
        const { suggestions: found } =
          await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
            input: query,
            sessionToken: sessionToken.current,
            // Addresses, not businesses: nobody lives at a dry cleaner, and a
            // list of shops is noise in a field asking where somebody lives.
            includedPrimaryTypes: ["street_address", "premise", "subpremise"],
          });
        if (cancelled) return;
        setSuggestions(
          found
            .map((suggestion) => {
              const prediction = suggestion.placePrediction;
              if (!prediction?.placeId) return null;
              return { placeId: prediction.placeId, text: prediction.text?.toString() ?? "" };
            })
            .filter((s): s is Suggestion => s !== null)
        );
        setOpen(true);
      } catch {
        // A blocked script, a refused key, a quota. Leave the field alone --
        // the address still saves and the server still tries to geocode it.
        if (!cancelled) setSuggestions([]);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [places, query]);

  // Clicking away closes the list. A document listener rather than a backdrop,
  // the way AppShell's nav drawer does it -- a backdrop over a form field would
  // swallow the next click on the next field.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const choose = useCallback(
    async (suggestion: Suggestion) => {
      setOpen(false);
      if (!places) return;
      try {
        const place = new places.Place({ id: suggestion.placeId });
        await place.fetchFields({
          // Essentials-tier fields only. `addressComponents` is what fills the
          // other five inputs; asking for anything from a higher tier would
          // move this call to a dearer SKU for data nobody displays.
          fields: ["addressComponents", "formattedAddress", "location", "id"],
        });
        onPick(toPickedAddress(place, suggestion));
      } catch {
        // The session is spent either way, so fall back to the text Google
        // already showed rather than leaving the field half-filled.
        onChange(suggestion.text);
      } finally {
        // Spent. A reused token bills the next session per request.
        sessionToken.current = null;
      }
    },
    [places, onPick, onChange]
  );

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (!open || suggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter") {
      const suggestion = suggestions[activeIndex];
      if (suggestion) {
        // Otherwise Enter submits the form around this field, saving the
        // half-typed address instead of the one just highlighted.
        event.preventDefault();
        void choose(suggestion);
      }
    } else if (event.key === "Escape") {
      // Stopped here so it closes the list rather than the Modal the form is
      // usually inside -- the same reason LookupPicker stops it.
      event.stopPropagation();
      setOpen(false);
    }
  }

  if (!places) {
    return (
      <input
        id={id}
        type="text"
        className={inputClass}
        value={value}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  const showList = open && suggestions.length > 0;

  return (
    <div ref={boxRef} className="relative">
      <input
        id={id}
        role="combobox"
        type="text"
        // Off, because the browser's own address dropdown would sit on top of
        // this one and offer a different answer.
        autoComplete="off"
        className={inputClass}
        value={value}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          showList && suggestions[activeIndex] ? optionId(activeIndex) : undefined
        }
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
      />

      {showList && (
        <div
          id={listId}
          role="listbox"
          aria-label="Address suggestions"
          className="absolute inset-x-0 z-20 mt-1 max-h-60 overflow-y-auto rounded-md border border-line bg-surface shadow-lg"
        >
          {suggestions.map((suggestion, index) => (
            // An option must not be focusable: focus stays on the input and
            // aria-activedescendant points here, per the WAI-ARIA combobox
            // pattern -- the same as LookupPicker, for the same reason.
            // biome-ignore lint/a11y/useFocusableInteractive: see above
            <div
              key={suggestion.placeId}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              className={`tap-target flex cursor-pointer items-center px-3 py-2 text-sm text-ink ${
                index === activeIndex ? "bg-surface-muted" : ""
              }`}
              // On mousedown, not click: click fires after blur, by which point
              // the list has closed and there is nothing left to hit.
              onMouseDown={(event) => {
                event.preventDefault();
                void choose(suggestion);
              }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              {suggestion.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Google's address components, flattened into the six columns this app stores.
 *
 * `street_number` and `route` arrive separately and are the two halves of a
 * street line. `long_name` for most things and `short_name` for the state,
 * because a directory says "IL" rather than "Illinois" and the postal service
 * agrees.
 */
function toPickedAddress(place: google.maps.places.Place, suggestion: Suggestion): PickedAddress {
  const parts = new Map<string, { long: string; short: string }>();
  for (const component of place.addressComponents ?? []) {
    for (const type of component.types) {
      if (!parts.has(type)) {
        parts.set(type, { long: component.longText ?? "", short: component.shortText ?? "" });
      }
    }
  }
  const long = (type: string) => parts.get(type)?.long ?? "";
  const short = (type: string) => parts.get(type)?.short ?? "";

  const streetNumber = long("street_number");
  const route = long("route");
  const line1 = [streetNumber, route].filter(Boolean).join(" ");

  return {
    // If Google gives no street parts, keep what it showed in the dropdown
    // rather than blanking a field the user was happy with.
    addressLine1: line1 || (place.formattedAddress ?? suggestion.text).split(",")[0] || "",
    city: long("locality") || long("postal_town") || long("sublocality") || "",
    state: short("administrative_area_level_1"),
    postalCode: long("postal_code"),
    country: long("country"),
    placeId: place.id ?? suggestion.placeId,
  };
}

/**
 * Loads the Places library once and hands it back, or null.
 *
 * Hand-rolled rather than `@vis.gl/react-google-maps`'s `useMapsLibrary`,
 * because that hook requires an `<APIProvider>` ancestor and this component
 * lives inside person and organization forms -- wrapping the whole app in a
 * provider to autocomplete one field would load the Maps script on every page,
 * including for parishes with the map switched off.
 *
 * Null until it is ready, and null forever if it fails, which is what the
 * caller renders a plain input for.
 */
const SCRIPT_ID = "google-maps-places";

/**
 * The Maps bootstrap, if it has arrived.
 *
 * Read off `globalThis` rather than by naming `google` directly: before the
 * script lands -- and in jsdom, where it never does -- that identifier does not
 * exist, and touching it is a ReferenceError rather than undefined.
 */
function loadedMaps(): typeof google.maps | null {
  const g = (globalThis as { google?: { maps?: typeof google.maps } }).google;
  return g?.maps?.importLibrary ? g.maps : null;
}

function usePlacesLibrary(browserKey: string | null): typeof google.maps.places | null {
  const [places, setPlaces] = useState<typeof google.maps.places | null>(null);

  useEffect(() => {
    if (!browserKey) return;

    let cancelled = false;
    const importLibrary = async () => {
      try {
        const maps = loadedMaps();
        if (!maps) return;
        const library = (await maps.importLibrary("places")) as typeof google.maps.places;
        if (!cancelled) setPlaces(library);
      } catch {
        // Leave it null. The field is still a field.
      }
    };

    if (loadedMaps()) {
      void importLibrary();
      return () => {
        cancelled = true;
      };
    }

    /*
     * The bootstrap loader rather than a `<script src=...&libraries=places>`:
     * it is the only form that gives `importLibrary`, and it loads nothing
     * until something asks for a library -- so a page that renders this
     * component and is never typed into costs nothing.
     */
    let script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.async = true;
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
        browserKey
      )}&loading=async&v=weekly`;
      document.head.appendChild(script);
    }
    script.addEventListener("load", importLibrary);
    return () => {
      cancelled = true;
      script?.removeEventListener("load", importLibrary);
    };
  }, [browserKey]);

  return places;
}
