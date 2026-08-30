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

  it("gives the link a comfortable touch target", () => {
    render(<PhoneLink phone="+13125551234" />);
    // 44px minimum; the class is the mechanism.
    expect(screen.getByRole("link")).toHaveClass("tap-target");
  });
});
