import type { MapLocationDto, MapOccupantDto } from "../types";

/**
 * Turning the parish into pins.
 *
 * The grouping rule, from the requirements: "If people share the exact same
 * address AND are in the same family, show only the family name (and some kind
 * of visual indicating that it's a family); if people share an address that
 * aren't in the same family, you must show all of those people (could be a
 * combination of multiple families, a family and an individual, etc.)"
 *
 * So an address yields one entry per family with two or more people here, plus
 * one entry per person who is the only one of theirs here. A house shared by
 * the Petrovs, the Ivanovs and a lodger is three entries -- not six people,
 * and not one address.
 *
 * "The only one of theirs here" is not the same as "has no family", and that
 * distinction is the second half of the rule. A family is a group, and a group
 * of one at an address has nothing to group: naming it would hang the family
 * glyph and a link to the whole household off a pin where one person lives. So
 * the one Petrov who lives at the flat while the rest of them are across town
 * is shown as himself, with his own name and his own photo, and his family is
 * one tap further on from his record -- the same route the directory takes.
 * Counted per address rather than per family, so he is an individual at the
 * flat and a Petrov at the house on the same map.
 *
 * Done here rather than in SQL. The collapse is two levels deep with a
 * conditional label and a nested member list, which in Postgres means
 * `json_agg` inside `json_agg` with a `filter` on each -- the least readable
 * query in this repo, and one that could only be tested with a database
 * attached. As a function it is directly unit-testable, and the input is a few
 * hundred rows rather than a few million.
 */

export interface MapPersonRow {
  id: string;
  first_name: string;
  last_name: string | null;
  family_id: string | null;
  family_name: string | null;
  photo_key: string | null;
  place_id: string;
  formatted_address: string;
  latitude: number;
  longitude: number;
}

export interface GroupOptions {
  /** `photoUrls(...).thumbUrl` from services/photos, injected so this stays pure. */
  thumbUrl: (photoKey: string | null) => string | null;
  /** `fullName` from types, injected for the same reason. */
  fullName: (person: { firstName: string; lastName: string | null }) => string;
}

export function groupIntoLocations(
  rows: MapPersonRow[],
  { thumbUrl, fullName }: GroupOptions
): MapLocationDto[] {
  const byPlace = new Map<string, MapPersonRow[]>();
  for (const row of rows) {
    const existing = byPlace.get(row.place_id);
    if (existing) existing.push(row);
    else byPlace.set(row.place_id, [row]);
  }

  const locations: MapLocationDto[] = [];

  for (const [placeId, occupants] of byPlace) {
    const first = occupants[0];
    if (!first) continue;

    /*
     * How many of each family live *here*, counted before any of them is
     * placed. A household of one at this address is shown as that person, and
     * a row on its own cannot say whether it is one: the rest of the family
     * may be further down this pin, or may be at another one entirely.
     */
    const familySizes = new Map<string, number>();
    for (const person of occupants) {
      if (!person.family_id) continue;
      familySizes.set(person.family_id, (familySizes.get(person.family_id) ?? 0) + 1);
    }

    /*
     * Insertion-ordered so the output follows the query's ORDER BY rather than
     * the iteration order of a plain object. The rows arrive sorted by name, so
     * a drawer lists families and people the way the directory would.
     */
    const families = new Map<string, MapOccupantDto>();
    const individuals: MapOccupantDto[] = [];

    for (const person of occupants) {
      const member = {
        id: person.id,
        firstName: person.first_name,
        lastName: person.last_name,
        thumbUrl: thumbUrl(person.photo_key),
      };
      const name = fullName({ firstName: person.first_name, lastName: person.last_name });

      /*
       * Two or more of them here makes a household; one makes an individual,
       * who goes in beside the people with no family at all. They keep their
       * place in the order for free -- the rows arrive sorted by family name
       * with nulls last, so a lone member still lands ahead of the lodgers.
       */
      if (person.family_id && (familySizes.get(person.family_id) ?? 0) > 1) {
        const family = families.get(person.family_id);
        if (family) {
          family.members.push(member);
        } else {
          families.set(person.family_id, {
            kind: "family",
            id: person.family_id,
            // A family with no name is possible in principle; falling back to
            // the surname beats a pin labelled with nothing.
            label: person.family_name ?? `${person.last_name ?? name} family`,
            members: [member],
          });
        }
      } else {
        individuals.push({ kind: "person", id: person.id, label: name, members: [member] });
      }
    }

    locations.push({
      placeId,
      latitude: first.latitude,
      longitude: first.longitude,
      formattedAddress: first.formatted_address,
      // Families first: they are the larger thing at the address, and a lodger
      // reads as an addition to a household rather than the other way round.
      occupants: [...families.values(), ...individuals],
    });
  }

  return locations;
}
