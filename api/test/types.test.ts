import { describe, expect, it } from "vitest";
import {
  MAX_PHOTO_BYTES,
  ROLES,
  daysInMonth,
  formatPhone,
  hasRole,
  isLeapYear,
  isRealDate,
  normalizePhone,
  specialDateWriteSchema,
  personWriteSchema,
  organizationWriteSchema,
  photoAttachSchema,
  photoUploadSchema,
} from "../src/types";

describe("hasRole", () => {
  it("treats every role as a floor rather than an exact match", () => {
    expect(hasRole("SUPER_ADMIN", "ADMIN")).toBe(true);
    expect(hasRole("ADMIN", "USER")).toBe(true);
    expect(hasRole("USER", "ADMIN")).toBe(false);
  });

  it("puts PRAYER_REQUEST_ADMIN above USER and below ADMIN", () => {
    expect(hasRole("PRAYER_REQUEST_ADMIN", "USER")).toBe(true);
    expect(hasRole("PRAYER_REQUEST_ADMIN", "PRAYER_REQUEST_ADMIN")).toBe(true);
    expect(hasRole("PRAYER_REQUEST_ADMIN", "ADMIN")).toBe(false);
    expect(hasRole("USER", "PRAYER_REQUEST_ADMIN")).toBe(false);
  });

  it("lets both kinds of administrator approve prayer requests", () => {
    expect(hasRole("ADMIN", "PRAYER_REQUEST_ADMIN")).toBe(true);
    expect(hasRole("SUPER_ADMIN", "PRAYER_REQUEST_ADMIN")).toBe(true);
  });

  it("ranks every role, so no role can silently fall out of the ladder", () => {
    // A role missing from ROLE_RANK would compare as undefined and every
    // comparison against it would quietly be false -- i.e. fail open on the
    // floor checks and closed on the grants. Assert the whole enum is covered.
    for (const role of ROLES) {
      expect(hasRole(role, "USER")).toBe(true);
    }
  });
});

describe("normalizePhone", () => {
  it("assumes +1 for a bare ten-digit number", () => {
    expect(normalizePhone("(312) 555-1234")).toBe("+13125551234");
    expect(normalizePhone("312.555.1234")).toBe("+13125551234");
    expect(normalizePhone("3125551234")).toBe("+13125551234");
  });

  it("keeps an eleven-digit number that already starts with 1", () => {
    expect(normalizePhone("1-312-555-1234")).toBe("+13125551234");
  });

  it("respects an explicit country code", () => {
    expect(normalizePhone("+44 20 7123 4567")).toBe("+442071234567");
  });

  it("returns null for input that cannot be a phone number", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("   ")).toBeNull();
    expect(normalizePhone("not a phone")).toBeNull();
    // Longer than E.164 allows.
    expect(normalizePhone("+1234567890123456789")).toBeNull();
  });
});

describe("formatPhone", () => {
  it("formats US numbers and leaves others alone", () => {
    expect(formatPhone("+13125551234")).toBe("(312) 555-1234");
    expect(formatPhone("+442071234567")).toBe("+442071234567");
  });
});

describe("calendar helpers", () => {
  it("knows about leap years, including century rules", () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2027)).toBe(false);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
  });

  it("allows 29 February for a recurring date with no year", () => {
    expect(daysInMonth(2, null)).toBe(29);
    expect(daysInMonth(2, 2027)).toBe(28);
    expect(isRealDate(2, 29, null)).toBe(true);
    expect(isRealDate(2, 29, 2027)).toBe(false);
    expect(isRealDate(4, 31, null)).toBe(false);
  });
});

describe("specialDateWriteSchema", () => {
  const birthday = { type: "BIRTHDAY" as const, month: 5, day: 4 };

  it("accepts a birthday with only a month and day", () => {
    expect(specialDateWriteSchema.safeParse(birthday).success).toBe(true);
  });

  it("refuses to show an age without a year", () => {
    const result = specialDateWriteSchema.safeParse({ ...birthday, showYearCount: true });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["year"]);
  });

  it("accepts an age once a full date is given", () => {
    expect(
      specialDateWriteSchema.safeParse({ ...birthday, year: 1985, showYearCount: true }).success
    ).toBe(true);
  });

  it("requires an anniversary to link two people and have a year", () => {
    const noPartner = specialDateWriteSchema.safeParse({
      type: "ANNIVERSARY",
      month: 6,
      day: 12,
      year: 2010,
    });
    expect(noPartner.success).toBe(false);
    expect(noPartner.error?.issues.map((i) => i.path[0])).toContain("relatedPersonId");

    const noYear = specialDateWriteSchema.safeParse({
      type: "ANNIVERSARY",
      month: 6,
      day: 12,
      relatedPersonId: "6f2a2d94-1a5f-4c26-9e0e-2f3a4b5c6d7e",
    });
    expect(noYear.success).toBe(false);
    expect(noYear.error?.issues.map((i) => i.path[0])).toContain("year");
  });

  it("rejects a second person on anything but an anniversary", () => {
    const result = specialDateWriteSchema.safeParse({
      ...birthday,
      relatedPersonId: "6f2a2d94-1a5f-4c26-9e0e-2f3a4b5c6d7e",
    });
    expect(result.success).toBe(false);
  });

  it("keeps a feast day to a month and day", () => {
    expect(specialDateWriteSchema.safeParse({ type: "FEAST_DAY", month: 6, day: 29 }).success).toBe(
      true
    );
    expect(
      specialDateWriteSchema.safeParse({ type: "FEAST_DAY", month: 6, day: 29, year: 1990 }).success
    ).toBe(false);
  });

  it("rejects dates that do not exist", () => {
    expect(specialDateWriteSchema.safeParse({ ...birthday, month: 4, day: 31 }).success).toBe(
      false
    );
    expect(
      specialDateWriteSchema.safeParse({ type: "BIRTHDAY", month: 2, day: 29, year: 2027 }).success
    ).toBe(false);
    // A recurring 29 February is fine.
    expect(specialDateWriteSchema.safeParse({ type: "FEAST_DAY", month: 2, day: 29 }).success).toBe(
      true
    );
  });
});

describe("personWriteSchema", () => {
  it("requires a first name and normalises blanks to null", () => {
    expect(personWriteSchema.safeParse({ firstName: "  " }).success).toBe(false);

    const parsed = personWriteSchema.parse({ firstName: " Paul ", lastName: "  ", city: "" });
    expect(parsed.firstName).toBe("Paul");
    expect(parsed.lastName).toBeNull();
    expect(parsed.city).toBeNull();
  });

  it("insists phone numbers are already E.164", () => {
    expect(personWriteSchema.safeParse({ firstName: "Paul", phone: "312-555-1234" }).success).toBe(
      false
    );
    expect(personWriteSchema.safeParse({ firstName: "Paul", phone: "+13125551234" }).success).toBe(
      true
    );
  });

  it("lowercases email addresses so lookups match", () => {
    expect(personWriteSchema.parse({ firstName: "Paul", email: "Paul@Example.COM" }).email).toBe(
      "paul@example.com"
    );
  });
});

describe("organizationWriteSchema", () => {
  it("accepts a url-safe slug and rejects the rest", () => {
    expect(
      organizationWriteSchema.safeParse({ name: "All Saints", slug: "all-saints" }).success
    ).toBe(true);
    expect(organizationWriteSchema.safeParse({ name: "All Saints", slug: "-bad" }).success).toBe(
      false
    );
    expect(
      organizationWriteSchema.safeParse({ name: "All Saints", slug: "Bad Slug" }).success
    ).toBe(false);
  });
});

describe("photoUploadSchema", () => {
  const base = {
    contentType: "image/webp" as const,
    renditions: { thumb: { contentLength: 20 * 1024 }, full: { contentLength: 180 * 1024 } },
  };
  const id = "6f2a2d94-1a5f-4c26-9e0e-2f3a4b5c6d7e";

  it("needs exactly one owner", () => {
    expect(photoUploadSchema.safeParse({ ...base, personId: id }).success).toBe(true);
    expect(photoUploadSchema.safeParse({ ...base, familyId: id }).success).toBe(true);
    expect(photoUploadSchema.safeParse(base).success).toBe(false);
    expect(photoUploadSchema.safeParse({ ...base, personId: id, familyId: id }).success).toBe(
      false
    );
  });

  it("requires both renditions", () => {
    expect(
      photoUploadSchema.safeParse({
        ...base,
        personId: id,
        renditions: { thumb: { contentLength: 20 * 1024 } },
      }).success
    ).toBe(false);
  });

  it("caps each rendition rather than the original", () => {
    // The 5MB MAX_PHOTO_BYTES applies to the file someone picks, in the
    // browser. What reaches S3 is downscaled, so the cap here is tighter.
    expect(
      photoUploadSchema.safeParse({
        ...base,
        personId: id,
        renditions: {
          thumb: { contentLength: 20 * 1024 },
          full: { contentLength: MAX_PHOTO_BYTES },
        },
      }).success
    ).toBe(false);
  });

  it("only accepts the types the browser can encode to", () => {
    expect(
      photoUploadSchema.safeParse({ ...base, personId: id, contentType: "image/gif" }).success
    ).toBe(false);
    // A PNG is a valid *input* but is never what gets uploaded.
    expect(
      photoUploadSchema.safeParse({ ...base, personId: id, contentType: "image/png" }).success
    ).toBe(false);
  });
});

describe("photoAttachSchema", () => {
  const prefix = "photos/6f2a2d94-1a5f-4c26-9e0e-2f3a4b5c6d7e/person/abc/01ABC/";

  it("takes a rendition prefix or a null to clear", () => {
    expect(photoAttachSchema.safeParse({ photoKey: prefix }).success).toBe(true);
    expect(photoAttachSchema.safeParse({ photoKey: null }).success).toBe(true);
  });

  it("rejects a key that is not a prefix", () => {
    // A bare object key would make photoVariantKeys treat it as a legacy
    // single original, silently storing a photo with no thumbnail.
    expect(photoAttachSchema.safeParse({ photoKey: `${prefix}thumb` }).success).toBe(false);
  });

  it("wants both dimensions or neither", () => {
    expect(
      photoAttachSchema.safeParse({ photoKey: prefix, photoWidth: 1200, photoHeight: 800 }).success
    ).toBe(true);
    expect(photoAttachSchema.safeParse({ photoKey: prefix, photoWidth: 1200 }).success).toBe(false);
  });
});
