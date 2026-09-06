import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PhoneLink } from "../src/components/PhoneLink";

describe("PhoneLink", () => {
  it("emits a tel: href with the raw E.164 number so tapping dials", () => {
    render(<PhoneLink phone="+13125551234" label="Paul Schlueter" />);

    const link = screen.getByRole("link", { name: /call paul schlueter/i });
    // The dialer needs the unformatted number...
    expect(link).toHaveAttribute("href", "tel:+13125551234");
    // ...while the person reads the formatted one.
    expect(link).toHaveTextContent("(312) 555-1234");
  });

  it("renders nothing when there is no number", () => {
    const { container } = render(<PhoneLink phone={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("copies the number to the clipboard on desktop", async () => {
    render(<PhoneLink phone="+13125551234" />);
    await userEvent.click(screen.getByRole("button", { name: /copy phone number/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("+13125551234");
  });

  it("marks a search term in the number it shows", () => {
    render(<PhoneLink phone="+13125551234" terms={["1234"]} />);

    const link = screen.getByRole("link");
    expect(link.querySelector("mark")).toHaveTextContent("1234");
    // The accessible name and the href are the number, not the decoration.
    expect(link).toHaveAttribute("href", "tel:+13125551234");
    expect(link).toHaveTextContent("(312) 555-1234");
  });

  it("keeps the label in a single element, so its spaces survive", () => {
    render(<PhoneLink phone="+13125551234" terms={["555"]} />);

    /*
     * The anchor is `inline-flex`, so anything directly inside it is its own
     * anonymous flex item -- a block container, which trims its own trailing
     * whitespace. Marking "555" would otherwise split the label into three
     * items and paint "(312)555-0140". jsdom does no layout and textContent is
     * blind to it, so the invariant is structural: one span, plus the copy
     * button.
     */
    const link = screen.getByRole("link");
    expect([...link.children].map((child) => child.tagName)).toEqual(["SPAN"]);
    expect(link.firstElementChild?.querySelectorAll("mark")).toHaveLength(1);
  });

  it("gives the link a comfortable touch target", () => {
    render(<PhoneLink phone="+13125551234" />);
    // 44px minimum; the class is the mechanism.
    expect(screen.getByRole("link")).toHaveClass("tap-target");
  });
});
