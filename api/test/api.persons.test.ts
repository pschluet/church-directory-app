import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import {
  createFamily,
  createGeocode,
  createNonUserPerson,
  createOrganization,
  createUser,
  enableMapView,
  setPlaceId,
  type CreatedUser,
} from "./helpers/fixtures";

const hasDb = inject("hasDatabase");

describe.skipIf(!hasDb)("people and attribute inheritance", () => {
  const db = () => testDb();
  let orgId: string;
  let familyId: string;
  let otherFamilyId: string;
  let parent: CreatedUser;

  beforeEach(async () => {
    await resetTables();
    orgId = await createOrganization(db());
    familyId = await createFamily(db(), orgId, "Schlueter");
    otherFamilyId = await createFamily(db(), orgId, "Popov");
    parent = await createUser(db(), {
      organizationId: orgId,
      familyId,
      email: "parent@test.example",
      firstName: "Paul",
      lastName: "Schlueter",
    });
    await db().query(
      `update persons
          set email = 'paul@example.com', phone = '+13125551234',
              alt_phone = '+13125559999', address_line1 = '4129 W Newport Ave',
              city = 'Chicago', state = 'IL', postal_code = '60641'
        where id = $1`,
      [parent.personId]
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const as = (u: CreatedUser) => client(db(), { sub: u.cognitoSub, email: u.email });

  it("creates a family member with no account", async () => {
    const { status, body } = await as(parent).call("POST", "/api/persons", {
      firstName: "Anna",
      familyId,
    });
    expect(status).toBe(201);
    expect(body.appUserId).toBeNull();
    expect(body.familyName).toBe("Schlueter");
    expect(body.canEdit).toBe(true);
  });

  it("refuses to create someone in a family the caller is not in", async () => {
    const { status } = await as(parent).call("POST", "/api/persons", {
      firstName: "Ivan",
      familyId: otherFamilyId,
    });
    expect(status).toBe(403);
  });

  describe("inheritance", () => {
    let child: string;

    beforeEach(async () => {
      const created = await as(parent).call("POST", "/api/persons", {
        firstName: "Anna",
        familyId,
      });
      child = created.body.id;
    });

    it("serves the parent's values once inheritance is set", async () => {
      const { status, body } = await as(parent).call("PATCH", `/api/persons/${child}`, {
        inheritLastNameFromPersonId: parent.personId,
        inheritEmailFromPersonId: parent.personId,
        inheritPhoneFromPersonId: parent.personId,
        inheritAddressFromPersonId: parent.personId,
      });

      expect(status).toBe(200);
      expect(body.lastName).toBe("Schlueter");
      expect(body.email).toBe("paul@example.com");
      expect(body.phone).toBe("+13125551234");
      expect(body.city).toBe("Chicago");
      expect(body.inheritedFrom.address.name).toBe("Paul Schlueter");
    });

    it("follows the parent when the parent's value changes", async () => {
      await as(parent).call("PATCH", `/api/persons/${child}`, {
        inheritAddressFromPersonId: parent.personId,
      });
      await as(parent).call("PATCH", `/api/persons/${parent.personId}`, { city: "Evanston" });

      const { body } = await as(parent).call("GET", `/api/persons/${child}`);
      expect(body.city).toBe("Evanston");
    });

    it("restores the child's own value when inheritance is switched off", async () => {
      await as(parent).call("PATCH", `/api/persons/${child}`, {
        email: "anna@example.com",
        inheritEmailFromPersonId: parent.personId,
      });
      const inherited = await as(parent).call("GET", `/api/persons/${child}`);
      expect(inherited.body.email).toBe("paul@example.com");

      await as(parent).call("PATCH", `/api/persons/${child}`, {
        inheritEmailFromPersonId: null,
      });
      const own = await as(parent).call("GET", `/api/persons/${child}`);
      expect(own.body.email).toBe("anna@example.com");
    });

    it("refuses a source outside the family", async () => {
      const outsider = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: otherFamilyId,
        firstName: "Ivan",
      });
      const { status, body } = await as(parent).call("PATCH", `/api/persons/${child}`, {
        inheritEmailFromPersonId: outsider,
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/same family/i);
    });

    it("refuses to inherit from yourself", async () => {
      const { status, body } = await as(parent).call("PATCH", `/api/persons/${child}`, {
        inheritEmailFromPersonId: child,
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/from yourself/i);
    });

    it("refuses a chain, so no cycle can form", async () => {
      await as(parent).call("PATCH", `/api/persons/${child}`, {
        inheritEmailFromPersonId: parent.personId,
      });
      const second = await as(parent).call("POST", "/api/persons", {
        firstName: "Nikolai",
        familyId,
      });

      const { status, body } = await as(parent).call("PATCH", `/api/persons/${second.body.id}`, {
        inheritEmailFromPersonId: child,
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/already inherits/i);
    });

    it("drops inheritance when the child leaves the family", async () => {
      await as(parent).call("PATCH", `/api/persons/${child}`, {
        inheritAddressFromPersonId: parent.personId,
        inheritLastNameFromPersonId: parent.personId,
      });

      const { status } = await as(parent).call("PATCH", `/api/persons/${child}`, {
        familyId: otherFamilyId,
      });
      // Moving into a family the caller is not in is not allowed...
      expect(status).toBe(403);

      // ...but an admin can, and then the inheritance must be gone.
      const admin = await createUser(db(), {
        organizationId: orgId,
        role: "ADMIN",
        email: "admin@test.example",
      });
      const moved = await as(admin).call("PATCH", `/api/persons/${child}`, {
        familyId: otherFamilyId,
      });
      expect(moved.status).toBe(200);
      expect(moved.body.inheritedFrom).toEqual({});
      expect(moved.body.city).toBeNull();
    });

    it("cancels stale join requests when an admin moves someone", async () => {
      const admin = await createUser(db(), {
        organizationId: orgId,
        role: "ADMIN",
        email: "mover@test.example",
      });
      await db().query(
        `insert into family_join_requests (organization_id, family_id, person_id)
         values ($1, $2, $3)`,
        [orgId, familyId, child]
      );

      const moved = await as(admin).call("PATCH", `/api/persons/${child}`, {
        familyId: otherFamilyId,
      });
      expect(moved.status).toBe(200);

      const { rows } = await db().query<{ status: string }>(
        "select status from family_join_requests where person_id = $1",
        [child]
      );
      expect(rows.map((r) => r.status)).toEqual(["CANCELLED"]);
    });

    it("clears inheritance pointing at someone who is deleted", async () => {
      const sibling = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Nikolai",
      });
      await as(parent).call("PATCH", `/api/persons/${child}`, {
        inheritEmailFromPersonId: sibling,
      });

      const deleted = await as(parent).call("DELETE", `/api/persons/${sibling}`);
      expect(deleted.status).toBe(204);

      const { body } = await as(parent).call("GET", `/api/persons/${child}`);
      expect(body.inheritedFrom).toEqual({});
    });
  });

  describe("updates", () => {
    it("only writes the fields the request mentions", async () => {
      await as(parent).call("PATCH", `/api/persons/${parent.personId}`, { city: "Evanston" });
      const { body } = await as(parent).call("GET", `/api/persons/${parent.personId}`);
      expect(body.city).toBe("Evanston");
      // Untouched by the PATCH.
      expect(body.phone).toBe("+13125551234");
      expect(body.addressLine1).toBe("4129 W Newport Ave");
    });

    it("rejects a phone number that is not E.164", async () => {
      const { status } = await as(parent).call("PATCH", `/api/persons/${parent.personId}`, {
        phone: "312-555-1234",
      });
      expect(status).toBe(400);
    });
  });

  describe("deletion", () => {
    it("soft-deletes a family member with no account", async () => {
      const child = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Anna",
      });
      expect((await as(parent).call("DELETE", `/api/persons/${child}`)).status).toBe(204);
      expect((await as(parent).call("GET", `/api/persons/${child}`)).status).toBe(404);

      // Kept, not removed -- data is retained forever.
      const { rows } = await db().query<{ count: string }>(
        "select count(*) as count from persons where id = $1",
        [child]
      );
      expect(Number(rows[0]!.count)).toBe(1);
    });

    it("refuses to delete someone who has an account", async () => {
      const { status, body } = await as(parent).call("DELETE", `/api/persons/${parent.personId}`);
      expect(status).toBe(400);
      expect(body.error).toMatch(/disable the account/i);
    });

    it("refuses someone outside the family", async () => {
      const child = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Anna",
      });
      const stranger = await createUser(db(), {
        organizationId: orgId,
        familyId: otherFamilyId,
        email: "stranger@test.example",
      });

      expect((await as(stranger).call("DELETE", `/api/persons/${child}`)).status).toBe(403);
      expect((await as(parent).call("GET", `/api/persons/${child}`)).status).toBe(200);
    });

    it("lets an admin delete someone in a family they are not in", async () => {
      const child = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Anna",
      });
      const admin = await createUser(db(), {
        organizationId: orgId,
        role: "ADMIN",
        familyId: otherFamilyId,
        email: "admin@test.example",
      });

      expect((await as(admin).call("DELETE", `/api/persons/${child}`)).status).toBe(204);
    });

    /**
     * Reported: someone linked an anniversary to a profile they had keyed in
     * by hand, then deleted that profile as a duplicate once the real invite
     * was accepted. The link stayed on their own profile and answered "Person
     * not found" when followed.
     *
     * Both directions, because an anniversary is one row shown on two
     * profiles -- a fix that only cleared `related_person_id` would leave the
     * mirrored case broken.
     */
    it("removes an anniversary linking the deleted person to someone else", async () => {
      const spouse = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Sarah",
      });
      const created = await as(parent).call("POST", "/api/special-dates", {
        personId: parent.personId,
        type: "ANNIVERSARY",
        month: 6,
        day: 14,
        year: 2010,
        relatedPersonId: spouse,
      });
      expect(created.status).toBe(201);

      expect((await as(parent).call("DELETE", `/api/persons/${spouse}`)).status).toBe(204);

      // The page in the report: it still loads, and no longer offers the link.
      const { status, body } = await as(parent).call("GET", `/api/persons/${parent.personId}`);
      expect(status).toBe(200);
      expect(body.specialDates).toHaveLength(0);

      const { rows } = await db().query<{ count: string }>(
        "select count(*) as count from special_dates where type = 'ANNIVERSARY'"
      );
      expect(Number(rows[0]!.count)).toBe(0);
    });

    it("removes an anniversary the deleted person owned", async () => {
      const husband = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Ivan",
      });
      const wife = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Olga",
      });
      await as(parent).call("POST", "/api/special-dates", {
        personId: husband,
        type: "ANNIVERSARY",
        month: 6,
        day: 14,
        year: 2010,
        relatedPersonId: wife,
      });

      // Delete the half the row is stored against, not the related half.
      expect((await as(parent).call("DELETE", `/api/persons/${husband}`)).status).toBe(204);

      const { body } = await as(parent).call("GET", `/api/persons/${wife}`);
      expect(body.specialDates).toHaveLength(0);
    });

    it("keeps the deleted person's own birthday", async () => {
      const child = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Anna",
      });
      await as(parent).call("POST", "/api/special-dates", {
        personId: child,
        type: "BIRTHDAY",
        month: 5,
        day: 4,
      });

      expect((await as(parent).call("DELETE", `/api/persons/${child}`)).status).toBe(204);

      // Only an anniversary is shared with someone else, so only an
      // anniversary goes -- their own dates are retained forever.
      const { rows } = await db().query<{ count: string }>(
        "select count(*) as count from special_dates where person_id = $1",
        [child]
      );
      expect(Number(rows[0]!.count)).toBe(1);
    });
  });
});

/**
 * What a save does about the map.
 *
 * The rule worth pinning is that a `place_id` off the wire is a lookup key and
 * never a coordinate. `PERSON_WRITE_COLUMNS` contains `place_id` so that
 * Autocomplete's answer can reach the database, which is exactly what would
 * let a caller point their row at somebody else's house if the server did not
 * resolve it for itself.
 */
describe.skipIf(!hasDb)("addresses and the map", () => {
  const db = () => testDb();
  let orgId: string;
  let member: CreatedUser;
  /** For the two cases about families -- a member may not move themselves into one. */
  let orgAdmin: CreatedUser;

  beforeEach(async () => {
    await resetTables();
    orgId = await createOrganization(db());
    member = await createUser(db(), {
      organizationId: orgId,
      email: "member@test.example",
      firstName: "Member",
      lastName: "One",
    });
    orgAdmin = await createUser(db(), {
      organizationId: orgId,
      role: "ADMIN",
      email: "admin@test.example",
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const asMember = () => client(db(), { sub: member.cognitoSub, email: member.email });
  const asAdmin = () => client(db(), { sub: orgAdmin.cognitoSub, email: orgAdmin.email });

  async function storedPlaceId(personId: string): Promise<string | null> {
    const { rows } = await db().query<{ place_id: string | null }>(
      "select place_id from persons where id = $1",
      [personId]
    );
    return rows[0]?.place_id ?? null;
  }

  it("saves the address even though geocoding is unavailable", async () => {
    // GEOCODING_MODE=local, so nothing resolves. Refusing the write would tell
    // somebody their address is invalid when it is merely unplaceable.
    const res = await asMember().call("PATCH", `/api/persons/${member.personId}`, {
      addressLine1: "4129 W Newport Ave",
      city: "Chicago",
      state: "IL",
      postalCode: "60641",
    });
    expect(res.status).toBe(200);
    expect(res.body.addressLine1).toBe("4129 W Newport Ave");
    expect(res.body.placeId).toBeNull();
    // `not_configured` is nobody's fault, so there is nothing to warn about.
    expect(res.body.geocodeWarning).toBeUndefined();
  });

  it("ignores a place_id the caller made up", async () => {
    // Unresolvable, so it is dropped rather than stored -- which also keeps the
    // foreign key satisfied.
    const res = await asMember().call("PATCH", `/api/persons/${member.personId}`, {
      addressLine1: "4129 W Newport Ave",
      placeId: "ChIJtotally-invented",
    });
    expect(res.status).toBe(200);
    expect(await storedPlaceId(member.personId!)).toBeNull();
  });

  it("does not let a caller claim an address that already exists", async () => {
    // The attack this blocks: `geocoded_addresses` is shared across the
    // deployment, so a known place_id would otherwise be a way onto somebody
    // else's pin. It is only accepted because the parish has the map on and
    // the row is already resolved -- and even then only as itself.
    await enableMapView(db(), orgId);
    await createGeocode(db(), { placeId: "ChIJsomeone-elses-house" });

    const res = await asMember().call("PATCH", `/api/persons/${member.personId}`, {
      addressLine1: "4129 W Newport Ave",
      placeId: "ChIJsomeone-elses-house",
    });
    expect(res.status).toBe(200);
    // Resolved from the table without calling Google, because the coordinates
    // are already known. This is the cost saving that makes a family of five
    // one geocode instead of five -- and the reason the pin is shared.
    expect(await storedPlaceId(member.personId!)).toBe("ChIJsomeone-elses-house");
  });

  it("makes no attempt to geocode for a parish with the map switched off", async () => {
    await createGeocode(db(), { placeId: "ChIJknown" });
    const res = await asMember().call("PATCH", `/api/persons/${member.personId}`, {
      addressLine1: "4129 W Newport Ave",
      placeId: "ChIJknown",
    });
    expect(res.status).toBe(200);
    // Even a place_id already in the table is refused: a parish without a map
    // contributes nothing to the Google bill and stores no coordinates.
    expect(await storedPlaceId(member.personId!)).toBeNull();
  });

  it("leaves the pin alone on a write that does not mention the address", async () => {
    await enableMapView(db(), orgId);
    await createGeocode(db(), { placeId: "ChIJhome" });
    await setPlaceId(db(), member.personId!, "ChIJhome");

    const res = await asMember().call("PATCH", `/api/persons/${member.personId}`, {
      patronSaint: "St Nicholas",
    });
    expect(res.status).toBe(200);
    expect(await storedPlaceId(member.personId!)).toBe("ChIJhome");
  });

  it("keeps the pin when a person changes family", async () => {
    // Clearing the inheritance pointer is enough: the view then falls back to
    // this person's own address and their own place_id, which were written
    // together. Nulling the pin as well would take somebody with a perfectly
    // good address off the map for having changed family.
    await enableMapView(db(), orgId);
    await createGeocode(db(), { placeId: "ChIJownhome" });
    await setPlaceId(db(), member.personId!, "ChIJownhome");
    const destination = await createFamily(db(), orgId, "Popov");

    const res = await asAdmin().call("PATCH", `/api/persons/${member.personId}`, {
      familyId: destination,
    });
    expect(res.status).toBe(200);
    expect(await storedPlaceId(member.personId!)).toBe("ChIJownhome");
  });

  it("creates a person with an address and no pin when geocoding is off", async () => {
    const familyId = await createFamily(db(), orgId, "Schlueter");
    const res = await asAdmin().call("POST", "/api/persons", {
      firstName: "Nikolai",
      lastName: "Schlueter",
      familyId,
      addressLine1: "4129 W Newport Ave",
    });
    expect(res.status).toBe(201);
    expect(res.body.placeId).toBeNull();
  });
});
