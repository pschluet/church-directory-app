import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { closeDatabase, resetTables, testDb } from "./helpers/testDb";
import { client } from "./helpers/request";
import {
  createFamily,
  createNonUserPerson,
  createOrganization,
  createUser,
  type CreatedUser,
} from "./helpers/fixtures";

const hasDb = inject("hasDatabase");

describe.skipIf(!hasDb)("special dates", () => {
  const db = () => testDb();
  let orgId: string;
  let familyId: string;
  let paul: CreatedUser;
  let maria: CreatedUser;
  let anna: string;

  beforeEach(async () => {
    await resetTables();
    orgId = await createOrganization(db());
    familyId = await createFamily(db(), orgId, "Schlueter");
    paul = await createUser(db(), {
      organizationId: orgId,
      familyId,
      email: "paul@test.example",
      firstName: "Paul",
      lastName: "Schlueter",
    });
    maria = await createUser(db(), {
      organizationId: orgId,
      familyId,
      email: "maria@test.example",
      firstName: "Maria",
      lastName: "Schlueter",
    });
    anna = await createNonUserPerson(db(), {
      organizationId: orgId,
      familyId,
      firstName: "Anna",
      lastName: "Schlueter",
      patronSaint: "St. Anna",
    });
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const as = (u: CreatedUser) => client(db(), { sub: u.cognitoSub, email: u.email });

  describe("creating", () => {
    it("stores a birthday with only a month and day", async () => {
      const { status, body } = await as(paul).call("POST", "/api/special-dates", {
        personId: anna,
        type: "BIRTHDAY",
        month: 5,
        day: 4,
      });
      expect(status).toBe(201);
      expect(body.year).toBeNull();
      expect(body.showYearCount).toBe(false);
    });

    it("refuses to show an age without a year", async () => {
      const { status } = await as(paul).call("POST", "/api/special-dates", {
        personId: anna,
        type: "BIRTHDAY",
        month: 5,
        day: 4,
        showYearCount: true,
      });
      expect(status).toBe(400);
    });

    it("links two people for a wedding anniversary", async () => {
      const { status, body } = await as(paul).call("POST", "/api/special-dates", {
        personId: paul.personId,
        type: "ANNIVERSARY",
        month: 6,
        day: 12,
        year: 2010,
        showYearCount: true,
        relatedPersonId: maria.personId,
      });
      expect(status).toBe(201);
      expect(body.personName).toBe("Paul Schlueter");
      expect(body.relatedPersonName).toBe("Maria Schlueter");
    });

    it("shows an anniversary on both spouses' profiles, stored once", async () => {
      await as(paul).call("POST", "/api/special-dates", {
        personId: paul.personId,
        type: "ANNIVERSARY",
        month: 6,
        day: 12,
        year: 2010,
        relatedPersonId: maria.personId,
      });

      const his = await as(paul).call("GET", `/api/persons/${paul.personId}`);
      const hers = await as(maria).call("GET", `/api/persons/${maria.personId}`);
      expect(his.body.specialDates).toHaveLength(1);
      expect(hers.body.specialDates).toHaveLength(1);
      expect(his.body.specialDates[0].id).toBe(hers.body.specialDates[0].id);
    });

    it("refuses a duplicate anniversary entered from the other side", async () => {
      await as(paul).call("POST", "/api/special-dates", {
        personId: paul.personId,
        type: "ANNIVERSARY",
        month: 6,
        day: 12,
        year: 2010,
        relatedPersonId: maria.personId,
      });
      const { status } = await as(maria).call("POST", "/api/special-dates", {
        personId: maria.personId,
        type: "ANNIVERSARY",
        month: 6,
        day: 12,
        year: 2010,
        relatedPersonId: paul.personId,
      });
      expect(status).toBe(409);
    });

    it("labels a feast day from the person's patron saint", async () => {
      const { body } = await as(paul).call("POST", "/api/special-dates", {
        personId: anna,
        type: "FEAST_DAY",
        month: 7,
        day: 25,
      });
      expect(body.patronSaint).toBe("St. Anna");
    });

    it("refuses a date for someone the caller cannot edit", async () => {
      const { status } = await as(paul).call("POST", "/api/special-dates", {
        personId: maria.personId,
        type: "BIRTHDAY",
        month: 1,
        day: 1,
      });
      expect(status).toBe(403);
    });
  });

  describe("upcoming", () => {
    beforeEach(async () => {
      // Paul: birthday 4 May 1985, age shown.
      await as(paul).call("POST", "/api/special-dates", {
        personId: paul.personId,
        type: "BIRTHDAY",
        month: 5,
        day: 4,
        year: 1985,
        showYearCount: true,
      });
      // Anna: birthday 6 May, no year.
      await as(paul).call("POST", "/api/special-dates", {
        personId: anna,
        type: "BIRTHDAY",
        month: 5,
        day: 6,
      });
      // Anna: feast day 4 May, same day as Paul's birthday.
      await as(paul).call("POST", "/api/special-dates", {
        personId: anna,
        type: "FEAST_DAY",
        month: 5,
        day: 4,
      });
      // Anniversary 6 May 2010, years hidden.
      await as(paul).call("POST", "/api/special-dates", {
        personId: paul.personId,
        type: "ANNIVERSARY",
        month: 5,
        day: 6,
        year: 2010,
        relatedPersonId: maria.personId,
      });
    });

    it("covers today and the next six days by default", async () => {
      const { body } = await as(paul).call("GET", "/api/special-dates/upcoming?start=2026-05-01");
      expect(body.start).toBe("2026-05-01");
      expect(body.end).toBe("2026-05-07");
      expect(body.days).toHaveLength(7);
    });

    it("groups by date and then by type", async () => {
      const { body } = await as(paul).call("GET", "/api/special-dates/upcoming?start=2026-05-01");
      const may4 = body.days.find((d: any) => d.date === "2026-05-04");
      expect(may4.dates.map((d: any) => d.type)).toEqual(["BIRTHDAY", "FEAST_DAY"]);

      const may6 = body.days.find((d: any) => d.date === "2026-05-06");
      expect(may6.dates.map((d: any) => d.type)).toEqual(["BIRTHDAY", "ANNIVERSARY"]);
    });

    it("shows an age only where the person opted in", async () => {
      const { body } = await as(paul).call("GET", "/api/special-dates/upcoming?start=2026-05-01");
      const may4 = body.days.find((d: any) => d.date === "2026-05-04");
      expect(may4.dates.find((d: any) => d.type === "BIRTHDAY").yearCount).toBe(41);
      expect(may4.dates.find((d: any) => d.type === "FEAST_DAY").yearCount).toBeNull();

      const may6 = body.days.find((d: any) => d.date === "2026-05-06");
      // Anna's birthday has no year on record.
      expect(may6.dates.find((d: any) => d.type === "BIRTHDAY").yearCount).toBeNull();
      // The anniversary has a year, but showYearCount was not set.
      expect(may6.dates.find((d: any) => d.type === "ANNIVERSARY").yearCount).toBeNull();
    });

    it("honours a custom range", async () => {
      const { body } = await as(paul).call(
        "GET",
        "/api/special-dates/upcoming?start=2026-05-01&days=30"
      );
      expect(body.days).toHaveLength(30);
      expect(body.end).toBe("2026-05-30");
    });

    it("works across a year boundary", async () => {
      // A fresh person: Anna already has both a birthday and a feast day, and
      // only one of each is allowed.
      const nikolai = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Nikolai",
      });
      const created = await as(paul).call("POST", "/api/special-dates", {
        personId: nikolai,
        type: "FEAST_DAY",
        month: 1,
        day: 2,
      });
      expect(created.status).toBe(201);

      const { body } = await as(maria).call(
        "GET",
        "/api/special-dates/upcoming?start=2026-12-30&days=5"
      );
      const jan2 = body.days.find((d: any) => d.date === "2027-01-02");
      expect(jan2.dates).toHaveLength(1);
    });

    it("surfaces a leap-day birthday on 1 March in a non-leap year", async () => {
      const nikolai = await createNonUserPerson(db(), {
        organizationId: orgId,
        familyId,
        firstName: "Nikolai",
      });
      const created = await as(paul).call("POST", "/api/special-dates", {
        personId: nikolai,
        type: "FEAST_DAY",
        month: 2,
        day: 29,
      });
      expect(created.status).toBe(201);

      const nonLeap = await as(paul).call(
        "GET",
        "/api/special-dates/upcoming?start=2027-02-26&days=5"
      );
      expect(
        nonLeap.body.days.find((d: any) => d.date === "2027-03-01").dates.map((d: any) => d.type)
      ).toContain("FEAST_DAY");
      expect(nonLeap.body.days.find((d: any) => d.date === "2027-02-28").dates).toHaveLength(0);

      const leap = await as(paul).call(
        "GET",
        "/api/special-dates/upcoming?start=2028-02-27&days=4"
      );
      expect(leap.body.days.find((d: any) => d.date === "2028-02-29").dates).toHaveLength(1);
      expect(leap.body.days.find((d: any) => d.date === "2028-03-01").dates).toHaveLength(0);
    });

    it("leaves out dates belonging to a deleted person", async () => {
      await db().query("update persons set deleted_at = now() where id = $1", [anna]);
      const { body } = await as(paul).call("GET", "/api/special-dates/upcoming?start=2026-05-01");
      const may4 = body.days.find((d: any) => d.date === "2026-05-04");
      expect(may4.dates.map((d: any) => d.type)).toEqual(["BIRTHDAY"]);
    });

    it("rejects a malformed start date", async () => {
      const { status } = await as(paul).call("GET", "/api/special-dates/upcoming?start=05/01/2026");
      expect(status).toBe(400);
    });
  });

  describe("calendar", () => {
    it("returns one entry per day of the month, with the dates on them", async () => {
      await as(paul).call("POST", "/api/special-dates", {
        personId: anna,
        type: "BIRTHDAY",
        month: 2,
        day: 10,
      });

      const { body } = await as(paul).call("GET", "/api/special-dates/calendar?year=2026&month=2");
      expect(body.days).toHaveLength(28);
      expect(body.days.find((d: any) => d.date === "2026-02-10").dates).toHaveLength(1);
      expect(body.days.find((d: any) => d.date === "2026-02-11").dates).toHaveLength(0);
    });

    it("rejects a month outside 1-12", async () => {
      expect(
        (await as(paul).call("GET", "/api/special-dates/calendar?year=2026&month=13")).status
      ).toBe(400);
    });
  });

  /**
   * "checkbox should allow the person to opt-in to showing age to others" --
   * which only holds if the birth year goes with the age, since May 4, 1985 is
   * one subtraction away from it. The year is withheld from the payload rather
   * than from the page, so these assert on the JSON.
   */
  describe("hiding the year behind an opted-out age", () => {
    /** Same organization as Paul, but a different family and no edit rights. */
    async function createOutsider(): Promise<CreatedUser> {
      const otherFamily = await createFamily(db(), orgId, "Novak");
      return createUser(db(), {
        organizationId: orgId,
        familyId: otherFamily,
        email: "outsider@test.example",
        firstName: "Jan",
        lastName: "Novak",
      });
    }

    const birthdayOn = (body: any) => body.specialDates.find((d: any) => d.type === "BIRTHDAY");

    it("keeps the year from another member, but not the day", async () => {
      await as(paul).call("POST", "/api/special-dates", {
        personId: paul.personId,
        type: "BIRTHDAY",
        month: 5,
        day: 4,
        year: 1985,
      });

      const mine = await as(paul).call("GET", `/api/persons/${paul.personId}`);
      expect(birthdayOn(mine.body).year).toBe(1985);

      const theirs = await as(maria).call("GET", `/api/persons/${paul.personId}`);
      const hidden = birthdayOn(theirs.body);
      expect(hidden.year).toBeNull();
      expect(hidden.month).toBe(5);
      expect(hidden.day).toBe(4);
    });

    it("shows the year to everyone once the age is opted in to", async () => {
      await as(paul).call("POST", "/api/special-dates", {
        personId: paul.personId,
        type: "BIRTHDAY",
        month: 5,
        day: 4,
        year: 1985,
        showYearCount: true,
      });

      const { body } = await as(maria).call("GET", `/api/persons/${paul.personId}`);
      expect(birthdayOn(body).year).toBe(1985);
    });

    it("shows the year to an admin, who can edit the date anyway", async () => {
      await as(paul).call("POST", "/api/special-dates", {
        personId: paul.personId,
        type: "BIRTHDAY",
        month: 5,
        day: 4,
        year: 1985,
      });

      const admin = await createUser(db(), {
        organizationId: orgId,
        role: "ADMIN",
        email: "admin@test.example",
      });
      const { body } = await as(admin).call("GET", `/api/persons/${paul.personId}`);
      expect(birthdayOn(body).year).toBe(1985);
    });

    it("shows the year to a family member managing someone with no account", async () => {
      await as(paul).call("POST", "/api/special-dates", {
        personId: anna,
        type: "BIRTHDAY",
        month: 5,
        day: 6,
        year: 2015,
      });

      const { body } = await as(paul).call("GET", `/api/persons/${anna}`);
      expect(birthdayOn(body).year).toBe(2015);

      const outsider = await createOutsider();
      const { body: outside } = await as(outsider).call("GET", `/api/persons/${anna}`);
      expect(birthdayOn(outside).year).toBeNull();
    });

    it("shows an anniversary year to the spouse on the other side of it", async () => {
      await as(paul).call("POST", "/api/special-dates", {
        personId: paul.personId,
        type: "ANNIVERSARY",
        month: 6,
        day: 12,
        year: 2010,
        relatedPersonId: maria.personId,
      });

      // Stored on Paul's record, but the wedding year is as much Maria's.
      const { body: hers } = await as(maria).call("GET", `/api/persons/${maria.personId}`);
      expect(hers.specialDates[0].year).toBe(2010);

      const outsider = await createOutsider();
      const { body: theirs } = await as(outsider).call("GET", `/api/persons/${paul.personId}`);
      expect(theirs.specialDates[0].year).toBeNull();
    });

    it("redacts the year in the upcoming list too", async () => {
      await as(paul).call("POST", "/api/special-dates", {
        personId: paul.personId,
        type: "BIRTHDAY",
        month: 5,
        day: 4,
        year: 1985,
      });

      const outsider = await createOutsider();
      const { body } = await as(outsider).call(
        "GET",
        "/api/special-dates/upcoming?start=2026-05-04&days=1"
      );
      const entry = body.days[0].dates[0];
      expect(entry.year).toBeNull();
      expect(entry.yearCount).toBeNull();
    });
  });

  describe("updating and deleting", () => {
    it("updates a date the caller may edit", async () => {
      const created = await as(paul).call("POST", "/api/special-dates", {
        personId: anna,
        type: "BIRTHDAY",
        month: 5,
        day: 4,
      });
      const { status, body } = await as(paul).call(
        "PATCH",
        `/api/special-dates/${created.body.id}`,
        { type: "BIRTHDAY", month: 5, day: 5, year: 2015, showYearCount: true }
      );
      expect(status).toBe(200);
      expect(body.day).toBe(5);
      expect(body.showYearCount).toBe(true);
    });

    it("deletes a date", async () => {
      const created = await as(paul).call("POST", "/api/special-dates", {
        personId: anna,
        type: "BIRTHDAY",
        month: 5,
        day: 4,
      });
      expect((await as(paul).call("DELETE", `/api/special-dates/${created.body.id}`)).status).toBe(
        204
      );
      const { body } = await as(paul).call("GET", `/api/persons/${anna}`);
      expect(body.specialDates).toHaveLength(0);
    });

    it("refuses to touch a date belonging to someone else's record", async () => {
      const created = await as(maria).call("POST", "/api/special-dates", {
        personId: maria.personId,
        type: "BIRTHDAY",
        month: 3,
        day: 3,
      });
      expect((await as(paul).call("DELETE", `/api/special-dates/${created.body.id}`)).status).toBe(
        403
      );
    });
  });
});
