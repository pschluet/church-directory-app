import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import { createOrganization, createUser, type CreatedUser } from "./helpers/fixtures";
import { GROUP_GUIDELINES_VERSION } from "../src/types";

const hasDb = inject("hasDatabase");

/**
 * Agreeing to the group guidelines: stored per account, surfaced on `/me`, and
 * only ever for the version the server currently holds.
 */
describe.skipIf(!hasDb)("group guidelines", () => {
  const db = () => testDb();
  let user: CreatedUser;

  beforeEach(async () => {
    await resetTables();
    const orgId = await createOrganization(db());
    user = await createUser(db(), { organizationId: orgId, email: "user@test.example" });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const as = (who: CreatedUser) => client(db(), { sub: who.cognitoSub, email: who.email });

  it("reports no agreement until the member agrees", async () => {
    const res = await as(user).call("GET", "/api/me");
    expect(res.status).toBe(200);
    expect(res.body.groupGuidelinesAgreedVersion).toBeNull();
    expect(res.body.groupGuidelinesAgreedAt).toBeNull();
  });

  it("records agreement to the current version and audits it", async () => {
    const agreed = await as(user).call("POST", "/api/me/group-guidelines", {
      version: GROUP_GUIDELINES_VERSION,
    });
    expect(agreed.status).toBe(204);

    const me = await as(user).call("GET", "/api/me");
    expect(me.body.groupGuidelinesAgreedVersion).toBe(GROUP_GUIDELINES_VERSION);
    expect(Date.parse(me.body.groupGuidelinesAgreedAt)).not.toBeNaN();

    const { rows } = await db().query(
      "select entity_id, changes from audit_log where action = 'user.agreeGroupGuidelines'"
    );
    expect(rows).toEqual([
      { entity_id: user.appUserId, changes: { version: GROUP_GUIDELINES_VERSION } },
    ]);
  });

  it("can agree again without error", async () => {
    const body = { version: GROUP_GUIDELINES_VERSION };
    expect((await as(user).call("POST", "/api/me/group-guidelines", body)).status).toBe(204);
    expect((await as(user).call("POST", "/api/me/group-guidelines", body)).status).toBe(204);
  });

  it("refuses any version but the current one", async () => {
    const res = await as(user).call("POST", "/api/me/group-guidelines", {
      version: GROUP_GUIDELINES_VERSION + 1,
    });
    expect(res.status).toBe(400);

    const me = await as(user).call("GET", "/api/me");
    expect(me.body.groupGuidelinesAgreedVersion).toBeNull();
  });
});
