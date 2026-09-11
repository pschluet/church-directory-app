import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, type ReactNode } from "react";
import type { MapDto } from "@shared";
import { renderWithProviders, testQueryClient } from "./utils";
import { MapView } from "../src/pages/MapView";

/**
 * The map page, with Google stubbed out.
 *
 * jsdom cannot render a real map and there is no point pretending, so
 * `@vis.gl/react-google-maps` and the clusterer are replaced with the thinnest
 * things that still let the page render its children. What is under test is
 * everything around the map: what gets fetched and when, who is warned about
 * what, and how the page behaves when there is no key or nowhere to centre.
 *
 * The first case is the one that matters most, and is a bug this file exists to
 * keep fixed: the page used to hold its payload for five minutes, so saving an
 * address and coming straight here showed the parish as it used to be, with
 * your own house missing.
 */

const api = vi.fn();
vi.mock("../src/lib/api", () => ({
  api: (...args: unknown[]) => api(...args),
  DEV_AUTH: false,
}));

const me = vi.fn();
vi.mock("../src/context/MeContext", () => ({
  useMe: () => me(),
}));

/**
 * How many times a `google.maps.Map` has been constructed.
 *
 * The billing invariant: a Dynamic Maps event is charged per
 * `new google.maps.Map()`, so entering full screen or opening a popover must
 * not remount this. Counted in the stub because nothing else can see it.
 */
let mapMounts = 0;

vi.mock("@vis.gl/react-google-maps", () => ({
  APIProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Map: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => {
    /*
     * An effect with no deps, not a ref callback. A ref callback here counted 2
     * for a single mount, because an inline callback is a new function every
     * render and React 19 reads that as detach-then-attach -- which is the very
     * behaviour these assertions exist to guard against, arriving first in the
     * instrument.
     */
    useEffect(() => {
      mapMounts += 1;
    }, []);

    return (
      <div data-testid="map">
        <button type="button" data-testid="map-background" onClick={onClick}>
          empty map
        </button>
        {children}
      </div>
    );
  },
  AdvancedMarker: ({
    children,
    title,
    onClick,
    ref,
  }: {
    children: ReactNode;
    title?: string;
    onClick?: () => void;
    // Forwarded, because a pin hands its marker to the popover as the thing to
    // anchor to -- without this the popover has nothing and never renders.
    ref?: React.Ref<HTMLButtonElement>;
  }) => (
    <button type="button" ref={ref} data-testid="marker" data-title={title} onClick={onClick}>
      {children}
    </button>
  ),
  InfoWindow: ({ children }: { children: ReactNode }) => (
    <div data-testid="popover">{children}</div>
  ),
  MapControl: ({ children }: { children: ReactNode }) => <>{children}</>,
  ControlPosition: { RIGHT_TOP: 3 },
  // Null, so `ThirtyMileView` and the clusterer effect both bail -- neither is
  // what this file is about.
  useMap: () => null,
}));

vi.mock("@googlemaps/markerclusterer", () => ({
  MarkerClusterer: class {
    addMarker() {}
    addMarkers() {}
    removeMarker() {}
    clearMarkers() {}
  },
}));

const CONFIGURED = {
  organizationId: "org-1",
  isAdmin: false,
  maps: { browserKey: "browser-key", mapId: "map-id" },
};

function mapDto(overrides: Partial<MapDto> = {}): MapDto {
  return {
    church: { latitude: 41.9, longitude: -87.7, formattedAddress: "1 Church St" },
    unmappedCount: 0,
    locations: [
      {
        placeId: "ChIJa",
        latitude: 41.94,
        longitude: -87.73,
        formattedAddress: "4129 W Newport Ave",
        occupants: [
          {
            /*
             * Two members, because a family is only sent as a family when two
             * or more of them live at the address -- one is sent as that
             * person. A one-member family here would be a payload the API
             * cannot produce, and it would quietly flip every pin in this file
             * to the individual's glyph and tint.
             */
            kind: "family",
            id: "fam-1",
            label: "Schlueter",
            members: [
              { id: "p1", firstName: "Paul", lastName: "Schlueter", thumbUrl: null },
              { id: "p2", firstName: "Anna", lastName: "Schlueter", thumbUrl: null },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("MapView", () => {
  beforeEach(() => {
    api.mockReset();
    me.mockReturnValue(CONFIGURED);
    mapMounts = 0;
  });

  it("asks for the pins again every time the page is opened", async () => {
    /*
     * The regression. A `staleTime` here meant a window in which the map showed
     * the parish as it used to be -- and because the pins depend on addresses,
     * family names, moves, merges, deletes, photos and the church address,
     * invalidating the key from all of them was never going to hold. So the
     * page does not hold the payload at all.
     */
    api.mockResolvedValue(mapDto());
    const queryClient = testQueryClient();

    const first = renderWithProviders(<MapView />, { queryClient });
    await screen.findByTestId("map");
    expect(api).toHaveBeenCalledTimes(1);
    first.unmount();

    renderWithProviders(<MapView />, { queryClient });
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  });

  it("draws one marker per address, plus the church", async () => {
    api.mockResolvedValue(mapDto());
    renderWithProviders(<MapView />);
    await screen.findByTestId("map");
    const titles = screen.getAllByTestId("marker").map((m) => m.dataset.title);
    expect(titles).toContain("4129 W Newport Ave");
    expect(titles).toContain("1 Church St");
  });

  it("does not draw a church that has no address saved", async () => {
    api.mockResolvedValue(mapDto({ church: null }));
    renderWithProviders(<MapView />);
    await screen.findByTestId("map");
    expect(screen.getAllByTestId("marker")).toHaveLength(1);
  });

  it("tells an admin the church address is missing, and links somewhere they can reach", async () => {
    // Settings, not Churches: that one is super-admin-only, so linking there
    // bounced every other administrator home from their own warning.
    me.mockReturnValue({ ...CONFIGURED, isAdmin: true });
    api.mockResolvedValue(mapDto({ church: null }));
    renderWithProviders(<MapView />);
    expect(await screen.findByText(/no church address is saved/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /add the church address/i })).toHaveAttribute(
      "href",
      "/settings"
    );
  });

  it("says nothing about it to a member, who can do nothing about it", async () => {
    api.mockResolvedValue(mapDto({ church: null }));
    renderWithProviders(<MapView />);
    await screen.findByTestId("map");
    expect(screen.queryByText(/no church address is saved/i)).not.toBeInTheDocument();
  });

  it("tells an admin how many people could not be placed", async () => {
    me.mockReturnValue({ ...CONFIGURED, isAdmin: true });
    api.mockResolvedValue(mapDto({ unmappedCount: 3 }));
    renderWithProviders(<MapView />);
    expect(await screen.findByText(/3 people have addresses/i)).toBeInTheDocument();
  });

  it("counts one unplaced person in the singular", async () => {
    me.mockReturnValue({ ...CONFIGURED, isAdmin: true });
    api.mockResolvedValue(mapDto({ unmappedCount: 1 }));
    renderWithProviders(<MapView />);
    expect(await screen.findByText(/one person has an address/i)).toBeInTheDocument();
  });

  it("says the map is unavailable when this deployment has no key", async () => {
    me.mockReturnValue({ ...CONFIGURED, maps: null });
    api.mockResolvedValue(mapDto());
    renderWithProviders(<MapView />);
    expect(await screen.findByText(/not available here/i)).toBeInTheDocument();
    expect(screen.queryByTestId("map")).not.toBeInTheDocument();
  });

  it("says there is nowhere to centre when nobody is placed and there is no church", async () => {
    // Rather than opening on {0, 0}, which is the Atlantic and looks like a
    // working map pointed at the wrong parish.
    api.mockResolvedValue(mapDto({ church: null, locations: [] }));
    renderWithProviders(<MapView />);
    expect(await screen.findByText(/nobody is on the map yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("map")).not.toBeInTheDocument();
  });

  it("reports a failure without pretending the parish is empty", async () => {
    api.mockRejectedValue(new Error("Could not load the map"));
    renderWithProviders(<MapView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the map");
  });

  describe("popovers", () => {
    it("opens on a pin and closes on the empty map", async () => {
      api.mockResolvedValue(mapDto());
      renderWithProviders(<MapView />);
      await screen.findByTestId("map");

      expect(screen.queryByTestId("popover")).not.toBeInTheDocument();

      const pin = screen
        .getAllByTestId("marker")
        .find((m) => m.dataset.title === "4129 W Newport Ave");
      await userEvent.click(pin as HTMLElement);
      expect(await screen.findByTestId("popover")).toBeInTheDocument();

      // Tapping empty map is the other way out, so somebody who misses the x
      // is never stuck with a bubble over the thing they wanted to look at.
      await userEvent.click(screen.getByTestId("map-background"));
      await waitFor(() => expect(screen.queryByTestId("popover")).not.toBeInTheDocument());
    });

    it("shows the family, its members and the address in one bubble", async () => {
      api.mockResolvedValue(mapDto());
      renderWithProviders(<MapView />);
      await screen.findByTestId("map");

      const pin = screen
        .getAllByTestId("marker")
        .find((m) => m.dataset.title === "4129 W Newport Ave");
      await userEvent.click(pin as HTMLElement);

      const popover = await screen.findByTestId("popover");
      expect(within(popover).getByRole("link", { name: "Schlueter" })).toHaveAttribute(
        "href",
        "/families/fam-1"
      );
      expect(within(popover).getByText("Paul, Anna")).toBeInTheDocument();
      // Once for the whole pin, because every occupant shares it.
      expect(within(popover).getAllByRole("link", { name: /4129 W Newport Ave/i })).toHaveLength(1);
    });

    it("shows somebody who is the only one of their family here as themselves", async () => {
      /*
       * The pin the API sends as `kind: "person"` even though they have a
       * family: the rest of the Popovs live elsewhere. So it is their name,
       * their record it links to, and the lighter tint rather than the
       * household's red -- and none of that is a decision this page makes, it
       * follows from the kind.
       */
      api.mockResolvedValue(
        mapDto({
          locations: [
            ...mapDto().locations,
            {
              placeId: "ChIJb",
              latitude: 41.95,
              longitude: -87.74,
              formattedAddress: "12 Elm St",
              occupants: [
                {
                  kind: "person",
                  id: "p9",
                  label: "Maria Popov",
                  members: [{ id: "p9", firstName: "Maria", lastName: "Popov", thumbUrl: null }],
                },
              ],
            },
          ],
        })
      );
      renderWithProviders(<MapView />);
      await screen.findByTestId("map");

      const markers = screen.getAllByTestId("marker");
      const household = markers.find((m) => m.dataset.title === "4129 W Newport Ave");
      const alone = markers.find((m) => m.dataset.title === "12 Elm St");

      // Two weights of one red: the household's and the lighter tint for
      // somebody on their own. The only coverage either has.
      expect(household!.querySelector(".bg-primary")).not.toBeNull();
      expect(alone!.querySelector(".bg-primary-light")).not.toBeNull();

      await userEvent.click(alone as HTMLElement);

      const popover = await screen.findByTestId("popover");
      expect(within(popover).getByRole("link", { name: "Maria Popov" })).toHaveAttribute(
        "href",
        "/people/p9"
      );
      // Nothing on this pin claims to be a household.
      expect(within(popover).queryByRole("link", { name: /families/ })).not.toBeInTheDocument();
    });

    it("does not remount the map to open one", async () => {
      // A remount is another billed Dynamic Maps event.
      api.mockResolvedValue(mapDto());
      renderWithProviders(<MapView />);
      await screen.findByTestId("map");
      expect(mapMounts).toBe(1);

      const pin = screen
        .getAllByTestId("marker")
        .find((m) => m.dataset.title === "4129 W Newport Ave");
      await userEvent.click(pin as HTMLElement);
      await screen.findByTestId("popover");

      expect(mapMounts).toBe(1);
    });
  });

  describe("full screen", () => {
    it("takes over the window and gives it back", async () => {
      api.mockResolvedValue(mapDto());
      renderWithProviders(<MapView />);
      const map = await screen.findByTestId("map");
      const container = map.parentElement as HTMLElement;

      expect(container.className).toContain("h-[60vh]");

      await userEvent.click(screen.getByRole("button", { name: "Enter full screen" }));
      expect(container.className).toContain("fixed");
      expect(container.className).toContain("inset-0");
      // Above the z-40 header, which it has to cover to be full screen at all.
      expect(container.className).toContain("z-50");

      await userEvent.click(screen.getByRole("button", { name: "Exit full screen" }));
      expect(container.className).toContain("h-[60vh]");
      expect(container.className).not.toContain("fixed");
    });

    it("leaves on Escape", async () => {
      api.mockResolvedValue(mapDto());
      renderWithProviders(<MapView />);
      await screen.findByTestId("map");

      await userEvent.click(screen.getByRole("button", { name: "Enter full screen" }));
      await userEvent.keyboard("{Escape}");
      expect(await screen.findByRole("button", { name: "Enter full screen" })).toBeInTheDocument();
    });

    it("stops the page scrolling underneath, and starts it again on the way out", async () => {
      api.mockResolvedValue(mapDto());
      renderWithProviders(<MapView />);
      await screen.findByTestId("map");

      await userEvent.click(screen.getByRole("button", { name: "Enter full screen" }));
      expect(document.body.style.overflow).toBe("hidden");

      await userEvent.click(screen.getByRole("button", { name: "Exit full screen" }));
      expect(document.body.style.overflow).not.toBe("hidden");
    });

    it("does not remount the map on the way in or out", async () => {
      // The whole reason this is a class swap rather than a different tree.
      api.mockResolvedValue(mapDto());
      renderWithProviders(<MapView />);
      await screen.findByTestId("map");
      expect(mapMounts).toBe(1);

      await userEvent.click(screen.getByRole("button", { name: "Enter full screen" }));
      await userEvent.click(screen.getByRole("button", { name: "Exit full screen" }));

      expect(mapMounts).toBe(1);
    });
  });
});
