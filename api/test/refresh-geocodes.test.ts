import { afterAll, afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import {
  createFamily,
  createGeocode,
  createNonUserPerson,
  createOrganization,
  enableMapView,
  setPlaceId,
} from "./helpers/fixtures";

const hasDb = inject("hasDatabase");

/**
 * The scheduled refresh, driven through a stubbed Google.
 *
 * What matters here is which rows are *selected*, not what Google says about
 * them: the per-parish switch means a parish with Map View off must generate no
 * calls at all, and the church's own pin must not be the one coordinate that
 * never refreshes because no person points at it.
 *
 * The module reads GEOCODING_MODE at load, so it is imported per case with the
 * environment stubbed -- and `fetch` is replaced, which is what proves the
 * disabled cases make no request rather than merely storing no result.
 */
describe.skipIf(!hasDb)("geocode refresh", () => {
  const db = () => testDb();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await resetTables();
    fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const placeId = url.searchParams.get("place_id") ?? "ChIJresolved";
      return new Response(
        JSON.stringify({
          status: "OK",
          results: [
            {
              place_id: placeId,
              formatted_address: "1 Refreshed St, Chicago, IL, USA",
              types: ["street_address"],
              geometry: { location: { lat: 42, lng: -88 }, location_type: "ROOFTOP" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function load() {
    vi.resetModules();
    vi.stubEnv("GEOCODING_MODE", "google");
    vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", "server-key");
    return import("../src/refresh-geocodes");
  }

  async function ageOf(placeId: string): Promise<number> {
    const { rows } = await db().query<{ days: number }>(
      "select extract(day from now() - geocoded_at)::int as days from geocoded_addresses where place_id = $1",
      [placeId]
    );
    return rows[0]!.days;
  }

  it("refreshes a stale address an enabled parish points at", async () => {
    const orgId = await createOrganization(db());
    await enableMapView(db(), orgId);
    await createGeocode(db(), { placeId: "ChIJstale", ageDays: 26 });
    const personId = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId: null,
      firstName: "Ivan",
    });
    await setPlaceId(db(), personId, "ChIJstale");

    const { refreshGeocodes } = await load();
    const summary = await refreshGeocodes(db());

    expect(summary.refreshed).toBe(1);
    expect(await ageOf("ChIJstale")).toBe(0);
  });

  it("leaves a fresh address alone", async () => {
    const orgId = await createOrganization(db());
    await enableMapView(db(), orgId);
    await createGeocode(db(), { placeId: "ChIJfresh", ageDays: 3 });
    const personId = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId: null,
      firstName: "Ivan",
    });
    await setPlaceId(db(), personId, "ChIJfresh");

    const { refreshGeocodes } = await load();
    expect((await refreshGeocodes(db())).refreshed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("makes no request for a parish with map view switched off", async () => {
    const orgId = await createOrganization(db());
    await createGeocode(db(), { placeId: "ChIJdisabled", ageDays: 40 });
    const personId = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId: null,
      firstName: "Ivan",
    });
    await setPlaceId(db(), personId, "ChIJdisabled");

    const { refreshGeocodes } = await load();
    const summary = await refreshGeocodes(db());

    expect(summary.refreshed).toBe(0);
    // The claim the per-parish switch makes about the bill: not "stores
    // nothing" but "calls nothing".
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await ageOf("ChIJdisabled")).toBeGreaterThan(30);
  });

  it("refreshes the church's own pin, which nobody lives at", async () => {
    const orgId = await createOrganization(db());
    await createGeocode(db(), { placeId: "ChIJchurch", ageDays: 26 });
    await enableMapView(db(), orgId, "ChIJchurch");

    const { refreshGeocodes } = await load();
    expect((await refreshGeocodes(db())).refreshed).toBe(1);
  });

  it("limits to one parish when asked", async () => {
    const enabled = await createOrganization(db(), "All Saints", "all-saints");
    const other = await createOrganization(db(), "St Nicholas", "st-nicholas");
    await enableMapView(db(), enabled);
    await enableMapView(db(), other);
    await createGeocode(db(), { placeId: "ChIJmine", ageDays: 26 });
    await createGeocode(db(), { placeId: "ChIJtheirs", ageDays: 26 });
    for (const [orgId, placeId] of [
      [enabled, "ChIJmine"],
      [other, "ChIJtheirs"],
    ] as const) {
      const id = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId: null,
        firstName: "Someone",
      });
      await setPlaceId(db(), id, placeId);
    }

    const { refreshGeocodes } = await load();
    expect((await refreshGeocodes(db(), { organizationId: enabled })).refreshed).toBe(1);
    expect(await ageOf("ChIJtheirs")).toBeGreaterThan(20);
  });

  it("clears the point when Google stops recognising the address", async () => {
    const orgId = await createOrganization(db());
    await enableMapView(db(), orgId);
    await createGeocode(db(), { placeId: "ChIJvanished", ageDays: 26 });
    const personId = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId: null,
      firstName: "Ivan",
    });
    await setPlaceId(db(), personId, "ChIJvanished");

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: "ZERO_RESULTS", results: [] }), { status: 200 })
    );

    const { refreshGeocodes } = await load();
    const summary = await refreshGeocodes(db());

    expect(summary.dropped).toBe(1);
    const { rows } = await db().query<{ latitude: number | null; address: string }>(
      "select latitude, formatted_address as address from geocoded_addresses where place_id = $1",
      ["ChIJvanished"]
    );
    // The row survives so the person keeps their address; only the pin goes.
    expect(rows[0]!.latitude).toBeNull();
    // And `geocoded_at` was touched, so this is not retried every day forever.
    expect(await ageOf("ChIJvanished")).toBe(0);
  });

  it("leaves a timed-out address to be tried again tomorrow", async () => {
    const orgId = await createOrganization(db());
    await enableMapView(db(), orgId);
    await createGeocode(db(), { placeId: "ChIJflaky", ageDays: 26 });
    const personId = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId: null,
      firstName: "Ivan",
    });
    await setPlaceId(db(), personId, "ChIJflaky");

    fetchMock.mockRejectedValue(new Error("timed out"));

    const { refreshGeocodes } = await load();
    expect((await refreshGeocodes(db())).failed).toBe(1);
    // Untouched, so it is still eligible next run.
    expect(await ageOf("ChIJflaky")).toBeGreaterThan(20);
  });

  it("backfills a person who has an address and no pin", async () => {
    const orgId = await createOrganization(db());
    await enableMapView(db(), orgId);
    const personId = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId: null,
      firstName: "Ivan",
    });
    await db().query(
      "update persons set address_line1 = '4129 W Newport Ave', city = 'Chicago' where id = $1",
      [personId]
    );

    const { refreshGeocodes } = await load();
    expect((await refreshGeocodes(db(), { backfill: true })).backfilled).toBe(1);
    const { rows } = await db().query<{ place_id: string | null }>(
      "select place_id from persons where id = $1",
      [personId]
    );
    expect(rows[0]!.place_id).toBe("ChIJresolved");
  });

  it("does not backfill somebody who inherits their address", async () => {
    // They inherit the pin along with it, so resolving them separately would
    // geocode the same house twice.
    const orgId = await createOrganization(db());
    await enableMapView(db(), orgId);
    // A family is required: `persons_inheritance_requires_family`.
    const familyId = await createFamily(db(), orgId, "Schlueter");
    const parent = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId,
      firstName: "Paul",
    });
    const child = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId,
      firstName: "Nikolai",
    });
    await db().query(
      "update persons set address_line1 = '4129 W Newport Ave' where id in ($1, $2)",
      [parent, child]
    );
    await db().query("update persons set inherit_address_from_person_id = $2 where id = $1", [
      child,
      parent,
    ]);

    const { refreshGeocodes } = await load();
    expect((await refreshGeocodes(db(), { backfill: true })).backfilled).toBe(1);
  });

  it("reports that it did nothing when geocoding is not configured", async () => {
    vi.resetModules();
    vi.stubEnv("GEOCODING_MODE", "local");
    const { refreshGeocodes } = await import("../src/refresh-geocodes");
    const summary = await refreshGeocodes(db());
    expect(summary.skipped).toMatch(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("backfills without being asked, because the daily run never asks", async () => {
    /*
     * The regression this file exists to prevent. `backfill` was an opt-in, and
     * the scheduled invocation is the one caller that never passes it --
     * EventBridge sends its own event shape with no such field -- so the daily
     * run refreshed existing pins and silently ignored every address that had
     * never got one. Nothing looked broken: the summary said `backfilled: 0`,
     * which was true.
     */
    const orgId = await createOrganization(db());
    await enableMapView(db(), orgId);
    const personId = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId: null,
      firstName: "Ivan",
    });
    await db().query(
      "update persons set address_line1 = '4129 W Newport Ave', city = 'Chicago' where id = $1",
      [personId]
    );

    const { refreshGeocodes } = await load();
    // No event at all, which is what the schedule effectively sends.
    expect((await refreshGeocodes(db())).backfilled).toBe(1);
  });

  it("can still be told not to, for narrowing a manual run", async () => {
    const orgId = await createOrganization(db());
    await enableMapView(db(), orgId);
    const personId = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId: null,
      firstName: "Ivan",
    });
    await db().query("update persons set address_line1 = '4129 W Newport Ave' where id = $1", [
      personId,
    ]);

    const { refreshGeocodes } = await load();
    const summary = await refreshGeocodes(db(), { backfill: false });
    expect(summary.backfilled).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("picks up an address whose first geocode failed, rather than stranding it", async () => {
    /*
     * The case that made the default wrong. A member saves an address, Google
     * times out, they get "it will be placed on the map later" -- and before
     * this, nothing ever did.
     */
    const orgId = await createOrganization(db());
    await enableMapView(db(), orgId);
    const personId = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId: null,
      firstName: "Ivan",
    });
    await db().query("update persons set address_line1 = '4129 W Newport Ave' where id = $1", [
      personId,
    ]);

    const { refreshGeocodes } = await load();
    await refreshGeocodes(db());

    const { rows } = await db().query<{ place_id: string | null }>(
      "select place_id from persons where id = $1",
      [personId]
    );
    expect(rows[0]!.place_id).toBe("ChIJresolved");
  });

  it("tells an address it cannot place apart from one it could not reach", async () => {
    /*
     * These two arrived as one number, and they want opposite responses: an
     * address Google has never heard of needs somebody to look at it, and one
     * that timed out needs nothing but tomorrow. A single `failed` count sent
     * an operator hunting for a typo that was not there, or ignoring one that
     * was.
     */
    const orgId = await createOrganization(db());
    await enableMapView(db(), orgId);
    const personId = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId: null,
      firstName: "Ivan",
    });
    await db().query("update persons set address_line1 = '12 Nowhere Ln' where id = $1", [
      personId,
    ]);

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: "ZERO_RESULTS", results: [] }), { status: 200 })
    );

    const { refreshGeocodes } = await load();
    const summary = await refreshGeocodes(db());

    expect(summary.unplaceable).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("counts an unreachable Google as deferred rather than as a bad address", async () => {
    const orgId = await createOrganization(db());
    await enableMapView(db(), orgId);
    const personId = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId: null,
      firstName: "Ivan",
    });
    await db().query("update persons set address_line1 = '4129 W Newport Ave' where id = $1", [
      personId,
    ]);

    fetchMock.mockRejectedValue(new Error("timed out"));

    const { refreshGeocodes } = await load();
    const summary = await refreshGeocodes(db());

    expect(summary.failed).toBe(1);
    expect(summary.unplaceable).toBe(0);
  });

  it("says which person could not be placed, and not where they live", async () => {
    // The id is enough to find them from the admin screens. Their home address
    // does not need to sit in CloudWatch for a month to make that possible.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const orgId = await createOrganization(db());
    await enableMapView(db(), orgId);
    const personId = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId: null,
      firstName: "Ivan",
    });
    await db().query("update persons set address_line1 = '12 Nowhere Ln' where id = $1", [
      personId,
    ]);

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: "ZERO_RESULTS", results: [] }), { status: 200 })
    );

    const { refreshGeocodes } = await load();
    await refreshGeocodes(db());

    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain(personId);
    expect(logged).not.toContain("Nowhere");
  });
});
