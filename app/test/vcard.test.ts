import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonDto, SpecialDateDto } from "@shared";
import { stubDownload } from "./utils";
import { buildVCard, downloadVCard, vCardFilename } from "../src/lib/vcard";

function date(overrides: Partial<SpecialDateDto> = {}): SpecialDateDto {
  return {
    id: "date-1",
    personId: "person-1",
    personName: "Layla Haddad",
    type: "BIRTHDAY",
    month: 5,
    day: 4,
    year: 1985,
    showYearCount: false,
    relatedPersonId: null,
    relatedPersonName: null,
    patronSaint: null,
    ...overrides,
  };
}

function person(overrides: Partial<PersonDto> = {}): PersonDto {
  return {
    id: "person-1",
    organizationId: "org-1",
    familyId: null,
    familyName: null,
    appUserId: null,
    firstName: "Layla",
    lastName: "Haddad",
    email: null,
    phone: null,
    altPhone: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    postalCode: null,
    country: null,
    placeId: null,
    patronSaint: null,
    occupation: null,
    photoUrl: null,
    thumbUrl: null,
    fullUrl: null,
    canEdit: false,
    inheritedFrom: {},
    specialDates: [],
    ...overrides,
  };
}

const lines = (card: string) => card.split("\r\n");

describe("buildVCard", () => {
  it("writes the occupation as the job title", () => {
    const card = buildVCard(person({ occupation: "Nurse; RN" }));
    expect(lines(card)).toContain("TITLE:Nurse\\; RN");
    expect(lines(buildVCard(person()))).not.toContain(expect.stringMatching(/^TITLE/));
  });

  it("writes a full record", () => {
    const card = buildVCard(
      person({
        email: "layla@example.com",
        phone: "555-0100",
        altPhone: "555-0101",
        addressLine1: "1 Main St",
        addressLine2: "Apt 2",
        city: "Springfield",
        state: "IL",
        postalCode: "62701",
        country: "USA",
        specialDates: [date()],
      })
    );
    expect(lines(card)).toEqual([
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:Haddad;Layla;;;",
      "FN:Layla Haddad",
      "TEL;TYPE=CELL:555-0100",
      "TEL;TYPE=VOICE:555-0101",
      "EMAIL;TYPE=INTERNET:layla@example.com",
      "ADR;TYPE=HOME:;;1 Main St\\, Apt 2;Springfield;IL;62701;USA",
      "BDAY:1985-05-04",
      "END:VCARD",
      "",
    ]);
  });

  it("omits what is not set", () => {
    const card = buildVCard(person());
    expect(card).not.toMatch(/TEL|EMAIL|ADR|BDAY|PHOTO/);
  });

  it("escapes characters with meaning in a vCard", () => {
    const card = buildVCard(person({ firstName: "A;B", lastName: "C,D\\E", phone: "1\n2" }));
    expect(card).toContain("N:C\\,D\\\\E;A\\;B;;;");
    expect(card).toContain("TEL;TYPE=CELL:1\\n2");
  });

  it("marks a birthday with no year so Contacts shows day and month only", () => {
    const card = buildVCard(person({ specialDates: [date({ year: null })] }));
    expect(card).toContain("BDAY;X-APPLE-OMIT-YEAR=1604:1604-05-04");
  });

  it("adds an anniversary and a name day as labelled dates", () => {
    const card = buildVCard(
      person({
        specialDates: [
          date({ type: "ANNIVERSARY", month: 6, day: 7, year: 2010 }),
          date({ id: "d3", type: "FEAST_DAY", month: 12, day: 6, year: null }),
        ],
      })
    );
    expect(card).toContain("item1.X-ABDATE:2010-06-07");
    expect(card).toContain("item1.X-ABLabel:_$!<Anniversary>!$_");
    expect(card).toContain("item2.X-ABDATE;X-APPLE-OMIT-YEAR=1604:1604-12-06");
    // A custom label: wrapped, Apple would show the wrapper itself.
    expect(card).toContain("item2.X-ABLabel:name day\r\n");
    expect(card).not.toContain("BDAY");
  });

  it("embeds a photo and folds it to 75 octets a line", () => {
    const card = buildVCard(person(), { base64: "A".repeat(300) });
    const photoLines = lines(card).filter((l) => l.startsWith("PHOTO") || l.startsWith(" A"));
    expect(photoLines.length).toBeGreaterThan(1);
    for (const l of lines(card)) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    // Unfolding gives back the original.
    expect(card.replace(/\r\n /g, "")).toContain(`TYPE=JPEG:${"A".repeat(300)}`);
  });

  it("uses CRLF throughout", () => {
    expect(buildVCard(person()).replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });
});

describe("vCardFilename", () => {
  it("uses the name", () => {
    expect(vCardFilename(person())).toBe("Layla Haddad.vcf");
  });

  it("strips characters a filesystem rejects", () => {
    expect(vCardFilename(person({ firstName: 'A/B:"C"', lastName: null }))).toBe("ABC.vcf");
  });
});

describe("downloadVCard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("downloads a .vcf blob", async () => {
    const { create, revoke, clicked } = stubDownload();
    await downloadVCard(person());

    const blob = create.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe("text/vcard;charset=utf-8");
    expect(await blob.text()).toContain("FN:Layla Haddad");
    expect(clicked()?.download).toBe("Layla Haddad.vcf");
    expect(revoke).toHaveBeenCalledWith("blob:download");
  });

  it("still downloads when the photo cannot be loaded", async () => {
    const { create } = stubDownload();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await downloadVCard(person({ fullUrl: "/photos/x/full" }));

    const blob = create.mock.calls[0]?.[0] as Blob;
    const text = await blob.text();
    expect(text).toContain("BEGIN:VCARD");
    expect(text).not.toContain("PHOTO");
  });
});
