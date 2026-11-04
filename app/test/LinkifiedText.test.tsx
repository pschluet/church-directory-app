import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LinkifiedText } from "../src/components/LinkifiedText";

function renderText(text: string) {
  return render(
    <p data-testid="p">
      <LinkifiedText text={text} />
    </p>
  );
}

describe("LinkifiedText", () => {
  it("leaves text without an address as it was", () => {
    renderText("Please pray for my aunt.\nThank you.");
    expect(screen.getByTestId("p").textContent).toBe("Please pray for my aunt.\nThank you.");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("turns an address into a link that opens in a new tab", () => {
    renderText("Details at https://example.org/path?a=1&b=2 for everyone");
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://example.org/path?a=1&b=2");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByTestId("p").textContent).toBe(
      "Details at https://example.org/path?a=1&b=2 for everyone"
    );
  });

  it("leaves sentence punctuation and an unmatched paren outside the link", () => {
    renderText("See (https://example.org/x). Or http://example.com, ok?");
    const [first, second] = screen.getAllByRole("link");
    expect(first).toHaveAttribute("href", "https://example.org/x");
    expect(second).toHaveAttribute("href", "http://example.com");
    expect(screen.getByTestId("p").textContent).toBe(
      "See (https://example.org/x). Or http://example.com, ok?"
    );
  });

  it("keeps a paren that belongs to the address", () => {
    renderText("(see https://en.wikipedia.org/wiki/Saint_(disambiguation))");
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "https://en.wikipedia.org/wiki/Saint_(disambiguation)"
    );
  });

  it("links several addresses across lines", () => {
    renderText("https://a.example\nand\nhttps://b.example/long");
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "https://a.example",
      "https://b.example/long",
    ]);
    expect(screen.getByTestId("p").textContent).toBe(
      "https://a.example\nand\nhttps://b.example/long"
    );
  });

  it("never links anything but http(s)", () => {
    renderText("javascript:alert(1) ftp://example.org https://");
    expect(screen.queryByRole("link")).toBeNull();
  });
});
