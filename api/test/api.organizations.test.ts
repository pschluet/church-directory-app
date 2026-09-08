import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import { createOrganization, createUser, type CreatedUser } from "./helpers/fixtures";
import type { OrganizationDto } from "../src/types";

const hasDb = inject("hasDatabase");

/**
 * Organizations, and specifically who may change what about them.
 *
 * The interesting boundary is `mapViewEnabled`. An admin has to be able to set
 * their parish's church address -- they are the one the map warns about it, and
 * a warning about something only a super admin can fix is a dead end -- but
 * that switch starts a billable Google integration, so it stays a super
 * admin's. The two live on different routes with different schemas, and these
 * cases are what stop them merging back together by accident.
 */
describe.skipIf(!hasDb)("organizations", () => {
  const db = () => testDb();
  let orgId: string;
  let superAdmin: CreatedUser;
  let admin: CreatedUser;
  let user: CreatedUser;

  beforeEach(async () => {
    await resetTables();
    orgId = await createOrganization(db());
    superAdmin = await createUser(db(), {
      organizationId: orgId,
      role: "SUPER_ADMIN",
      email: "super@test.example",
    });
    admin = await createUser(db(), {
      organizationId: orgId,
      role: "ADMIN",
      email: "admin@test.example",
    });
    user = await createUser(db(), { organizationId: orgId, email: "user@test.example" });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const as = (who: CreatedUser) => client(db(), { sub: who.cognitoSub, email: who.email });

  const CHURCH = {
    addressLine1: "1 Church St",
    addressLine2: null,
    city: "Chicago",
    state: "IL",
    postalCode: "60641",
    country: "USA",
    placeId: null,
  };

  async function readOrg(): Promise<OrganizationDto> {
    const res = await as(superAdmin).call("GET", "/api/organizations");
    const found = (res.body.organizations as OrganizationDto[]).find((o) => o.id === orgId);
    expect(found).toBeDefined();
    return found as OrganizationDto;
  }

  it("starts every parish with map view switched off", async () => {
    // Off is the default because this flag is the one lever that reliably
    // drives the Google bill, so switching it on should be a decision.
    expect((await readOrg()).mapViewEnabled).toBe(false);
  });

  it("lets a super admin switch map view on", async () => {
    const res = await as(superAdmin).call("PATCH", `/api/organizations/${orgId}`, {
      name: "All Saints",
      slug: "all-saints",
      mapViewEnabled: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.mapViewEnabled).toBe(true);
  });

  it("leaves map view alone when a caller does not mention it", async () => {
    await db().query("update organizations set map_view_enabled = true where id = $1", [orgId]);
    // Absent means "leave it as it is", not "switch it off" -- a caller written
    // before the map existed sends neither field.
    const res = await as(superAdmin).call("PATCH", `/api/organizations/${orgId}`, {
      name: "All Saints Renamed",
      slug: "all-saints",
    });
    expect(res.status).toBe(200);
    expect(res.body.mapViewEnabled).toBe(true);
  });

  it("lets an admin set their own parish's church address", async () => {
    const res = await as(admin).call("PATCH", "/api/organizations/current", CHURCH);
    expect(res.status).toBe(200);
    expect(res.body.organization).toMatchObject({
      addressLine1: "1 Church St",
      city: "Chicago",
      state: "IL",
    });
  });

  it("does not let an admin switch map view on through the address route", async () => {
    // The narrower schema is the guard: `mapViewEnabled` is not a key it knows,
    // so posting it changes nothing rather than being trusted.
    const res = await as(admin).call("PATCH", "/api/organizations/current", {
      ...CHURCH,
      mapViewEnabled: true,
    });
    expect(res.status).toBe(200);
    expect((await readOrg()).mapViewEnabled).toBe(false);
  });

  it("does not let an admin rename their parish through the address route", async () => {
    const res = await as(admin).call("PATCH", "/api/organizations/current", {
      ...CHURCH,
      name: "Renamed By An Admin",
      slug: "renamed",
    });
    expect(res.status).toBe(200);
    const org = await readOrg();
    expect(org.name).toBe("All Saints");
    expect(org.slug).toBe("all-saints");
  });

  it("does not let an admin rename or reconfigure a parish through the super admin route", async () => {
    const res = await as(admin).call("PATCH", `/api/organizations/${orgId}`, {
      name: "Renamed",
      slug: "renamed",
      mapViewEnabled: true,
    });
    expect(res.status).toBe(403);
  });

  it("does not let a member touch the church address", async () => {
    const res = await as(user).call("PATCH", "/api/organizations/current", CHURCH);
    expect(res.status).toBe(403);
  });

  it("does not let a member list the parishes", async () => {
    const res = await as(user).call("GET", "/api/organizations");
    expect(res.status).toBe(403);
  });

  it("saves the church address without a pin when geocoding is unavailable", async () => {
    // GEOCODING_MODE=local, so nothing resolves. The address still has to save:
    // the alternative is a parish that cannot record where it is because
    // Google is unreachable.
    const res = await as(admin).call("PATCH", "/api/organizations/current", CHURCH);
    expect(res.status).toBe(200);
    expect(res.body.organization.addressLine1).toBe("1 Church St");
    expect(res.body.organization.placeId).toBeNull();
    expect(res.body.organization.latitude).toBeNull();
    // `not_configured` is not the user's problem, so it is not reported.
    expect(res.body.geocodeWarning).toBeNull();
  });

  it("creates a parish with map view on when a super admin asks", async () => {
    const res = await as(superAdmin).call("POST", "/api/organizations", {
      name: "St Nicholas",
      slug: "st-nicholas",
      mapViewEnabled: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.mapViewEnabled).toBe(true);
  });

  it("still rejects a duplicate short name", async () => {
    const res = await as(superAdmin).call("POST", "/api/organizations", {
      name: "Another",
      slug: "all-saints",
    });
    expect(res.status).toBe(409);
  });

  describe("what an admin may read", () => {
    it("lets an admin read their own parish's address", async () => {
      // Their own settings page needs it. `GET /` is a super administrator's
      // list of every tenant, so without this an administrator could not be
      // shown the address the map is asking them to fix.
      await as(admin).call("PATCH", "/api/organizations/current", CHURCH);
      const res = await as(admin).call("GET", "/api/organizations/current");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ addressLine1: "1 Church St", city: "Chicago" });
    });

    it("tells an admin nothing about the parish beyond its address", async () => {
      const res = await as(admin).call("GET", "/api/organizations/current");
      expect(res.status).toBe(200);
      // Narrower than OrganizationDto on purpose: name, slug, the counts and
      // the Map View switch are not an administrator's to see here, and
      // returning them invites a form that tries to send them back.
      expect(res.body).not.toHaveProperty("name");
      expect(res.body).not.toHaveProperty("slug");
      expect(res.body).not.toHaveProperty("mapViewEnabled");
      expect(res.body).not.toHaveProperty("personCount");
    });

    it("does not let a member read the church address from here", async () => {
      const res = await as(user).call("GET", "/api/organizations/current");
      expect(res.status).toBe(403);
    });

    it("answers for the parish the caller is acting in", async () => {
      // A super admin switching parishes has to be shown -- and edit -- the one
      // they are looking at, which is what `?orgId=` decides.
      const other = await createOrganization(db(), "St George", "st-george");
      await as(superAdmin).call("PATCH", `/api/organizations/${other}`, {
        name: "St George",
        slug: "st-george",
        addressLine1: "9 Other St",
      });

      const res = await as(superAdmin).call("GET", `/api/organizations/current?orgId=${other}`);
      expect(res.status).toBe(200);
      expect(res.body.addressLine1).toBe("9 Other St");
    });
  });
});
