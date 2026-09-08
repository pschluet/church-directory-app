import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddressAutocomplete } from "../src/components/AddressAutocomplete";

/**
 * Address suggestions, and the session token that makes them free.
 *
 * The billing claim this file exists to pin: autocomplete requests carrying a
 * session token are billed under the session SKU, which is free without limit,
 * and only the single `fetchFields` that closes the session costs anything. A
 * token that is not shared, or is reused across sessions, silently moves the
 * typing onto the per-request SKU -- which would work perfectly and cost money.
 * Nothing about the UI would look different, so only a test notices.
 */

const maps = vi.fn();
vi.mock("../src/context/MeContext", () => ({
  useMe: () => maps(),
}));

/** Every session token minted, so the sharing can be asserted. */
let tokens: object[] = [];
let fetchSuggestions: ReturnType<typeof vi.fn>;
let fetchFields: ReturnType<typeof vi.fn>;
/** The `{ id }` each `new Place(...)` was constructed with. */
let placeConstructions: { id: string }[] = [];

const COMPONENTS = [
  { types: ["street_number"], longText: "4129", shortText: "4129" },
  { types: ["route"], longText: "West Newport Avenue", shortText: "W Newport Ave" },
  { types: ["locality"], longText: "Chicago", shortText: "Chicago" },
  { types: ["administrative_area_level_1"], longText: "Illinois", shortText: "IL" },
  { types: ["postal_code"], longText: "60641", shortText: "60641" },
  { types: ["country"], longText: "United States", shortText: "US" },
];

function stubPlaces(): void {
  fetchSuggestions = vi.fn(async () => ({
    suggestions: [
      {
        placePrediction: {
          placeId: "ChIJnewport",
          text: { toString: () => "4129 W Newport Ave, Chicago, IL 60641, USA" },
        },
      },
    ],
  }));

  fetchFields = vi.fn(async function (this: { id: string }) {
    Object.assign(this, {
      addressComponents: COMPONENTS,
      formattedAddress: "4129 W Newport Ave, Chicago, IL 60641, USA",
    });
    return { place: this };
  });

  class AutocompleteSessionToken {
    constructor() {
      tokens.push(this);
    }
  }

  class Place {
    id: string;
    fetchFields = fetchFields;
    constructor(options: { id: string }) {
      this.id = options.id;
      placeConstructions.push(options);
    }
  }

  const places = {
    AutocompleteSessionToken,
    Place,
    AutocompleteSuggestion: { fetchAutocompleteSuggestions: fetchSuggestions },
  };

  vi.stubGlobal("google", {
    maps: { importLibrary: vi.fn(async () => places) },
  });
}

describe("AddressAutocomplete", () => {
  beforeEach(() => {
    tokens = [];
    placeConstructions = [];
    maps.mockReturnValue({ maps: { browserKey: "browser-key", mapId: "map-id" } });
    stubPlaces();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function setup(onPick = vi.fn(), onChange = vi.fn()) {
    function Harness() {
      return <AddressAutocomplete value="4129 W New" onChange={onChange} onPick={onPick} />;
    }
    render(<Harness />);
    return { onPick, onChange };
  }

  it("renders a plain input when this parish has no key", () => {
    // Map View off, or no Google project. The field is still a field -- the
    // same shape as the absent-IntersectionObserver path in useInfiniteScroll.
    maps.mockReturnValue({ maps: null });
    render(<AddressAutocomplete value="4129 W New" onChange={() => {}} onPick={() => {}} />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("asks Google once the field has enough to go on", async () => {
    setup();
    await waitFor(() => expect(fetchSuggestions).toHaveBeenCalled());
    expect(fetchSuggestions.mock.calls[0]![0]).toMatchObject({ input: "4129 W New" });
  });

  it("asks for addresses rather than businesses", async () => {
    // Nobody lives at a dry cleaner, and a list of shops is noise in a field
    // asking where somebody lives.
    setup();
    await waitFor(() => expect(fetchSuggestions).toHaveBeenCalled());
    expect(fetchSuggestions.mock.calls[0]![0].includedPrimaryTypes).toEqual([
      "street_address",
      "premise",
      "subpremise",
    ]);
  });

  it("says nothing to Google for a query too short to mean anything", async () => {
    render(<AddressAutocomplete value="41" onChange={() => {}} onPick={() => {}} />);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(fetchSuggestions).not.toHaveBeenCalled();
  });

  it("offers what Google returned", async () => {
    setup();
    expect(
      await screen.findByRole("option", { name: /4129 W Newport Ave, Chicago/ })
    ).toBeInTheDocument();
  });

  it("fills every address field from the suggestion that was picked", async () => {
    const { onPick } = setup();
    const option = await screen.findByRole("option", { name: /4129 W Newport Ave/ });
    await userEvent.click(option);

    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(onPick.mock.calls[0]![0]).toEqual({
      addressLine1: "4129 West Newport Avenue",
      city: "Chicago",
      // Short form for the state, because a directory says IL rather than
      // Illinois and so does the postal service.
      state: "IL",
      postalCode: "60641",
      country: "United States",
      placeId: "ChIJnewport",
    });
  });

  it("shares one session token across the typing and the lookup that ends it", async () => {
    // The whole reason this feature is affordable. One token, passed to both.
    const { onPick } = setup();
    const option = await screen.findByRole("option", { name: /4129 W Newport Ave/ });
    await userEvent.click(option);
    await waitFor(() => expect(onPick).toHaveBeenCalled());

    expect(tokens).toHaveLength(1);
    expect(fetchSuggestions.mock.calls[0]![0].sessionToken).toBe(tokens[0]);
  });

  it("asks only for Essentials-tier fields", async () => {
    // Anything from a higher tier moves the closing call to a dearer SKU for
    // data this app never displays.
    const { onPick } = setup();
    await userEvent.click(await screen.findByRole("option", { name: /4129 W Newport Ave/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(fetchFields.mock.calls[0]![0].fields).toEqual([
      "addressComponents",
      "formattedAddress",
      "location",
      "id",
    ]);
  });

  it("closes the session against the place that was picked", async () => {
    const { onPick } = setup();
    await userEvent.click(await screen.findByRole("option", { name: /4129 W Newport Ave/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(placeConstructions).toEqual([{ id: "ChIJnewport" }]);
  });

  it("keeps the field usable when Google refuses", async () => {
    fetchSuggestions.mockRejectedValue(new Error("REQUEST_DENIED"));
    setup();
    await waitFor(() => expect(fetchSuggestions).toHaveBeenCalled());
    // No list, no crash, and the box still takes typing.
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("falls back to the text Google showed when the lookup fails", async () => {
    fetchFields.mockRejectedValue(new Error("timeout"));
    const { onPick, onChange } = setup();
    await userEvent.click(await screen.findByRole("option", { name: /4129 W Newport Ave/ }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange).toHaveBeenCalledWith("4129 W Newport Ave, Chicago, IL 60641, USA");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("moves through the list with the arrow keys", async () => {
    fetchSuggestions.mockResolvedValue({
      suggestions: [
        { placePrediction: { placeId: "a", text: { toString: () => "4129 A St" } } },
        { placePrediction: { placeId: "b", text: { toString: () => "4129 B St" } } },
      ],
    });
    setup();
    const input = await screen.findByRole("combobox");
    await screen.findByRole("option", { name: "4129 A St" });

    expect(screen.getByRole("option", { name: "4129 A St" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await userEvent.type(input, "{ArrowDown}");
    expect(screen.getByRole("option", { name: "4129 B St" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });
});
