import { describe, expect, it } from "vitest";
import { collectUuids } from "../src/services/audit-references";

/**
 * `collectUuids` on its own, without a database -- `resolveAuditReferences`
 * (the query half) is covered end to end in `api.audit.test.ts`, which is
 * what proves the SQL agrees with what gets walked out of a payload.
 *
 * These cases are the ones easy to get wrong: a uuid embedded in a longer
 * string must not match -- that is the whole reason the pattern is anchored,
 * not searched -- and the bounds that keep a pathological payload from
 * costing the page anything.
 */
describe("collectUuids", () => {
  const PERSON_A = "11111111-1111-4111-8111-111111111111";
  const PERSON_B = "22222222-2222-4222-8222-222222222222";

  it("finds a uuid at the top level", () => {
    expect(collectUuids({ personId: PERSON_A })).toEqual([PERSON_A]);
  });

  it("finds uuids nested inside objects and arrays", () => {
    const changes = {
      result: { personId: PERSON_A, mergedPersonIds: [PERSON_B] },
    };
    expect(collectUuids(changes).sort()).toEqual([PERSON_A, PERSON_B].sort());
  });

  it("finds a uuid inside an array of scalars", () => {
    expect(collectUuids({ personIds: [PERSON_A, PERSON_B] }).sort()).toEqual(
      [PERSON_A, PERSON_B].sort()
    );
  });

  it("de-duplicates and lowercases", () => {
    expect(collectUuids({ a: PERSON_A, b: PERSON_A.toUpperCase() })).toEqual([PERSON_A]);
  });

  /*
   * The regression this file exists for. A photo key is
   * `photos/{orgId}/person/{personId}/{uuid}.jpg` -- an unanchored match would
   * pull three ids out of a string that names none of them as a top-level
   * value.
   */
  it("does not match a uuid embedded in a longer string", () => {
    expect(collectUuids({ photoKey: `photos/org/person/${PERSON_A}/thumb.jpg` })).toEqual([]);
  });

  it("ignores a Google place id", () => {
    expect(collectUuids({ placeId: "ChIJrTLr-GyuEmsRBfy61i59si0" })).toEqual([]);
  });

  it("ignores an E.164 phone number", () => {
    expect(collectUuids({ phoneE164: "+13125551234" })).toEqual([]);
  });

  it("ignores an ISO date", () => {
    expect(collectUuids({ birthDate: "1985-05-04" })).toEqual([]);
  });

  it("stops past the depth bound", () => {
    let deep: unknown = { id: PERSON_A };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(collectUuids(deep)).toEqual([]);
  });

  it("stops past the id-count bound", () => {
    const many = Array.from({ length: 600 }, (_, i) =>
      i === 599 ? PERSON_B : `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`
    );
    const found = collectUuids({ ids: many });
    expect(found.length).toBeLessThanOrEqual(500);
    // The bound stops collection partway through the array, so the last
    // element is never reached.
    expect(found).not.toContain(PERSON_B);
  });

  it("returns nothing for null or a payload with no uuids", () => {
    expect(collectUuids(null)).toEqual([]);
    expect(collectUuids({ firstName: "Maria", showYearCount: true })).toEqual([]);
  });
});
