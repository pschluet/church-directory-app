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
    expect(choices[1]).toHaveAttribute("href", GOOGLE_URL);
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
