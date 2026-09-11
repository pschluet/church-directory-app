import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { MapLocationDto } from "@shared";
import { renderWithProviders } from "./utils";
import { ChurchPopover, MapPopover } from "../src/components/MapPopover";

/**
 * What a tapped pin says.
 *
 * `InfoWindow` is stubbed to a plain div: its anchoring and auto-panning are
 * Google's, and jsdom has no map to anchor to. What is under test is the
 * content, which is the part that was specified — a photo and a name for a
 * person, a family name and a member preview for a household, and the address
 * once for the whole pin.
 */
vi.mock("@vis.gl/react-google-maps", () => ({
  InfoWindow: ({ children }: { children: ReactNode }) => (
    <div data-testid="popover">{children}</div>
  ),
}));

/** Two Schlueters and an unrelated lodger at one address. */
const FAMILY_AND_LODGER: MapLocationDto = {
  placeId: "ChIJlodger",
  latitude: 41.9445,
  longitude: -87.7325,
  formattedAddress: "4129 W Newport Ave, Chicago, IL 60641, USA",
  occupants: [
    {
      kind: "family",
      id: "fam-1",
      label: "Schlueter",
      members: [
        { id: "p1", firstName: "Paul", lastName: "Schlueter", thumbUrl: null },
        { id: "p2", firstName: "Anna", lastName: "Schlueter", thumbUrl: null },
      ],
    },
    {
      kind: "person",
      id: "p3",
      label: "Dmitri Volkov",
      members: [{ id: "p3", firstName: "Dmitri", lastName: "Volkov", thumbUrl: "/photos/d" }],
    },
  ],
};

const anchor = {} as google.maps.marker.AdvancedMarkerElement;

function render(location = FAMILY_AND_LODGER, onClose = vi.fn()) {
  renderWithProviders(<MapPopover location={location} anchor={anchor} onClose={onClose} />);
  return { onClose };
}

describe("MapPopover", () => {
  it("names a family and links to it", () => {
    render();
    expect(screen.getByRole("link", { name: "Schlueter" })).toHaveAttribute(
      "href",
      "/families/fam-1"
    );
  });

  it("previews who lives here, without claiming a total", () => {
    // The families list says "4 members — …". A pin cannot: `members` holds
    // whoever lives at *this* address, so a family with somebody elsewhere
    // would be described by a number that is true of the pin and false of the
    // family. The family name is the way to the rest of them.
    render();
    expect(screen.getByText("Paul, Anna")).toBeInTheDocument();
    expect(screen.queryByText(/members/i)).not.toBeInTheDocument();
  });

  it("overflows a long household the way the families list does", () => {
    render({
      ...FAMILY_AND_LODGER,
      occupants: [
        {
          kind: "family",
          id: "fam-1",
          label: "Schlueter",
          members: ["Paul", "Anna", "Nikolai", "Maria", "Boris"].map((firstName, i) => ({
            id: `p${i}`,
            firstName,
            lastName: "Schlueter",
            thumbUrl: null,
          })),
        },
      ],
    });
    expect(screen.getByText("Paul, Anna, Nikolai +2")).toBeInTheDocument();
  });

  it("shows a person with their photo and links to their record", () => {
    render();
    expect(screen.getByRole("link", { name: /Dmitri Volkov/ })).toHaveAttribute(
      "href",
      "/people/p3"
    );
    /*
     * Not `getByRole("img")`: Avatar renders `alt=""`, so the photo is
     * decorative and has no role. That is right — the name is immediately
     * beside it, and announcing both would say it twice.
     */
    expect(document.querySelector('img[src="/photos/d"]')).toBeInTheDocument();
  });

  it("does not let a photo open full screen from inside the bubble", () => {
    // `fullUrl` would make Avatar a button opening PhotoLightbox, which portals
    // to document.body -- outside this bubble, so any dismiss-on-outside-click
    // would fire the instant it opened. Enlarging belongs on the person's page.
    render();
    expect(screen.queryByRole("button", { name: /photo full screen/i })).not.toBeInTheDocument();
  });

  it("falls back to initials when a person has no photo", () => {
    render({
      ...FAMILY_AND_LODGER,
      occupants: [
        {
          kind: "person",
          id: "p3",
          label: "Dmitri Volkov",
          members: [{ id: "p3", firstName: "Dmitri", lastName: "Volkov", thumbUrl: null }],
        },
      ],
    });
    expect(screen.getByText("DV")).toBeInTheDocument();
  });

  it("gives a family names rather than faces, as the families list does", () => {
    // The requirement for a household is the name and a member preview. Four
    // avatars in a 288px bubble would be a different component.
    render();
    expect(document.querySelectorAll("img")).toHaveLength(1);
  });

  it("states the address once for the whole pin, as a link", () => {
    // Every occupant of a pin shares it, so saying it per household would say
    // it three times for a two-flat.
    render();
    const links = screen.getAllByRole("link", { name: /4129 W Newport Ave/i });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute(
      "href",
      "https://www.google.com/maps/search/?api=1&query=4129%20W%20Newport%20Ave%2C%20Chicago%2C%20IL%2060641%2C%20USA"
    );
  });

  it("keeps two families at one address apart", () => {
    /*
     * Empty `members` deliberately, which the API cannot send -- a family
     * exists here because somebody is in it, and needs two of them at the
     * address to be sent as a family at all. It is the one exercise of the
     * `names.length > 0` guard, which is what keeps a bare name from being
     * followed by an empty line if an older payload ever reaches a new bundle.
     */
    render({
      ...FAMILY_AND_LODGER,
      occupants: [
        { kind: "family", id: "f1", label: "Schlueter", members: [] },
        { kind: "family", id: "f2", label: "Popov", members: [] },
      ],
    });
    expect(screen.getByRole("link", { name: "Schlueter" })).toHaveAttribute("href", "/families/f1");
    expect(screen.getByRole("link", { name: "Popov" })).toHaveAttribute("href", "/families/f2");
  });

  it("closes", async () => {
    const { onClose } = render();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("names the pin for a screen reader, since Google's header is switched off", () => {
    render();
    expect(
      screen.getByRole("heading", { name: /People at 4129 W Newport Ave/i })
    ).toBeInTheDocument();
  });
});

describe("ChurchPopover", () => {
  it("names the parish and links its address", () => {
    // Its own component rather than a third kind of occupant: there is nobody
    // to link to and nothing to preview, because it is not somebody's home.
    renderWithProviders(
      <ChurchPopover
        name="All Saints Antiochian Orthodox Church"
        church={{ formattedAddress: "2415 W Foster Ave, Chicago, IL 60625, USA" }}
        anchor={anchor}
        onClose={vi.fn()}
      />
    );

    // By role, not text: the glyph's wrapper has the same text content as the
    // heading inside it, so `getByText` matches both.
    expect(
      screen.getByRole("heading", { name: "All Saints Antiochian Orthodox Church" })
    ).toBeInTheDocument();

    /*
     * And exactly once. The shell renders a screen-reader-only copy of its
     * label unless given a visible heading, and the church's label *is* its
     * visible heading -- so getting that wrong says the parish's name twice.
     * Asserting by role missed it, because the duplicate was a <p>.
     */
    const occurrences = (screen.getByTestId("popover").textContent ?? "").match(
      /All Saints Antiochian Orthodox Church/g
    );
    expect(occurrences).toHaveLength(1);
    expect(screen.getByRole("link", { name: /2415 W Foster Ave/i })).toHaveAttribute(
      "href",
      "https://www.google.com/maps/search/?api=1&query=2415%20W%20Foster%20Ave%2C%20Chicago%2C%20IL%2060625%2C%20USA"
    );
  });

  it("offers nobody to click through to", () => {
    // Nobody lives at the church, so a link to a person or a family here would
    // be a link to nothing.
    renderWithProviders(
      <ChurchPopover
        name="All Saints"
        church={{ formattedAddress: "2415 W Foster Ave" }}
        anchor={anchor}
        onClose={vi.fn()}
      />
    );
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", expect.stringContaining("google.com/maps"));
  });

  it("closes", async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <ChurchPopover
        name="All Saints"
        church={{ formattedAddress: "2415 W Foster Ave" }}
        anchor={anchor}
        onClose={onClose}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
