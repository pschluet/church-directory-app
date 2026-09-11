import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddressLink } from "../src/components/AddressLink";

/*
 * `setup.ts`'s global `matchMedia` stub is beside the point here: AddressLink
 * renders one DOM for both layouts and asks no media query, and the difference
 * between a bottom sheet and a centred dialog is Modal's, made in Tailwind.
 * What does have to be faked is the device, which is the user agent and the
 * touch count.
 */
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

const originalUserAgent = navigator.userAgent;
const originalTouchPoints = navigator.maxTouchPoints;

/** The device the member is holding; nothing else about it matters. */
function withDevice(userAgent: string, maxTouchPoints: number): void {
  // `vi.restoreAllMocks()` does not undo a defineProperty, so both are put back
  // by hand in afterEach.
  Object.defineProperty(navigator, "userAgent", { value: userAgent, configurable: true });
  Object.defineProperty(navigator, "maxTouchPoints", {
    value: maxTouchPoints,
    configurable: true,
  });
}

/** See the note in maps.test.ts: there is no localStorage under test. */
function fakeStorage(): void {
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => void entries.set(key, value),
      removeItem: (key: string) => void entries.delete(key),
    },
  });
}

const PERSON = {
  addressLine1: "4129 W Newport Ave",
  addressLine2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60641",
  country: null,
};

const APPLE_URL = "https://maps.apple.com/?q=4129%20W%20Newport%20Ave%2C%20Chicago%20IL%2060641";
/** What an iPhone gets: the only form iOS routes to the app on its own. */
const GOOGLE_APP_URL = "comgooglemaps://?q=4129%20W%20Newport%20Ave%2C%20Chicago%20IL%2060641";
const GOOGLE_URL =
  "https://www.google.com/maps/search/?api=1&query=4129%20W%20Newport%20Ave%2C%20Chicago%20IL%2060641";

beforeEach(fakeStorage);
afterEach(() => {
  withDevice(originalUserAgent, originalTouchPoints);
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("AddressLink", () => {
  it("goes straight to a map where there is nothing to choose between", async () => {
    withDevice(ANDROID, 5);
    render(<AddressLink person={PERSON} />);

    const link = screen.getByRole("link", { name: /open .* in google maps/i });
    expect(link).toHaveAttribute("href", GOOGLE_URL);
    // A tab, so a member who lands on a web map keeps the directory behind it.
    expect(link).toHaveAttribute("target", "_blank");
    // noreferrer so this page's URL, and the person's id in it, stays behind.
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(link).toHaveClass("tap-target");
    // No sheet, because a sheet with one option in it is a wasted tap.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("asks rather than guesses on an iPhone, where both apps are plausible", async () => {
    withDevice(IPHONE, 5);
    render(<AddressLink person={PERSON} />);

    // A button, not a link: the tap opens a question, and an href here would
    // have had to name one of the two maps.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: /open .* in a maps app/i });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("offers both apps, the certainly-installed one first", async () => {
    withDevice(IPHONE, 5);
    render(<AddressLink person={PERSON} />);
    await userEvent.click(screen.getByRole("button"));

    const dialog = screen.getByRole("dialog", { name: "Open in Maps" });
    expect(dialog).toBeInTheDocument();
    const choices = screen.getAllByRole("link");
    expect(choices.map((choice) => choice.textContent)).toEqual(["Apple Maps", "Google Maps"]);
    expect(choices[0]).toHaveAttribute("href", APPLE_URL);
    expect(choices[1]).toHaveAttribute("href", GOOGLE_APP_URL);
  });

  /*
   * Reported: choosing Google Maps on iOS opened an in-app browser that loaded
   * the web map and then bounced to the app. Only the app's own scheme gets
   * routed straight there, and it has no page to render in a tab -- while
   * Apple Maps keeps its tab, being claimed by Maps.app from anywhere.
   */
  it("sends Google to the app on an iPhone, with no tab to leave behind", async () => {
    withDevice(IPHONE, 5);
    render(<AddressLink person={PERSON} />);
    await userEvent.click(screen.getByRole("button"));

    const apple = screen.getByRole("link", { name: "Apple Maps" });
    const google = screen.getByRole("link", { name: "Google Maps" });
    expect(google).toHaveAttribute("href", GOOGLE_APP_URL);
    expect(google).not.toHaveAttribute("target");
    expect(apple).toHaveAttribute("href", APPLE_URL);
    expect(apple).toHaveAttribute("target", "_blank");
    // Not a consequence of the tab: it withholds the person's id either way.
    expect(apple).toHaveAttribute("rel", "noreferrer");
    expect(google).toHaveAttribute("rel", "noreferrer");
  });

  it("does the same for a remembered Google, not only from the sheet", async () => {
    // The path somebody who ticked the box takes, which the sheet never shows.
    localStorage.setItem("directory.mapsProvider", "google");
    withDevice(IPHONE, 5);
    render(<AddressLink person={PERSON} />);

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", GOOGLE_APP_URL);
    expect(link).not.toHaveAttribute("target");
  });

  it("puts focus in the sheet, because Modal does not", async () => {
    withDevice(IPHONE, 5);
    render(<AddressLink person={PERSON} />);
    await userEvent.click(screen.getByRole("button"));

    expect(screen.getByRole("link", { name: "Apple Maps" })).toHaveFocus();
  });

  it("hands focus back to the address when the sheet is dismissed", async () => {
    withDevice(IPHONE, 5);
    render(<AddressLink person={PERSON} />);
    const trigger = screen.getByRole("button", { name: /maps app/i });
    await userEvent.click(trigger);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // Or the next Tab starts from the top of the page.
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on Escape, which is Modal's own wiring", async () => {
    withDevice(IPHONE, 5);
    render(<AddressLink person={PERSON} />);
    await userEvent.click(screen.getByRole("button", { name: /maps app/i }));

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stops asking once somebody says to always use the app they pick", async () => {
    withDevice(IPHONE, 5);
    render(<AddressLink person={PERSON} />);
    await userEvent.click(screen.getByRole("button", { name: /maps app/i }));

    await userEvent.click(screen.getByRole("checkbox", { name: /always use the app i pick/i }));
    await userEvent.click(screen.getByRole("link", { name: "Apple Maps" }));

    // The sheet is gone and the address is now an ordinary link to the app that
    // was chosen -- no second question on the way to the second house.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", APPLE_URL);
  });

  it("keeps asking when the box is left alone", async () => {
    withDevice(IPHONE, 5);
    render(<AddressLink person={PERSON} />);
    await userEvent.click(screen.getByRole("button", { name: /maps app/i }));
    /*
     * Google opens in place on an iPhone now, and jsdom implements no
     * navigation -- following the href would log an unimplemented-navigation
     * error over a suite that is otherwise quiet. The handler under test has
     * already run by the time this cancels the default.
     */
    document.addEventListener("click", (event) => event.preventDefault(), { once: true });
    await userEvent.click(screen.getByRole("link", { name: "Google Maps" }));

    expect(screen.getByRole("button", { name: /maps app/i })).toBeInTheDocument();
  });

  it("ignores a remembered app the device cannot offer", async () => {
    // Apple Maps, chosen on a phone, then the directory opened on an Android
    // tablet: Google rather than a link to a web page nobody asked for.
    localStorage.setItem("directory.mapsProvider", "apple");
    withDevice(ANDROID, 5);
    render(<AddressLink person={PERSON} />);

    expect(screen.getByRole("link")).toHaveAttribute("href", GOOGLE_URL);
  });

  it("leaves an address with no street as text, so no tap claims to know where it is", async () => {
    withDevice(IPHONE, 5);
    render(<AddressLink person={{ city: "Chicago", state: "IL" }} />);

    expect(screen.getByText("Chicago IL")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders nothing when there is no address", () => {
    const { container } = render(<AddressLink person={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

/**
 * The address-string form, used by the map's pins.
 *
 * A pin is a place rather than a person, and two people at one house can have
 * typed the address differently — so the map hands over Google's own
 * `formatted_address` instead of six columns. Everything below the first two
 * lines of the component is the same code path, which is the point of the
 * change: the map gets this file's provider choice, its remembered preference
 * and its `noreferrer` for free.
 */
describe("AddressLink given an address string", () => {
  const GOOGLE_FORMATTED = "4129 W Newport Ave, Chicago, IL 60641, USA";

  beforeEach(() => {
    fakeStorage();
  });

  afterEach(() => {
    Object.defineProperty(navigator, "userAgent", {
      value: originalUserAgent,
      configurable: true,
    });
    Object.defineProperty(navigator, "maxTouchPoints", {
      value: originalTouchPoints,
      configurable: true,
    });
  });

  it("links it without needing a street line of its own", () => {
    /*
     * `hasMappableAddress` would refuse this: it looks for `addressLine1`, and
     * one formatted line has no parts. It does not need the check — a pin
     * exists because the address geocoded.
     */
    withDevice(ANDROID, 1);
    render(<AddressLink address={GOOGLE_FORMATTED} />);
    expect(screen.getByRole("link", { name: /Open .* in Google Maps/ })).toHaveAttribute(
      "href",
      "https://www.google.com/maps/search/?api=1&query=4129%20W%20Newport%20Ave%2C%20Chicago%2C%20IL%2060641%2C%20USA"
    );
  });

  it("shows the line as given, on one line", () => {
    withDevice(ANDROID, 1);
    render(<AddressLink address={GOOGLE_FORMATTED} />);
    expect(screen.getByText(GOOGLE_FORMATTED)).toBeInTheDocument();
  });

  it("still asks which map where both are plausible", async () => {
    withDevice(IPHONE, 5);
    render(<AddressLink address={GOOGLE_FORMATTED} />);

    await userEvent.click(screen.getByRole("button", { name: /Open .* in a maps app/ }));
    expect(await screen.findByRole("link", { name: "Apple Maps" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Google Maps" })).toBeInTheDocument();
  });

  it("withholds the referrer, as it does for a person", () => {
    // The page's URL carries a person's id, and the provider is already being
    // handed somebody's home address.
    withDevice(ANDROID, 1);
    render(<AddressLink address={GOOGLE_FORMATTED} />);
    expect(screen.getByRole("link", { name: /Google Maps/ })).toHaveAttribute("rel", "noreferrer");
  });
});
