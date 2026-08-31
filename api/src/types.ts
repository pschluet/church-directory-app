/**
 * Request/response contracts, as Zod schemas so validation and TypeScript
 * types come from one definition. The SPA imports this module through the
 * `@shared` alias (see app/vite.config.ts) so both sides agree on the shape of
 * every payload and the client can validate forms before submitting.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums -- these mirror the CHECK constraints in db/migrations/V1__init.sql.
// ---------------------------------------------------------------------------
export const ROLES = ["SUPER_ADMIN", "ADMIN", "USER"] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const USER_STATUSES = ["INVITED", "ACTIVE", "DISABLED"] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const SPECIAL_DATE_TYPES = ["BIRTHDAY", "ANNIVERSARY", "FEAST_DAY"] as const;
export const specialDateTypeSchema = z.enum(SPECIAL_DATE_TYPES);
export type SpecialDateType = z.infer<typeof specialDateTypeSchema>;

export const JOIN_REQUEST_STATUSES = ["PENDING", "APPROVED", "DENIED", "CANCELLED"] as const;
export const joinRequestStatusSchema = z.enum(JOIN_REQUEST_STATUSES);
export type JoinRequestStatus = z.infer<typeof joinRequestStatusSchema>;

/** The five attributes a family member may inherit from another. */
export const INHERITABLE_ATTRIBUTES = [
  "email",
  "phone",
  "altPhone",
  "lastName",
  "address",
] as const;
export const inheritableAttributeSchema = z.enum(INHERITABLE_ATTRIBUTES);
export type InheritableAttribute = z.infer<typeof inheritableAttributeSchema>;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
export const uuidSchema = z.string().uuid();

/**
 * Phone numbers are stored in E.164 so `tel:` links dial correctly on mobile.
 * Use `normalizePhone` to turn typed input into this shape before validating.
 */
export const E164_PATTERN = /^\+[1-9][0-9]{1,14}$/;
export const phoneSchema = z.string().regex(E164_PATTERN, "Must be a valid phone number");

const trimmedOptional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const addressSchema = z.object({
  addressLine1: trimmedOptional(200),
  addressLine2: trimmedOptional(200),
  city: trimmedOptional(100),
  state: trimmedOptional(100),
  postalCode: trimmedOptional(20),
  country: trimmedOptional(100),
});

// ---------------------------------------------------------------------------
// Person
// ---------------------------------------------------------------------------
export const inheritanceSchema = z.object({
  inheritEmailFromPersonId: uuidSchema.nullable().optional(),
  inheritPhoneFromPersonId: uuidSchema.nullable().optional(),
  inheritAltPhoneFromPersonId: uuidSchema.nullable().optional(),
  inheritLastNameFromPersonId: uuidSchema.nullable().optional(),
  inheritAddressFromPersonId: uuidSchema.nullable().optional(),
});
export type Inheritance = z.infer<typeof inheritanceSchema>;

export const personWriteSchema = addressSchema.merge(inheritanceSchema).extend({
  firstName: z.string().trim().min(1, "First name is required").max(100),
  lastName: trimmedOptional(100),
  email: emailSchema.nullable().optional(),
  phone: phoneSchema.nullable().optional(),
  altPhone: phoneSchema.nullable().optional(),
  patronSaint: trimmedOptional(120),
  familyId: uuidSchema.nullable().optional(),
});
export type PersonWrite = z.infer<typeof personWriteSchema>;

/** Creating a family member who has no account of their own. */
export const createPersonSchema = personWriteSchema.extend({
  familyId: uuidSchema,
});
export type CreatePerson = z.infer<typeof createPersonSchema>;

/** What browse, search and family listings need. */
export interface PersonSummaryDto {
  id: string;
  organizationId: string;
  familyId: string | null;
  familyName: string | null;
  appUserId: string | null;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  altPhone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  patronSaint: string | null;
  /**
   * @deprecated Use `thumbUrl`/`fullUrl`. Kept for one release because the SPA
   * is published after the API, so an older bundle may still be live.
   */
  photoUrl: string | null;
  /** The small square rendition, for avatars and cards. */
  thumbUrl: string | null;
  /** The large rendition, requested only when the full-screen view opens. */
  fullUrl: string | null;
  /** Whether the caller is allowed to edit this person. */
  canEdit: boolean;
}

/**
 * The person detail view. `inheritedFrom` and `specialDates` are only loaded
 * here rather than on every row of a directory listing, so a summary is never
 * an object with a deceptively empty `specialDates: []`.
 */
export interface PersonDto extends PersonSummaryDto {
  /** Which fields are inherited, and from whom -- drives the edit UI. */
  inheritedFrom: Partial<Record<InheritableAttribute, { personId: string; name: string }>>;
  specialDates: SpecialDateDto[];
}

// ---------------------------------------------------------------------------
// Family
// ---------------------------------------------------------------------------
export const familyWriteSchema = z.object({
  name: z.string().trim().min(1, "Family name is required").max(150),
});
export type FamilyWrite = z.infer<typeof familyWriteSchema>;

/**
 * Creating is the write schema plus a choice the rename does not have: whether
 * the creator joins. `join: false` lets an admin set a family up for someone
 * else, so the invite form has something to point at.
 */
export const familyCreateSchema = familyWriteSchema.extend({
  join: z.boolean().default(true),
});
export type FamilyCreate = z.infer<typeof familyCreateSchema>;

export const familyMemberSchema = z.object({ personId: uuidSchema });

/** A row in the families list. */
export interface FamilySummaryDto {
  id: string;
  name: string;
  memberCount: number;
  /** A few member names, so same-named families can be told apart. */
  memberNames: string[];
  /** The caller's own undecided request to join this family, if any. */
  pendingJoinRequestId: string | null;
}

export interface FamilyDto {
  id: string;
  organizationId: string;
  name: string;
  /** @deprecated Use `thumbUrl`/`fullUrl`; see PersonSummaryDto.photoUrl. */
  photoUrl: string | null;
  thumbUrl: string | null;
  fullUrl: string | null;
  /**
   * The intrinsic size of the family photo. A family crop is free-form, so the
   * SPA needs these to reserve the box before the image paints. Null for photos
   * that predate cropping.
   */
  photoWidth: number | null;
  photoHeight: number | null;
  members: PersonSummaryDto[];
  pendingJoinRequests: JoinRequestDto[];
  canEdit: boolean;
  /** True when the caller is a member, so the UI can offer "request to join". */
  isMember: boolean;
}

export interface JoinRequestDto {
  id: string;
  familyId: string;
  familyName: string;
  personId: string;
  personName: string;
  status: JoinRequestStatus;
  requestedAt: string;
  decidedAt: string | null;
}

// ---------------------------------------------------------------------------
// Special dates
//
// The refinements here intentionally mirror the CHECK constraints in
// V1__init.sql: the database is the backstop, this is the useful error message.
// ---------------------------------------------------------------------------
export const specialDateWriteSchema = z
  .object({
    type: specialDateTypeSchema,
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
    year: z.number().int().min(1800).max(2200).nullable().optional(),
    showYearCount: z.boolean().default(false),
    relatedPersonId: uuidSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const { type, year, showYearCount, relatedPersonId, month, day } = value;

    if (showYearCount && year == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["year"],
        message: "Select a full date (month, day and year) to show the age or number of years",
      });
    }

    if (type === "ANNIVERSARY") {
      if (year == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["year"],
          message: "A wedding anniversary needs a full month, day and year",
        });
      }
      if (!relatedPersonId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["relatedPersonId"],
          message: "A wedding anniversary must link two people",
        });
      }
    } else if (relatedPersonId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["relatedPersonId"],
        message: "Only a wedding anniversary links two people",
      });
    }

    if (type === "FEAST_DAY" && year != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["year"],
        message: "A feast day is a month and day only",
      });
    }

    if (!isRealDate(month, day, year ?? null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["day"],
        message: "That date does not exist",
      });
    }
  });
export type SpecialDateWrite = z.infer<typeof specialDateWriteSchema>;

export interface SpecialDateDto {
  id: string;
  personId: string;
  personName: string;
  type: SpecialDateType;
  month: number;
  day: number;
  year: number | null;
  showYearCount: boolean;
  relatedPersonId: string | null;
  relatedPersonName: string | null;
  /** The patron saint whose day this is; only set for FEAST_DAY. */
  patronSaint: string | null;
}

/** One special date on one calendar day, with the age/years already worked out. */
export interface SpecialDateOccurrenceDto extends SpecialDateDto {
  /** ISO yyyy-mm-dd of the occurrence in the requested window. */
  date: string;
  /**
   * Age for a birthday, years married for an anniversary. Null when the person
   * did not opt in to showing it, or when no year is recorded.
   */
  yearCount: number | null;
}

export interface UpcomingDatesDto {
  start: string;
  end: string;
  days: { date: string; dates: SpecialDateOccurrenceDto[] }[];
}

// ---------------------------------------------------------------------------
// Admin: organizations and invitations
// ---------------------------------------------------------------------------
export const organizationWriteSchema = z.object({
  name: z.string().trim().min(1).max(150),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "Lowercase letters, numbers and hyphens only")
    .max(60),
});
export type OrganizationWrite = z.infer<typeof organizationWriteSchema>;

export interface OrganizationDto {
  id: string;
  name: string;
  slug: string;
  personCount: number;
  familyCount: number;
}

export const inviteUserSchema = z.object({
  email: emailSchema,
  firstName: z.string().trim().min(1).max(100),
  lastName: trimmedOptional(100),
  role: roleSchema,
  /** Required unless the invited role is SUPER_ADMIN. */
  organizationId: uuidSchema.nullable().optional(),
  /** Optionally place the new person straight into a family. */
  familyId: uuidSchema.nullable().optional(),
});
export type InviteUser = z.infer<typeof inviteUserSchema>;

export const updateUserSchema = z.object({
  role: roleSchema.optional(),
  status: userStatusSchema.optional(),
  organizationId: uuidSchema.nullable().optional(),
  /**
   * Only used when giving an organization to an account that has no directory
   * record yet. An app_users row carries no name, so one has to be supplied
   * rather than invented.
   */
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: trimmedOptional(100),
});
export type UpdateUser = z.infer<typeof updateUserSchema>;

/**
 * A super admin adopting a home parish. They are the only role that chooses
 * their own: a member must not be able to move themselves between parishes.
 */
export const setMyOrganizationSchema = z.object({
  organizationId: uuidSchema,
  firstName: z.string().trim().min(1, "First name is required").max(100),
  lastName: trimmedOptional(100),
});
export type SetMyOrganization = z.infer<typeof setMyOrganizationSchema>;

/** What changed when an account was moved to a different parish. */
export interface OrganizationMoveDto {
  personId: string;
  /** True when the account had no directory record before. */
  created: boolean;
  /** The parish they left, or null if they had none. */
  movedFrom: string | null;
  /**
   * Anniversaries removed because the other person stayed behind. An
   * anniversary links two Persons and cannot span parishes, so the move has to
   * discard it -- callers should say so rather than losing it quietly.
   */
  removedAnniversaries: number;
}

export interface AppUserDto {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
  organizationId: string | null;
  organizationName: string | null;
  personId: string | null;
  personName: string | null;
}

export interface MeDto {
  appUser: AppUserDto;
  person: PersonDto | null;
  /** The organization the caller is currently acting in. */
  organization: { id: string; name: string } | null;
  /** Super admins may switch organizations; everyone else gets an empty list. */
  availableOrganizations: { id: string; name: string }[];
}

// ---------------------------------------------------------------------------
// Photo uploads
// ---------------------------------------------------------------------------
/** What the file picker accepts. Uploaded bytes are always PHOTO_UPLOAD_TYPE. */
export const PHOTO_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/**
 * The ceiling on the file someone picks.
 *
 * Purely a browser-side bound, despite living here: the original is cropped and
 * downscaled locally and never reaches S3, so the server never sees a file this
 * size. What it protects is the decode, which has to hold the whole image in
 * memory -- roughly width x height x 4 bytes -- because Safari does not
 * implement createImageBitmap's resize options and so cannot decode straight to
 * something smaller.
 *
 * 25MB at the 0.3-0.5 bytes per pixel a JPEG runs admits every realistic phone
 * photo, including 48MP iPhone and 50MP Android shots, while keeping the
 * worst-case decode near 250MB. Past the decode, size is bounded by
 * MAX_WORKING_PIXELS in app/src/lib/images.ts.
 */
export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;

/**
 * The ceiling on each rendition the browser produces. Much smaller than
 * MAX_PHOTO_BYTES: these are downscaled WebP, so anything approaching this is a
 * bug or an attempt to use a presigned URL for something else.
 */
export const MAX_RENDITION_BYTES = 2 * 1024 * 1024;

/**
 * Every photo is stored twice.
 *
 * `thumb` is what avatars and directory cards load -- the whole point of the
 * split, since a card renders at 56px and used to download the untouched
 * original. `full` is only fetched when someone opens the full-screen view.
 */
export const PHOTO_RENDITIONS = ["thumb", "full"] as const;
export type PhotoRendition = (typeof PHOTO_RENDITIONS)[number];

/**
 * The browser crops and downscales before uploading, so it always sends WebP
 * (or JPEG on the rare engine whose canvas cannot encode WebP) whatever the
 * user picked. The rendition filenames carry the extension, so the content type
 * is not part of the request.
 */
export const PHOTO_UPLOAD_TYPES = ["image/webp", "image/jpeg"] as const;
export type PhotoUploadType = (typeof PHOTO_UPLOAD_TYPES)[number];

const renditionSizeSchema = z.object({
  contentLength: z.number().int().positive().max(MAX_RENDITION_BYTES),
});

export const photoUploadSchema = z
  .object({
    contentType: z.enum(PHOTO_UPLOAD_TYPES),
    renditions: z.object({ thumb: renditionSizeSchema, full: renditionSizeSchema }),
    personId: uuidSchema.optional(),
    familyId: uuidSchema.optional(),
  })
  .refine((v) => Boolean(v.personId) !== Boolean(v.familyId), {
    message: "Provide exactly one of personId or familyId",
  });
export type PhotoUpload = z.infer<typeof photoUploadSchema>;

export interface PhotoUploadDto {
  /**
   * The prefix both renditions live under, ending in "/". This is what gets
   * stored in `photo_key` and handed back to the attach endpoint.
   */
  photoKey: string;
  uploadUrls: Record<PhotoRendition, string>;
}

/**
 * Attaching an already-uploaded photo, or clearing one with a null key.
 *
 * Dimensions are only meaningful for a family, whose crop is free-form; the
 * person endpoint ignores them.
 */
export const photoAttachSchema = z
  .object({
    photoKey: z.string().min(1).max(500).nullable(),
    photoWidth: z.number().int().positive().max(20000).nullable().optional(),
    photoHeight: z.number().int().positive().max(20000).nullable().optional(),
  })
  .refine((v) => v.photoKey === null || v.photoKey.endsWith("/"), {
    message: "A photo key must be the rendition prefix, ending in /",
    path: ["photoKey"],
  })
  .refine((v) => Boolean(v.photoWidth) === Boolean(v.photoHeight), {
    message: "Provide both photoWidth and photoHeight, or neither",
    path: ["photoWidth"],
  });
export type PhotoAttach = z.infer<typeof photoAttachSchema>;

// ---------------------------------------------------------------------------
// Shared helpers -- used by both the API and the SPA.
// ---------------------------------------------------------------------------

/** Days in a month; `year` null means "recurring", so February allows 29. */
export function daysInMonth(month: number, year: number | null): number {
  if (month === 2) {
    if (year == null) return 29;
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function isRealDate(month: number, day: number, year: number | null): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(month, year);
}

/**
 * Turns whatever someone typed into E.164, assuming +1 when no country code is
 * given (this is a US parish). Returns null if it cannot be made sense of, so
 * callers can surface a validation error rather than storing junk.
 */
export function normalizePhone(input: string, defaultCountryCode = "1"): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  const hadPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits === "") return null;

  let candidate: string;
  if (hadPlus) {
    candidate = `+${digits}`;
  } else if (digits.length === 10) {
    candidate = `+${defaultCountryCode}${digits}`;
  } else if (digits.length === 11 && digits.startsWith("1")) {
    candidate = `+${digits}`;
  } else {
    candidate = `+${digits}`;
  }

  return E164_PATTERN.test(candidate) ? candidate : null;
}

/** `+13125551234` -> `(312) 555-1234`; anything else is returned unchanged. */
export function formatPhone(e164: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (!match) return e164;
  return `(${match[1]}) ${match[2]}-${match[3]}`;
}

export function fullName(person: { firstName: string; lastName: string | null }): string {
  return [person.firstName, person.lastName].filter(Boolean).join(" ");
}
