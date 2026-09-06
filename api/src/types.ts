/**
 * Request/response contracts, as Zod schemas so validation and TypeScript
 * types come from one definition. The SPA imports this module through the
 * `@shared` alias (see app/vite.config.ts) so both sides agree on the shape of
 * every payload and the client can validate forms before submitting.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums -- these mirror the CHECK constraints in db/migrations/V1__init.sql
// (and, for the role list, V7__prayer_request_admin_role.sql).
// ---------------------------------------------------------------------------
export const ROLES = ["SUPER_ADMIN", "ADMIN", "PRAYER_REQUEST_ADMIN", "USER"] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

/**
 * The role hierarchy, as a rank -- because it is a hierarchy and not a set of
 * independent permissions. A Super Admin can do everything an Admin can, an
 * Admin everything a User can, and a Prayer Request Admin is a User with one
 * extra privilege, so it slots in between.
 *
 * Written once here and shared, because the same question is asked in three
 * places -- `requireRole` on the server, the nav and route guards in the SPA,
 * and `MeContext` -- and a hierarchy spelled out separately in each is a
 * hierarchy that will eventually disagree with itself.
 */
const ROLE_RANK: Record<Role, number> = {
  USER: 0,
  PRAYER_REQUEST_ADMIN: 1,
  ADMIN: 2,
  SUPER_ADMIN: 3,
};

/** Whether `role` is at least `floor` in the hierarchy above. */
export function hasRole(role: Role, floor: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[floor];
}

/**
 * Every role at or above `floor`, for the queries that have to ask the question
 * in SQL.
 *
 * Derived rather than written out, so `ROLE_RANK` stays the only ladder. The
 * alternative -- a role list in a WHERE clause -- is a second copy of the
 * hierarchy in a language where nobody will notice it drifting, which is the
 * whole thing `hasRole` exists to prevent.
 */
export function rolesAtLeast(floor: Role): Role[] {
  return ROLES.filter((role) => hasRole(role, floor));
}

export const USER_STATUSES = ["INVITED", "ACTIVE", "DISABLED"] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const SPECIAL_DATE_TYPES = ["BIRTHDAY", "ANNIVERSARY", "FEAST_DAY"] as const;
export const specialDateTypeSchema = z.enum(SPECIAL_DATE_TYPES);
export type SpecialDateType = z.infer<typeof specialDateTypeSchema>;

/**
 * Every `entity_type` the audit log records. Unlike the enums above this one
 * mirrors no CHECK constraint -- `audit_log.entity_type` is plain text, for the
 * reason V13__audit_log_browse.sql explains -- so it is a label list, not a
 * gate. Nothing validates an incoming filter against it.
 */
export const AUDIT_ENTITY_TYPES = [
  "person",
  "family",
  "appUser",
  "organization",
  "prayerRequest",
  "specialDate",
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * Every `action` the audit log currently records, in the order the log's filter
 * should offer them: grouped by what they act on, and within a group roughly by
 * lifecycle rather than alphabetically, because "create, update, delete" is how
 * somebody scans a list like this.
 *
 * This is for labels and for ordering only. It is emphatically **not** the set
 * of actions the API will filter by, and the read path never checks an action
 * against it -- see the note on `auditActionLabel` below. The list is kept
 * honest by api/test/audit-actions.test.ts, which reads the route sources and
 * fails when one of them writes an action that is missing here.
 */
export const AUDIT_ACTIONS = [
  "person.create",
  "person.update",
  "person.delete",
  "person.merge",
  "person.mergeRequest",
  "person.mergeRequest.approve",
  "person.mergeRequest.deny",

  "family.create",
  "family.update",
  "family.delete",
  "family.join",
  "family.joinRequest.approve",
  "family.joinRequest.deny",
  "family.addMember",
  "family.removeMember",
  "family.reorderMembers",

  "user.invite",
  "user.update",
  "user.delete",
  "user.changeEmail",
  "user.adoptParish",
  "user.changeParish",

  "organization.create",
  "organization.update",

  "prayerRequest.create",
  "prayerRequest.post",
  "prayerRequest.approve",
  "prayerRequest.reject",
  "prayerRequest.delete",

  "specialDate.create",
  "specialDate.update",
  "specialDate.delete",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  "person.create": "Person added",
  "person.update": "Person edited",
  "person.delete": "Person deleted",
  "person.merge": "People merged",
  "person.mergeRequest": "Merge requested",
  "person.mergeRequest.approve": "Merge approved",
  "person.mergeRequest.deny": "Merge declined",

  "family.create": "Family created",
  "family.update": "Family edited",
  "family.delete": "Family deleted",
  "family.join": "Joined a family",
  "family.joinRequest.approve": "Join approved",
  "family.joinRequest.deny": "Join declined",
  "family.addMember": "Family member added",
  "family.removeMember": "Family member removed",
  "family.reorderMembers": "Family reordered",

  "user.invite": "Account invited",
  "user.update": "Account edited",
  "user.delete": "Account deleted",
  "user.changeEmail": "Sign-in address changed",
  "user.adoptParish": "Given a parish",
  "user.changeParish": "Moved parish",

  "organization.create": "Church created",
  "organization.update": "Church edited",

  "prayerRequest.create": "Prayer request submitted",
  "prayerRequest.post": "Prayer request posted",
  "prayerRequest.approve": "Prayer request approved",
  "prayerRequest.reject": "Prayer request declined",
  "prayerRequest.delete": "Prayer request deleted",

  "specialDate.create": "Special date added",
  "specialDate.update": "Special date edited",
  "specialDate.delete": "Special date deleted",
};

/**
 * A human label for an action, falling back to the raw string.
 *
 * The fallback is the whole point. Actions are written as inline literals at
 * nearly thirty call sites with nothing enforcing this list, so the first thing
 * that happens after somebody adds one is that it reaches the log before it
 * reaches `AUDIT_ACTIONS`. Showing `family.archive` verbatim is a small
 * cosmetic wrong; hiding the row, or refusing the filter, would be a hole in an
 * audit trail, which is the one thing this page must not have.
 */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action as AuditAction] ?? action;
}

const AUDIT_ENTITY_TYPE_LABELS: Record<AuditEntityType, string> = {
  person: "Person",
  family: "Family",
  appUser: "Account",
  organization: "Church",
  prayerRequest: "Prayer request",
  specialDate: "Special date",
};

export function auditEntityTypeLabel(entityType: string): string {
  return AUDIT_ENTITY_TYPE_LABELS[entityType as AuditEntityType] ?? entityType;
}

export const JOIN_REQUEST_STATUSES = ["PENDING", "APPROVED", "DENIED", "CANCELLED"] as const;
export const joinRequestStatusSchema = z.enum(JOIN_REQUEST_STATUSES);
export type JoinRequestStatus = z.infer<typeof joinRequestStatusSchema>;

// A merge request has the same four states as a join request, but they are
// separate enums on purpose: nothing should be able to pass one where the other
// is meant, and the two lifecycles are free to diverge.
export const MERGE_REQUEST_STATUSES = ["PENDING", "APPROVED", "DENIED", "CANCELLED"] as const;
export const mergeRequestStatusSchema = z.enum(MERGE_REQUEST_STATUSES);
export type MergeRequestStatus = z.infer<typeof mergeRequestStatusSchema>;

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
 * One row of a type-ahead picker. Deliberately not a PersonSummaryDto: a
 * picker needs a name to show and an id to store, and sending the whole
 * resolved record per keystroke would be the slow part.
 *
 * `familyName` is carried so two people with the same name can be told apart.
 */
export interface PersonLookupDto {
  id: string;
  name: string;
  familyName: string | null;
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

/**
 * A custom member order, as the complete ordered list rather than one move.
 *
 * Whole-list replacement makes the write idempotent and means no fractional
 * index ever has to be rebalanced; a family is small enough that sending all of
 * it costs nothing. The API rejects a list that is not exactly the family's
 * current membership, since a partial one would silently strand whoever was
 * left out.
 */
export const familyMemberOrderSchema = z.object({
  personIds: z.array(uuidSchema).min(1).max(200),
});
export type FamilyMemberOrder = z.infer<typeof familyMemberOrderSchema>;

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

/**
 * A member as the family page needs them: a directory summary plus the one
 * derived fact that page shows and no other listing does.
 *
 * Age is not on PersonSummaryDto because it is not free -- it means joining
 * special_dates -- and the directory has no use for it.
 */
export interface FamilyMemberDto extends PersonSummaryDto {
  /**
   * Whole years old today. Null unless a birthday with a year is on record
   * *and* the person opted in to showing their age, so this can never disclose
   * what `canSeeSpecialDateYear` withholds.
   */
  age: number | null;
}

/**
 * A wedding anniversary shared by two members of the same family, so the page
 * can mark both halves of the couple.
 *
 * Stored as one special_dates row per couple, which is why this is a family-
 * level list rather than a field on each member: the pair is the fact.
 */
export interface FamilyAnniversaryDto {
  /** Both spouses. Each is a member of this family. */
  personIds: [string, string];
  month: number;
  day: number;
  /** Whole years married today. Null unless they opted in to showing it. */
  yearCount: number | null;
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
  /** In the family's custom order, or by name where none has been set. */
  members: FamilyMemberDto[];
  /** Every couple in this family, for marking who is married to whom. */
  anniversaries: FamilyAnniversaryDto[];
  /** Requests waiting on the caller to decide. Empty unless `canEdit`. */
  pendingJoinRequests: JoinRequestDto[];
  /**
   * The caller's *own* undecided request to join this family, if any -- the
   * other side of `pendingJoinRequests`, and never set at the same time as it:
   * `canEditFamily` is admin-or-member, an admin's request is approved on the
   * spot, and a member cannot ask to join the family they are already in.
   *
   * Its own field rather than a row in that list, because the list is only
   * populated for someone who can decide: a would-be member has no business
   * seeing who else has asked, but they must be able to see that *they* have.
   * Without it, asking twice is the only way to find out, and that answers
   * with a 409.
   */
  myPendingJoinRequestId: string | null;
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
// Merging two person records
//
// One person can end up with two `persons` rows: one the family created with no
// account, and one the invite flow created with an account. Merging them is
// gated by approval from whichever side did not ask -- see
// V5__person_merge_requests.sql for the two routes in.
// ---------------------------------------------------------------------------
export const mergeRequestCreateSchema = z.object({
  /** The record that survives. Must be the one holding the account. */
  accountPersonId: uuidSchema,
  /** The account-less duplicate, soft-deleted when the merge goes through. */
  duplicatePersonId: uuidSchema,
});
export type MergeRequestCreate = z.infer<typeof mergeRequestCreateSchema>;

export interface MergeRequestDto {
  id: string;
  accountPersonId: string;
  accountPersonName: string;
  duplicatePersonId: string;
  duplicatePersonName: string;
  duplicateFamilyId: string | null;
  duplicateFamilyName: string | null;
  requestedByPersonId: string;
  requestedByPersonName: string;
  status: MergeRequestStatus;
  requestedAt: string;
  decidedAt: string | null;
  /**
   * Whether *this* caller may approve or deny it. Carried on the row so one
   * endpoint serves both the banner (which shows the ones they can act on) and
   * the merge buttons (which hide themselves when anything is already pending).
   */
  canDecide: boolean;
}

/**
 * What a merge did, including what it had to throw away.
 *
 * The discarded counts exist for the same reason as
 * `OrganizationMoveDto.removedAnniversaries`: the schema allows one birthday
 * and one feast day per person and one anniversary per couple, so when both
 * records carry one, the duplicate's copy cannot survive. Losing it quietly
 * would be worse than saying so.
 */
export interface PersonMergeResultDto {
  /** The surviving person -- the account holder. */
  personId: string;
  /** The duplicate, now soft-deleted. */
  mergedPersonId: string;
  familyId: string | null;
  /** True when the survivor moved into the duplicate's family. */
  movedFamily: boolean;
  discardedBirthdays: number;
  discardedFeastDays: number;
  discardedAnniversaries: number;
}

// ---------------------------------------------------------------------------
// Prayer requests
//
// A member asks the parish to pray for someone; a PRAYER_REQUEST_ADMIN decides
// whether it is posted. See V8__prayer_requests.sql for why the two timestamps
// are not interchangeable.
// ---------------------------------------------------------------------------
export const PRAYER_REQUEST_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export const prayerRequestStatusSchema = z.enum(PRAYER_REQUEST_STATUSES);
export type PrayerRequestStatus = z.infer<typeof prayerRequestStatusSchema>;

/**
 * Four images. Not a technical limit -- a request is a short paragraph asking
 * for prayer, and the page has to stay readable when a dozen of them are
 * stacked on a phone. Enforced here so the browser and the server agree.
 */
export const PRAYER_REQUEST_MAX_IMAGES = 4;
export const PRAYER_REQUEST_TITLE_MAX = 120;
export const PRAYER_REQUEST_BODY_MAX = 4000;
export const PRAYER_REQUEST_REASON_MAX = 500;

/**
 * One already-uploaded attachment. `photoKey` is the rendition prefix the
 * browser got back from `POST /uploads/prayer-request-image`; the server checks
 * it belongs to this caller before storing it.
 *
 * Dimensions are required rather than optional, unlike `photoAttachSchema`:
 * there are no legacy attachments to be tolerant of, and the page needs them to
 * reserve each image's box.
 */
export const prayerRequestImageSchema = z.object({
  photoKey: z
    .string()
    .min(1)
    .max(500)
    .endsWith("/", "A photo key must be the rendition prefix, ending in /"),
  width: z.number().int().positive().max(20000),
  height: z.number().int().positive().max(20000),
});
export type PrayerRequestImage = z.infer<typeof prayerRequestImageSchema>;

export const prayerRequestCreateSchema = z.object({
  title: z.string().trim().min(1, "A title is required").max(PRAYER_REQUEST_TITLE_MAX),
  body: z.string().trim().min(1, "Say what you would like prayed for").max(PRAYER_REQUEST_BODY_MAX),
  images: z.array(prayerRequestImageSchema).max(PRAYER_REQUEST_MAX_IMAGES).default([]),
});
export type PrayerRequestCreate = z.infer<typeof prayerRequestCreateSchema>;

/**
 * Rejecting a request. The reason is optional and is shown only to the author --
 * a reviewer should not have to justify declining something, but "the family
 * asked us not to share this yet" is worth being able to say.
 */
export const prayerRequestRejectSchema = z.object({
  reason: trimmedOptional(PRAYER_REQUEST_REASON_MAX),
});
export type PrayerRequestReject = z.infer<typeof prayerRequestRejectSchema>;

export interface PrayerRequestImageDto {
  id: string;
  /** Permanent same-origin paths, as for every other photo. */
  thumbUrl: string | null;
  fullUrl: string | null;
  width: number | null;
  height: number | null;
}

export interface PrayerRequestDto {
  id: string;
  title: string;
  body: string;
  status: PrayerRequestStatus;
  authorPersonId: string;
  authorName: string;
  /** When the author wrote it. */
  submittedAt: string;
  /** When it was approved, which is what the page is ordered by. Null until then. */
  postedAt: string | null;
  decidedAt: string | null;
  /**
   * The reviewer who decided it, resolved to a name. Null when nobody has yet,
   * when their record has since been deleted, or when the caller is neither the
   * author nor a reviewer -- see toPrayerRequest for why that last one matters.
   */
  decidedByName: string | null;
  /** Only ever set on a REJECTED request, and only sent to its author. */
  rejectionReason: string | null;
  images: PrayerRequestImageDto[];
  /**
   * Per-row capability flags, as on PersonDto.canEdit and
   * MergeRequestDto.canDecide -- the SPA renders off these rather than
   * re-deriving the rules, so one endpoint serves the member's page and the
   * reviewer's queue.
   */
  canDecide: boolean;
  canDelete: boolean;
  /** True when the caller wrote it; what puts a row in the "Yours" section. */
  isMine: boolean;
}

// ---------------------------------------------------------------------------
// Notifications
//
// The bell in the nav. One row per recipient per event, so "unread" is a fact
// about a person; see V9__notifications.sql.
// ---------------------------------------------------------------------------
export const NOTIFICATION_TYPES = ["PRAYER_REQUEST", "PRAYER_REQUEST_REVIEW"] as const;
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export interface NotificationDto {
  id: string;
  type: NotificationType;
  /**
   * The prayer request's title.
   *
   * For `PRAYER_REQUEST` that is the whole of the message. For
   * `PRAYER_REQUEST_REVIEW` the message is "this one needs you", so the type
   * carries the meaning and the title only says which request -- the bell
   * renders a different subtitle for each.
   */
  title: string;
  prayerRequestId: string | null;
  createdAt: string;
  read: boolean;
}

export interface InboxDto {
  /** What the badge shows. Zero means no badge at all, not a badge reading 0. */
  unreadCount: number;
  notifications: NotificationDto[];
}

/**
 * What somebody wants to be told about.
 *
 * Two independent things, not one with a sub-setting: `prayerRequests` is news
 * (something was posted for the parish) and `prayerRequestReviews` is work
 * (something needs your approval before anyone can see it). An approver may
 * reasonably want either without the other, which is why one switch could not
 * serve both.
 *
 * `prayerRequestReviews` is only ever read for accounts that may approve, so it
 * is harmless on everyone else's row and the settings page simply does not show
 * it to them.
 *
 * Both optional, so the page can send just the one that changed.
 */
export const notificationPreferencesSchema = z.object({
  prayerRequests: z.boolean().optional(),
  prayerRequestReviews: z.boolean().optional(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export interface NotificationPreferencesDto {
  prayerRequests: boolean;
  prayerRequestReviews: boolean;
}

/**
 * A Web Push subscription, exactly as `PushManager.subscribe()` hands it over.
 *
 * The shape is the browser's, not ours, which is why it nests `keys` -- the SPA
 * passes `subscription.toJSON()` straight through and nothing has to know how
 * RFC 8291 names its two secrets.
 */
export const pushSubscribeSchema = z.object({
  endpoint: z.string().url().max(1000).startsWith("https://"),
  keys: z.object({
    p256dh: z.string().min(1).max(400),
    auth: z.string().min(1).max(400),
  }),
});
export type PushSubscribe = z.infer<typeof pushSubscribeSchema>;

export const pushUnsubscribeSchema = z.object({
  endpoint: z.string().url().max(1000),
});
export type PushUnsubscribe = z.infer<typeof pushUnsubscribeSchema>;

export interface PushSubscriptionDto {
  subscribed: boolean;
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
  /**
   * Null both when no year was recorded and when this viewer may not see the
   * one that was -- deliberately indistinguishable, since telling the two apart
   * would leak the very fact that a hidden year exists. See
   * canSeeSpecialDateYear in services/persons.ts.
   */
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
  /**
   * The VAPID public key for Web Push, or null when this deployment has no
   * keypair -- local development, or a stack deployed before the keys existed.
   * Null is what the settings page reads as "push is not available here".
   */
  pushPublicKey: string | null;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
/**
 * Who did it.
 *
 * Every field is nullable because `audit_log.actor_app_user_id` is `on delete
 * set null`: deleting an account blanks the actor on everything it ever did,
 * and no copy of the name was denormalized onto the row. An entry whose actor
 * cannot be named is still an entry, so this degrades rather than disappears.
 */
export interface AuditActorDto {
  appUserId: string | null;
  email: string | null;
  name: string | null;
}

/** What it was done to, resolved for display at read time. */
export interface AuditTargetDto {
  /** The person's name, the family's or church's name, the request's title. */
  label: string | null;
  /**
   * The row pointed at is gone. `entity_id` is deliberately not a foreign key
   * so that the trail outlives what it describes, which means "deleted" is a
   * normal state here and not an error.
   */
  missing: boolean;
}

export interface AuditLogEntryDto {
  /**
   * A string, not a number. `id` is a bigserial, and node-postgres returns int8
   * as text rather than silently rounding past 2^53.
   */
  id: string;
  /** An ISO instant, not a calendar date. */
  createdAt: string;
  /**
   * Typed as a plain string rather than `AuditAction`. The database is the
   * authority on what has been recorded; `AUDIT_ACTIONS` is only a label list,
   * and an entry with an action missing from it must still reach the page.
   */
  action: string;
  entityType: string;
  entityId: string | null;
  actor: AuditActorDto;
  target: AuditTargetDto;
  /** Untyped by nature -- every call site passes its own shape, and some pass none. */
  changes: unknown;
  /**
   * The entry belongs to no organization, which happens when a super admin acts
   * before choosing a parish -- creating one, mostly. Only super admins are
   * shown these, and the page badges them so they are not read as this parish's.
   */
  unassignedOrganization: boolean;
}

export interface AuditLogCursor {
  createdAt: string;
  id: string;
}

export interface AuditLogPageDto {
  entries: AuditLogEntryDto[];
  nextCursor: AuditLogCursor | null;
}

/**
 * What the action and entity type filters can offer, taken from the rows
 * themselves rather than from `AUDIT_ACTIONS`.
 *
 * Derived for two reasons. It cannot hide a row -- an action nobody has added
 * to the constant still appears here the first time it is written -- and it
 * never offers a filter that returns nothing, which also means it never offers
 * an action no part of the app can actually produce.
 *
 * Actors are deliberately not here. There is one of those per account that has
 * ever done anything, so the list has no ceiling worth shipping to a browser;
 * they are searched a few at a time through `GET /api/audit/actors` instead.
 */
export interface AuditLogFilterOptionsDto {
  actions: string[];
  entityTypes: string[];
}

/**
 * Actors matching a typed term, or the specific ones a saved filter names.
 *
 * Two modes on one endpoint because the picker needs both and they answer the
 * same question: searching as somebody types, and resolving the ids already in
 * the URL back into names so the chips can say who they are.
 */
export interface AuditActorLookupDto {
  actors: AuditActorDto[];
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

/**
 * Presigning the renditions for one prayer request attachment.
 *
 * No owner field, unlike `photoUploadSchema`: an attachment always belongs to
 * the caller's own person record, so there is nothing here to aim at somebody
 * else. See buildPhotoKey in api/src/photos.ts for why the key is scoped to the
 * author rather than to the request.
 */
export const prayerRequestImageUploadSchema = z.object({
  contentType: z.enum(PHOTO_UPLOAD_TYPES),
  renditions: z.object({ thumb: renditionSizeSchema, full: renditionSizeSchema }),
});
export type PrayerRequestImageUpload = z.infer<typeof prayerRequestImageUploadSchema>;

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
