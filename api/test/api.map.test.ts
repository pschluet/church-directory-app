import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import {
  createFamily,
  createGeocode,
  createNonUserPerson,
  createOrganization,
  createUser,
  enableMapView,
  setFamilyOrder,
  setInheritance,
  setPlaceId,
  type CreatedUser,
} from "./helpers/fixtures";
import type { MapDto } from "../src/types";

const hasDb = inject("hasDatabase");

/**
 * The map endpoint, and the grouping rule it exists to apply.
 *
 * "If people share the exact same address AND are in the same family, show only
 * the family name; if people share an address that aren't in the same family,
 * you must show all of those people." Most of these cases are that sentence,
 * because it is the one part of this feature with a wrong answer that would
 * look plausible: collapsing everybody at an address into one entry reads fine
 * until two families live in a two-flat.
 */
describe.skipIf(!hasDb)("map view", () => {
  const db = () => testDb();
  let orgId: string;
  let member: CreatedUser;

  beforeEach(async () => {
    await resetTables();
    orgId = await createOrganization(db());
    member = await createUser(db(), {
      organizationId: orgId,
      email: "member@test.example",
      firstName: "Member",
      lastName: "One",
    });
    await enableMapView(db(), orgId);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const asMember = () => client(db(), { sub: member.cognitoSub, email: member.email });

  async function getMap(): Promise<MapDto> {
    const res = await asMember().call("GET", "/api/map");
    expect(res.status).toBe(200);
    return res.body as MapDto;
  }

  it("collapses one family at one address to a single family entry", async () => {
    const familyId = await createFamily(db(), orgId, "Schlueter");
    await createGeocode(db(), { placeId: "ChIJnewport" });

    for (const firstName of ["Paul", "Anna", "Nikolai"]) {
      const id = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName,
        lastName: "Schlueter",
      });
      await setPlaceId(db(), id, "ChIJnewport");
    }

    const body = await getMap();
    expect(body.locations).toHaveLength(1);
    const [location] = body.locations;
    expect(location!.occupants).toHaveLength(1);
    expect(location!.occupants[0]).toMatchObject({ kind: "family", label: "Schlueter" });
    // The drawer needs everybody who lives there, even though the pin says one thing.
    expect(location!.occupants[0]!.members.map((m) => m.firstName).sort()).toEqual([
      "Anna",
      "Nikolai",
      "Paul",
    ]);
  });

  it("lists a household in the order its own family page does", async () => {
    /*
     * The map used to order everybody by surname, which put a pin's member
     * preview in a different order from the families list that previews the
     * same people -- and from the family page somebody had deliberately
     * dragged them into. Ordering is entirely in SQL; the grouper only
     * preserves it.
     */
    const familyId = await createFamily(db(), orgId, "Schlueter");
    await createGeocode(db(), { placeId: "ChIJordered" });

    const ids: Record<string, string> = {};
    for (const firstName of ["Anna", "Nikolai", "Paul"]) {
      const id = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName,
        lastName: "Schlueter",
      });
      ids[firstName] = id;
      await setPlaceId(db(), id, "ChIJordered");
    }

    // Deliberately not alphabetical: Paul, then Anna, then Nikolai.
    await setFamilyOrder(db(), [
      { personId: ids.Paul!, position: 0 },
      { personId: ids.Anna!, position: 1 },
      { personId: ids.Nikolai!, position: 2 },
    ]);

    const occupants = (await getMap()).locations[0]!.occupants;
    expect(occupants[0]!.members.map((m) => m.firstName)).toEqual(["Paul", "Anna", "Nikolai"]);
  });

  it("falls back to names for a family nobody has ordered", async () => {
    const familyId = await createFamily(db(), orgId, "Popov");
    await createGeocode(db(), { placeId: "ChIJunordered" });
    for (const firstName of ["Ivan", "Boris"]) {
      const id = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName,
        lastName: "Popov",
      });
      await setPlaceId(db(), id, "ChIJunordered");
    }

    const occupants = (await getMap()).locations[0]!.occupants;
    expect(occupants[0]!.members.map((m) => m.firstName)).toEqual(["Boris", "Ivan"]);
  });

  it("puts families in name order and people with no family after them", async () => {
    // The grouper concatenates families before individuals; this is the SQL
    // agreeing with it rather than the TypeScript carrying the rule alone.
    await createGeocode(db(), { placeId: "ChIJmixed" });
    const zolotov = await createFamily(db(), orgId, "Zolotov");
    const antonov = await createFamily(db(), orgId, "Antonov");
    for (const [familyId, firstName] of [
      [zolotov, "Zoya"],
      [antonov, "Anton"],
      [null, "Lodger"],
    ] as const) {
      const id = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName,
      });
      await setPlaceId(db(), id, "ChIJmixed");
    }

    const occupants = (await getMap()).locations[0]!.occupants;
    expect(occupants.map((o) => o.label)).toEqual(["Antonov", "Zolotov", "Lodger"]);
  });

  it("keeps two families at the same address separate", async () => {
    const schlueters = await createFamily(db(), orgId, "Schlueter");
    const popovs = await createFamily(db(), orgId, "Popov");
    await createGeocode(db(), { placeId: "ChIJtwoflat" });

    for (const [familyId, firstName, lastName] of [
      [schlueters, "Paul", "Schlueter"],
      [schlueters, "Anna", "Schlueter"],
      [popovs, "Ivan", "Popov"],
    ] as const) {
      const id = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName,
        lastName,
      });
      await setPlaceId(db(), id, "ChIJtwoflat");
    }

    const body = await getMap();
    expect(body.locations).toHaveLength(1);
    const occupants = body.locations[0]!.occupants;
    expect(occupants).toHaveLength(2);
    expect(occupants.map((o) => o.label).sort()).toEqual(["Popov", "Schlueter"]);
    expect(occupants.every((o) => o.kind === "family")).toBe(true);
  });

  it("lists a family and a lodger at the same address as two entries", async () => {
    const familyId = await createFamily(db(), orgId, "Schlueter");
    await createGeocode(db(), { placeId: "ChIJlodger" });

    const paul = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId,
      firstName: "Paul",
      lastName: "Schlueter",
    });
    const lodger = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId: null,
      firstName: "Dmitri",
      lastName: "Volkov",
    });
    await setPlaceId(db(), paul, "ChIJlodger");
    await setPlaceId(db(), lodger, "ChIJlodger");

    const occupants = (await getMap()).locations[0]!.occupants;
    expect(occupants).toHaveLength(2);
    // Families first: a lodger reads as an addition to a household.
    expect(occupants[0]).toMatchObject({ kind: "family", label: "Schlueter" });
    // A person is their own single member, so the panel has their name in
    // parts for an avatar.
    expect(occupants[1]).toMatchObject({ kind: "person", label: "Dmitri Volkov" });
    expect(occupants[1]!.members).toEqual([
      { id: expect.any(String), firstName: "Dmitri", lastName: "Volkov", thumbUrl: null },
    ]);
  });

  it("gives each distinct address its own pin", async () => {
    await createGeocode(db(), { placeId: "ChIJone", latitude: 41.1, longitude: -87.1 });
    await createGeocode(db(), { placeId: "ChIJtwo", latitude: 41.2, longitude: -87.2 });

    for (const [placeId, firstName] of [
      ["ChIJone", "Ivan"],
      ["ChIJtwo", "Olga"],
    ] as const) {
      const id = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: null,
        firstName,
      });
      await setPlaceId(db(), id, placeId);
    }

    const body = await getMap();
    expect(body.locations).toHaveLength(2);
    expect(body.locations.map((l) => l.placeId).sort()).toEqual(["ChIJone", "ChIJtwo"]);
  });

  it("puts somebody who inherits an address on the pin they inherited", async () => {
    const familyId = await createFamily(db(), orgId, "Schlueter");
    await createGeocode(db(), { placeId: "ChIJinherited" });

    const parent = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId,
      firstName: "Paul",
      lastName: "Schlueter",
    });
    await setPlaceId(db(), parent, "ChIJinherited");
    const child = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId,
      firstName: "Nikolai",
      lastName: "Schlueter",
    });
    // The child has no address and no place_id of their own; the view resolves both.
    await setInheritance(db(), child, { address: parent });

    const occupants = (await getMap()).locations[0]!.occupants;
    expect(occupants).toHaveLength(1);
    expect(occupants[0]!.members).toHaveLength(2);
  });

  it("excludes a soft-deleted person", async () => {
    await createGeocode(db(), { placeId: "ChIJgone" });
    const id = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId: null,
      firstName: "Departed",
    });
    await setPlaceId(db(), id, "ChIJgone");
    await db().query("update persons set deleted_at = now() where id = $1", [id]);

    expect((await getMap()).locations).toHaveLength(0);
  });

  it("excludes an address whose geocode has no coordinates", async () => {
    // A place_id Google stopped recognising keeps its row and loses its point.
    await createGeocode(db(), { placeId: "ChIJstale", latitude: null, longitude: null });
    const id = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId: null,
      firstName: "Nowhere",
    });
    await setPlaceId(db(), id, "ChIJstale");

    expect((await getMap()).locations).toHaveLength(0);
  });

  it("never shows another parish's people", async () => {
    const otherOrg = await createOrganization(db(), "St Nicholas", "st-nicholas");
    await enableMapView(db(), otherOrg);
    await createGeocode(db(), { placeId: "ChIJother" });
    const outsider = await createNonUserPerson(db(), {
      organizationId: otherOrg,
      familyId: null,
      firstName: "Outsider",
    });
    await setPlaceId(db(), outsider, "ChIJother");

    expect((await getMap()).locations).toHaveLength(0);
  });

  it("returns the church when its address has been geocoded", async () => {
    await createGeocode(db(), {
      placeId: "ChIJchurch",
      formattedAddress: "1 Church St, Chicago, IL, USA",
      latitude: 41.5,
      longitude: -87.5,
    });
    await enableMapView(db(), orgId, "ChIJchurch");

    expect((await getMap()).church).toEqual({
      latitude: 41.5,
      longitude: -87.5,
      formattedAddress: "1 Church St, Chicago, IL, USA",
    });
  });

  it("returns a null church rather than guessing when no address is saved", async () => {
    // The SPA falls back to the centroid and tells an admin why. Sending the
    // centroid as the church would hide the missing address behind a map that
    // looks approximately right.
    expect((await getMap()).church).toBeNull();
  });

  it("counts people whose address would not geocode", async () => {
    await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId: null,
      firstName: "Unplaceable",
    });
    await db().query(
      "update persons set address_line1 = '12 Nowhere Ln' where first_name = 'Unplaceable'"
    );
    // Somebody with no address at all is not missing a pin.
    await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId: null,
      firstName: "Addressless",
    });

    expect((await getMap()).unmappedCount).toBe(1);
  });

  it("is 404 for a parish with map view switched off", async () => {
    await db().query("update organizations set map_view_enabled = false where id = $1", [orgId]);
    const res = await asMember().call("GET", "/api/map");
    // 404 and not 403: this parish has no map page, and a 403 would send the
    // member off to ask for access nobody can grant them.
    expect(res.status).toBe(404);
  });

  it("is refused without a session", async () => {
    const res = await client(db(), null).call("GET", "/api/map");
    expect(res.status).toBe(401);
  });

  describe("what /api/me tells the SPA", () => {
    it("reports map view on, and no key because this deployment has none", async () => {
      const res = await asMember().call("GET", "/api/me");
      expect(res.status).toBe(200);
      expect(res.body.mapViewEnabled).toBe(true);
      // GEOCODING_MODE=local here. The two reasons for a null key -- no key on
      // the deployment, or the parish switched off -- are deliberately not
      // distinguished in the response; see the MeDto comment.
      expect(res.body.mapsBrowserKey).toBeNull();
      expect(res.body.mapsMapId).toBeNull();
    });

    it("reports map view off for a parish that has it disabled", async () => {
      await db().query("update organizations set map_view_enabled = false where id = $1", [orgId]);
      const res = await asMember().call("GET", "/api/me");
      expect(res.body.mapViewEnabled).toBe(false);
      expect(res.body.mapsBrowserKey).toBeNull();
    });
  });
});
