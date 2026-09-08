import { describe, expect, it } from "vitest";
import { groupIntoLocations, type MapPersonRow } from "../src/services/map";
import { fullName } from "../src/types";

/**
 * The grouping rule on its own, without a database.
 *
 * `api.map.test.ts` covers the same rule end to end, which is what proves the
 * SQL feeds it the right rows. These cases are for the shapes that are awkward
 * to seed and easy to get wrong -- a family with no name, ordering, a row set
 * with nothing in it.
 */

const options = { thumbUrl: (key: string | null) => (key ? `/photos/${key}` : null), fullName };

function row(overrides: Partial<MapPersonRow> & { id: string }): MapPersonRow {
  return {
    first_name: "Anon",
    last_name: null,
    family_id: null,
    family_name: null,
    photo_key: null,
    place_id: "ChIJa",
    formatted_address: "1 A St",
    latitude: 41,
    longitude: -87,
    ...overrides,
  };
}

describe("grouping people into pins", () => {
  it("returns nothing for nobody", () => {
    expect(groupIntoLocations([], options)).toEqual([]);
  });

  it("carries the address and coordinates from the first row at each pin", () => {
    const locations = groupIntoLocations(
      [
        row({
          id: "1",
          place_id: "ChIJb",
          formatted_address: "2 B St",
          latitude: 42,
          longitude: -88,
        }),
      ],
      options
    );
    expect(locations[0]).toMatchObject({
      placeId: "ChIJb",
      formattedAddress: "2 B St",
      latitude: 42,
      longitude: -88,
    });
  });

  it("falls back to a surname when a family has no name", () => {
    // Possible in principle, and a pin labelled with nothing is worse than a
    // guess that reads like one.
    const locations = groupIntoLocations(
      [row({ id: "1", family_id: "f1", family_name: null, last_name: "Popov" })],
      options
    );
    expect(locations[0]!.occupants[0]!.label).toBe("Popov family");
  });

  it("keeps the order the rows arrived in", () => {
    // The query sorts families by name and their members by `family_order`, so
    // a pin lists a household the way its own page does rather than in hash
    // order. This is the property that lets the sorting live entirely in SQL.
    const locations = groupIntoLocations(
      [
        row({ id: "1", family_id: "f2", family_name: "Antonov" }),
        row({ id: "2", family_id: "f1", family_name: "Zolotov" }),
      ],
      options
    );
    expect(locations[0]!.occupants.map((o) => o.label)).toEqual(["Antonov", "Zolotov"]);
  });

  it("passes each member's photo through", () => {
    const locations = groupIntoLocations(
      [row({ id: "1", family_id: "f1", family_name: "Popov", photo_key: "k" })],
      options
    );
    expect(locations[0]!.occupants[0]!.members[0]!.thumbUrl).toBe("/photos/k");
  });

  it("makes a person with no family their own single member", () => {
    // So the panel can build an avatar from the name parts without splitting a
    // joined string, which gets "Anna Maria Popov" wrong.
    const locations = groupIntoLocations(
      [row({ id: "p1", first_name: "Dmitri", last_name: "Volkov" })],
      options
    );
    expect(locations[0]!.occupants[0]).toEqual({
      kind: "person",
      id: "p1",
      label: "Dmitri Volkov",
      members: [{ id: "p1", firstName: "Dmitri", lastName: "Volkov", thumbUrl: null }],
    });
  });
});
