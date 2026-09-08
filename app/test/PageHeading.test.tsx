import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageHeading } from "../src/components/ui";

/**
 * The page heading's three layouts.
 *
 * Worth pinning because it is shared by every page and the markup became a grid
 * to make room for `titleAction`. The two older arrangements have to come out
 * unchanged, and none of what matters is visible to a DOM assertion -- so these
 * cases check the structural facts the CSS depends on: what is a sibling of
 * what, and what spans the row.
 */
describe("PageHeading", () => {
  it("stacks the title and the actions by default", () => {
    render(<PageHeading title="Directory" actions={<button type="button">Do it</button>} />);
    // One column on a phone; `md:flex` spreads them from md up.
    const row = screen.getByRole("heading", { name: "Directory" }).parentElement?.parentElement;
    expect(row?.className).toContain("grid-cols-1");
  });

  it("keeps compact actions beside the title on a phone", () => {
    // A lone three-dots menu, which would otherwise get a row of its own and
    // open a page about saving space by wasting some.
    render(
      <PageHeading title="Haddad" compactActions actions={<button type="button">More</button>} />
    );
    const row = screen.getByRole("heading", { name: "Haddad" }).parentElement?.parentElement;
    expect(row?.className).toContain("grid-cols-[minmax(0,1fr)_auto]");
  });

  it("puts a titleAction level with the title, and drops actions to their own row", () => {
    render(
      <PageHeading
        title="Directory"
        titleAction={<a href="/map">Map View</a>}
        actions={<input type="search" aria-label="Search" />}
      />
    );

    const heading = screen.getByRole("heading", { name: "Directory" });
    const row = heading.parentElement?.parentElement;
    // Two columns, so the title and the action share the first line.
    expect(row?.className).toContain("grid-cols-[minmax(0,1fr)_auto]");

    // And the actions cell spans both columns, which is what wraps the search
    // box onto a full-width row underneath rather than squeezing it beside.
    const search = screen.getByRole("searchbox");
    expect(search.parentElement?.className).toContain("col-span-2");
  });

  it("does not nest a titleAction inside the actions row", () => {
    // The whole point: nested under the search box it would read as part of the
    // search, and it is a way to another page.
    render(
      <PageHeading
        title="Directory"
        titleAction={<a href="/map">Map View</a>}
        actions={<input type="search" aria-label="Search" />}
      />
    );
    const link = screen.getByRole("link", { name: "Map View" });
    const search = screen.getByRole("searchbox");
    expect(link.parentElement?.contains(search)).toBe(false);
    expect(search.parentElement?.contains(link)).toBe(false);
  });

  it("needs no second column when there is nothing to put in it", () => {
    render(<PageHeading title="Directory" />);
    const row = screen.getByRole("heading", { name: "Directory" }).parentElement?.parentElement;
    expect(row?.className).toContain("grid-cols-1");
  });

  it("still gives filters a row of their own under the title", () => {
    render(
      <PageHeading
        title="Directory"
        titleAction={<a href="/map">Map View</a>}
        filters={<span>Show account holders only</span>}
      />
    );
    const filter = screen.getByText("Show account holders only");
    // Outside the heading row entirely, so it stays left-aligned under the
    // title rather than being pulled right with the actions.
    const row = screen.getByRole("heading", { name: "Directory" }).parentElement?.parentElement;
    expect(row?.contains(filter)).toBe(false);
  });
});
