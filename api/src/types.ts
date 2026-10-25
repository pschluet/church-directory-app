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

const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: "Super administrator",
  ADMIN: "Administrator",
  PRAYER_REQUEST_ADMIN: "Prayer request administrator",
  USER: "Member",
};

/**
 * A human label for a role, falling back to the raw string.
 *
 * Shared with the audit log, which finds `role` sitting in a payload next to
 * values the admin screen already has a name for -- `AdminUsers` used to
 * declare this label set for itself alone.
 */
export function roleLabel(role: string): string {
  return ROLE_LABELS[role as Role] ?? role;
}

export const USER_STATUSES = ["INVITED", "ACTIVE", "DISABLED"] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

const USER_STATUS_LABELS: Record<UserStatus, string> = {
  ACTIVE: "Active",
  INVITED: "Invited",
  DISABLED: "Disabled",
};

/** A human label for an account status, falling back to the raw string. */
export function userStatusLabel(status: string): string {
  return USER_STATUS_LABELS[status as UserStatus] ?? status;
}

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
  "group",
  "groupPost",
  "directoryRequest",
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
  "person.photo",
  "person.merge",
  "person.mergeRequest",
  "person.mergeRequest.approve",
  "person.mergeRequest.deny",

  "family.create",
  "family.update",
  "family.photo",
  "family.delete",
  "family.join",
  "family.joinRequest",
  "family.joinRequest.approve",
  "family.joinRequest.deny",
  "family.addMember",
  "family.removeMember",
  "family.reorderMembers",

  "user.invite",
  "user.update",
  "user.delete",
  "user.changeEmail",
  "user.changeNotifications",
  "user.adoptParish",
  "user.changeParish",
  "user.agreeGroupGuidelines",

  "directoryRequest.approve",
  "directoryRequest.decline",

  "organization.create",
  "organization.update",
  "organization.updateAddress",

  "prayerRequest.create",
  "prayerRequest.post",
  "prayerRequest.approve",
  "prayerRequest.reject",
  "prayerRequest.delete",

  "specialDate.create",
  "specialDate.update",
  "specialDate.delete",

  "group.create",
  "group.update",
  "group.convertVisibility",
  "group.archive",
  "group.delete",
  "group.addMember",
  "group.removeMember",
  "group.leave",
  "group.promoteAdmin",
  "group.demoteAdmin",
  "group.approveJoinRequest",
  "group.denyJoinRequest",
  "group.post.adminDelete",
  "group.post.report",
  "group.post.resolveReport",
  "group.post.dismissReport",
  "group.post.expire",
  "group.publicRsvp.delete",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  "person.create": "Person added",
  "person.update": "Person edited",
  "person.delete": "Person deleted",
  "person.photo": "Photo changed",
  "person.merge": "People merged",
  "person.mergeRequest": "Merge requested",
  "person.mergeRequest.approve": "Merge approved",
  "person.mergeRequest.deny": "Merge declined",

  "family.create": "Family created",
  "family.update": "Family edited",
  "family.photo": "Photo changed",
  "family.delete": "Family deleted",
  "family.join": "Joined a family",
  "family.joinRequest": "Join requested",
  "family.joinRequest.approve": "Join approved",
  "family.joinRequest.deny": "Join declined",
  "family.addMember": "Family member added",
  "family.removeMember": "Family member removed",
  "family.reorderMembers": "Family reordered",

  "user.invite": "Account invited",
  "user.update": "Account edited",
  "user.delete": "Account deleted",
  "user.changeEmail": "Sign-in address changed",
  "user.changeNotifications": "Notification settings changed",
  "user.adoptParish": "Given a parish",
  "user.changeParish": "Moved parish",
  "user.agreeGroupGuidelines": "Agreed to group guidelines",

  "directoryRequest.approve": "Directory request approved",
  "directoryRequest.decline": "Directory request declined",

  "organization.create": "Church created",
  "organization.update": "Church edited",
  "organization.updateAddress": "Church address edited",

  "prayerRequest.create": "Prayer request submitted",
  "prayerRequest.post": "Prayer request posted",
  "prayerRequest.approve": "Prayer request approved",
  "prayerRequest.reject": "Prayer request declined",
  "prayerRequest.delete": "Prayer request deleted",

  "specialDate.create": "Special date added",
  "specialDate.update": "Special date edited",
  "specialDate.delete": "Special date deleted",

  "group.create": "Group created",
  "group.update": "Group edited",
  "group.convertVisibility": "Group visibility changed",
  "group.archive": "Group archived",
  "group.delete": "Group deleted",
  "group.addMember": "Group member added",
  "group.removeMember": "Group member removed",
  "group.leave": "Left a group",
  "group.promoteAdmin": "Made a group admin",
  "group.demoteAdmin": "Removed as group admin",
  "group.approveJoinRequest": "Group join approved",
  "group.denyJoinRequest": "Group join declined",
  "group.post.adminDelete": "Group post removed by an admin",
  "group.post.report": "Group post reported",
  "group.post.resolveReport": "Group post report resolved",
  "group.post.dismissReport": "Group post report dismissed",
  "group.post.expire": "Group posts expired",
  "group.publicRsvp.delete": "Public RSVP removed",
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
  group: "Group",
  groupPost: "Group post",
  directoryRequest: "Directory request",
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
  /**
   * Google's identifier for the address, from Places Autocomplete.
   *
   * The only part of the geocode a client is allowed to send. Coordinates are
   * resolved from this on the server, because a payload that carried its own
   * latitude would let anyone put themselves on the church roof.
   *
   * Null for an address typed by hand, which falls through to geocoding the
   * text instead.
   */
  placeId: trimmedOptional(255),
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
  occupation: trimmedOptional(100),
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
  /**
   * Google's identifier for this address, or null when it has never been
   * geocoded. Sent back so the edit form can hand it straight to a PATCH that
   * did not touch the address, rather than dropping the pin on every save.
   */
  placeId: string | null;
  patronSaint: string | null;
  occupation: string | null;
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
  /**
   * Set when the address saved but could not be placed on the map.
   *
   * A warning rather than a 400, because the save did work: refusing it would
   * tell somebody their address is invalid when it is merely one Google has
   * never heard of, and there is no version of it they could type that would
   * be guaranteed to pass. Only ever present on the response to a write.
   */
  geocodeWarning?: string;
  /**
   * Set instead of actually changing `email` when this person has an account
   * and the save asked to change it to something new: a code was emailed to
   * it and the change is on hold until `POST /me/email/confirm` is called
   * with it. See services/email-change.ts. Only ever present on the response
   * to a write that touched the address of the caller's own account.
   */
  pendingEmailChange?: PendingEmailChangeDto;
}

/**
 * A self-service sign-in email change that has been requested but not yet
 * confirmed with its code.
 */
export interface PendingEmailChangeDto {
  email: string;
  expiresAt: string;
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
  /** Every member's first name, in family order. */
  memberNames: string[];
  /** The family photo's thumbnail, for the card banner. */
  thumbUrl: string | null;
  /**
   * A second crop framed for this exact card -- 3:2, rounded top corners --
   * taken from the whole photo rather than from `thumbUrl`'s crop. Null until
   * someone frames one; the card falls back to `thumbUrl` until then.
   */
  cardUrl: string | null;
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
  /** See FamilySummaryDto.cardUrl. */
  cardUrl: string | null;
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
  /**
   * The author's name in parts rather than composed, as PersonSummaryDto sends
   * it: the page hands the same two fields to Avatar, whose initials fallback
   * needs them apart, and composes the display name with fullName().
   */
  authorFirstName: string;
  authorLastName: string | null;
  /**
   * The author's photo, the same small square rendition the directory uses. No
   * `fullUrl` companion: from a list the avatar links to the record rather than
   * opening a lightbox (see PersonCard), so the full size is never wanted here.
   */
  authorThumbUrl: string | null;
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
  /** May add or remove the caller's own emoji reactions: posted requests only. */
  canReact: boolean;
  /** True when the caller wrote it; what puts a row in the "Yours" section. */
  isMine: boolean;
  /** In the order each emoji was first used; always empty until it is posted. */
  reactions: ReactionDto[];
}

/** What an open prayer requests page polls: see V28__prayer_request_reactions.sql. */
export interface PrayerRequestsLiveDto {
  /** Changes whenever anything on the page does; only ever compared for difference. */
  activityAt: string;
}

// ---------------------------------------------------------------------------
// Notifications
//
// The bell in the nav. One row per recipient per event, so "unread" is a fact
// about a person; see V9__notifications.sql.
// ---------------------------------------------------------------------------
export const NOTIFICATION_TYPES = [
  "PRAYER_REQUEST",
  "PRAYER_REQUEST_REVIEW",
  "GROUP_POST",
  "GROUP_MENTION",
  "GROUP_JOIN_REQUEST",
  "GROUP_EVENT",
  "GROUP_POST_REPORT",
  "DIRECTORY_REQUEST",
] as const;
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export interface NotificationDto {
  id: string;
  type: NotificationType;
  /**
   * The prayer request's title, or the group's -- whichever this notification
   * is about. For `PRAYER_REQUEST` and every `GROUP_*` type this is the whole
   * of the message; `PRAYER_REQUEST_REVIEW` says "this one needs you" and the
   * title only names which request, same as the group types name which group.
   */
  title: string;
  prayerRequestId: string | null;
  groupId: string | null;
  groupPostId: string | null;
  /** Set only for `DIRECTORY_REQUEST`, whose title is the requester's name. */
  directoryRequestId: string | null;
  createdAt: string;
  read: boolean;
}

export interface InboxDto {
  /** What the badge shows. Zero means no badge at all, not a badge reading 0. */
  unreadCount: number;
  notifications: NotificationDto[];
}

export const GROUP_NOTIFICATION_PREFS = ["ALL", "MENTIONS", "NONE"] as const;
export const groupNotificationPrefSchema = z.enum(GROUP_NOTIFICATION_PREFS);
export type GroupNotificationPref = z.infer<typeof groupNotificationPrefSchema>;

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
  /** Administrators only: somebody asked to be added from the sign-in page. */
  directoryRequests: z.boolean().optional(),
  /** The default for every group; a group's own setting is an exception to it. */
  groupNotificationPref: groupNotificationPrefSchema.optional(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export interface NotificationPreferencesDto {
  prayerRequests: boolean;
  prayerRequestReviews: boolean;
  directoryRequests: boolean;
  groupNotificationPref: GroupNotificationPref;
  groupExceptions: GroupNotificationExceptionDto[];
}

/** A group whose notification setting differs from the account default. */
export interface GroupNotificationExceptionDto {
  groupId: string;
  groupTitle: string;
  /** May differ from the active parish for a super admin; the SPA only links when it matches. */
  organizationId: string;
  /** Never null: an exception is, by definition, a stated preference. */
  notificationPref: GroupNotificationPref;
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
// Groups
//
// Member-created spaces for messaging, files and events. See
// requirements/groups.md for the product rules and
// requirements/groups-plan.md for the engineering decisions; these enums
// mirror the CHECK constraints in db/migrations/V16__groups.sql.
// ---------------------------------------------------------------------------
export const GROUP_VISIBILITIES = ["PUBLIC", "PRIVATE", "SECRET"] as const;
export const groupVisibilitySchema = z.enum(GROUP_VISIBILITIES);
export type GroupVisibility = z.infer<typeof groupVisibilitySchema>;

const GROUP_VISIBILITY_LABELS: Record<GroupVisibility, string> = {
  PUBLIC: "Public",
  PRIVATE: "Private",
  SECRET: "Secret",
};

export function groupVisibilityLabel(visibility: string): string {
  return GROUP_VISIBILITY_LABELS[visibility as GroupVisibility] ?? visibility;
}

/**
 * Legal visibility conversions, as a lookup rather than a comparison.
 *
 * "A group can move toward being more closed, with one exception -- Secret can
 * loosen to Private -- and nothing may ever become Public again once changed"
 * reads like an ordering, but Secret -> Private is a loosening, so there is no
 * single direction to compare against. A table of the four allowed edges says
 * exactly what the product rule says, with nothing left to infer.
 */
const GROUP_VISIBILITY_CONVERSIONS: Record<GroupVisibility, readonly GroupVisibility[]> = {
  PUBLIC: ["PRIVATE", "SECRET"],
  PRIVATE: ["SECRET"],
  SECRET: ["PRIVATE"],
};

export function canConvertGroupVisibility(from: GroupVisibility, to: GroupVisibility): boolean {
  return GROUP_VISIBILITY_CONVERSIONS[from].includes(to);
}

export const GROUP_MEMBER_ROLES = ["ADMIN", "MEMBER"] as const;
export const groupMemberRoleSchema = z.enum(GROUP_MEMBER_ROLES);
export type GroupMemberRole = z.infer<typeof groupMemberRoleSchema>;

/**
 * One set of words for the three preferences, shared by the Settings page and
 * the group's own panel so the two cannot drift apart.
 */
export const GROUP_NOTIFICATION_PREF_LABELS: Record<GroupNotificationPref, string> = {
  ALL: "All messages",
  MENTIONS: "Only when I'm mentioned",
  NONE: "Nothing",
};

/**
 * A separate lifecycle from `JOIN_REQUEST_STATUSES`, even though the values
 * match -- the same reasoning `MERGE_REQUEST_STATUSES` gives for not reusing
 * the family one: nothing should be able to pass a family join-request status
 * where a group one belongs, and the two are free to diverge later.
 */
export const GROUP_JOIN_REQUEST_STATUSES = ["PENDING", "APPROVED", "DENIED", "CANCELLED"] as const;
export const groupJoinRequestStatusSchema = z.enum(GROUP_JOIN_REQUEST_STATUSES);
export type GroupJoinRequestStatus = z.infer<typeof groupJoinRequestStatusSchema>;

export const GROUP_POST_KINDS = ["MESSAGE", "EVENT"] as const;
export const groupPostKindSchema = z.enum(GROUP_POST_KINDS);
export type GroupPostKind = z.infer<typeof groupPostKindSchema>;

export const GROUP_ATTACHMENT_KINDS = ["IMAGE", "FILE"] as const;
export const groupAttachmentKindSchema = z.enum(GROUP_ATTACHMENT_KINDS);
export type GroupAttachmentKind = z.infer<typeof groupAttachmentKindSchema>;

export const GROUP_RSVP_RESPONSES = ["YES", "NO", "MAYBE"] as const;
export const groupRsvpResponseSchema = z.enum(GROUP_RSVP_RESPONSES);
export type GroupRsvpResponse = z.infer<typeof groupRsvpResponseSchema>;

const GROUP_RSVP_LABELS: Record<GroupRsvpResponse, string> = {
  YES: "Going",
  NO: "Not going",
  MAYBE: "Maybe",
};
export function groupRsvpResponseLabel(response: string): string {
  return GROUP_RSVP_LABELS[response as GroupRsvpResponse] ?? response;
}

export const GROUP_POST_REPORT_STATUSES = ["PENDING", "RESOLVED", "DISMISSED"] as const;
export const groupPostReportStatusSchema = z.enum(GROUP_POST_REPORT_STATUSES);
export type GroupPostReportStatus = z.infer<typeof groupPostReportStatusSchema>;

/**
 * How long a group post lives before retention hard-deletes it. One constant
 * read by both the scheduled purge (services/group-retention.ts) and this
 * schema's own documentation -- see requirements/groups.md's Retention section
 * for the product rule, including why a thread with a recent reply, or an
 * event not yet in the past, is exempt.
 */
export const POST_RETENTION_YEARS = 5;

export const GROUP_TITLE_MAX = 150;
export const GROUP_DESCRIPTION_MAX = 2000;
export const GROUP_POST_BODY_MAX = 4000;
/** "@everyone" in a post's text mentions every member of the group; see V27. */
export const GROUP_MENTION_EVERYONE = "everyone";
export const GROUP_EVENT_LOCATION_MAX = 200;
export const GROUP_EVENT_TITLE_MAX = 150;
export const GROUP_EVENT_DESCRIPTION_MAX = 2000;
export const GROUP_REPORT_REASON_MAX = 500;
/** Matches PRAYER_REQUEST_MAX_IMAGES's reasoning: a feed stays readable. */
export const GROUP_POST_MAX_ATTACHMENTS = 10;

export const groupCreateSchema = z.object({
  title: z.string().trim().min(1, "A group needs a title").max(GROUP_TITLE_MAX),
  description: trimmedOptional(GROUP_DESCRIPTION_MAX),
  visibility: groupVisibilitySchema.default("PUBLIC"),
});
export type GroupCreate = z.infer<typeof groupCreateSchema>;

export const groupUpdateSchema = z.object({
  title: z.string().trim().min(1, "A group needs a title").max(GROUP_TITLE_MAX),
  description: trimmedOptional(GROUP_DESCRIPTION_MAX),
});
export type GroupUpdate = z.infer<typeof groupUpdateSchema>;

export const groupVisibilityChangeSchema = z.object({ visibility: groupVisibilitySchema });
export type GroupVisibilityChange = z.infer<typeof groupVisibilityChangeSchema>;

/** The three admin-only posting/inviting/replying toggles, sent together. */
export const groupSettingsSchema = z.object({
  postingRestricted: z.boolean(),
  invitesRestricted: z.boolean(),
  repliesRestricted: z.boolean(),
});
export type GroupSettings = z.infer<typeof groupSettingsSchema>;

export const groupNotificationPrefUpdateSchema = z.object({
  /** Null means "follow my default" -- the exception is removed. */
  notificationPref: groupNotificationPrefSchema.nullable(),
});
export type GroupNotificationPrefUpdate = z.infer<typeof groupNotificationPrefUpdateSchema>;

export const groupMemberAddSchema = z.object({ personId: uuidSchema });
export type GroupMemberAdd = z.infer<typeof groupMemberAddSchema>;

/** One already-uploaded attachment, as POST /groups/:id/posts attaches it. */
export const groupPostAttachmentSchema = z.object({
  photoKey: z.string().min(1).max(500),
  kind: groupAttachmentKindSchema,
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().min(1).max(255),
  byteSize: z.number().int().positive(),
  width: z.number().int().positive().max(20000).optional(),
  height: z.number().int().positive().max(20000).optional(),
});
export type GroupPostAttachment = z.infer<typeof groupPostAttachmentSchema>;

const groupEventFieldsSchema = z
  .object({
    eventTitle: z.string().trim().min(1, "Give the event a title").max(GROUP_EVENT_TITLE_MAX),
    eventDescription: trimmedOptional(GROUP_EVENT_DESCRIPTION_MAX),
    /** yyyy-mm-dd, naive local -- see V16__groups.sql for why not timestamptz. */
    eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date"),
    /** HH:MM, 24-hour, naive local. */
    startTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable()
      .optional(),
    endTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable()
      .optional(),
    location: trimmedOptional(GROUP_EVENT_LOCATION_MAX),
    /**
     * Opens the event's share page to anyone with the link, and lets them RSVP
     * without an account. No `.default()`: absent on a PATCH means "leave it",
     * not "turn it off" -- an edit that only fixes the time must not quietly
     * close a page that is printed on a flyer. The create route reads absent
     * as false.
     */
    publicRsvpEnabled: z.boolean().optional(),
  })
  .refine((v) => !v.endTime || Boolean(v.startTime), {
    message: "An end time needs a start time",
    path: ["endTime"],
  });

export const groupPostCreateSchema = z
  .object({
    kind: groupPostKindSchema.default("MESSAGE"),
    body: trimmedOptional(GROUP_POST_BODY_MAX),
    parentPostId: uuidSchema.nullable().optional(),
    mentionedAppUserIds: z.array(uuidSchema).max(50).default([]),
    mentionsEveryone: z.boolean().default(false),
    attachments: z.array(groupPostAttachmentSchema).max(GROUP_POST_MAX_ATTACHMENTS).default([]),
    event: groupEventFieldsSchema.optional(),
  })
  .superRefine((value, ctx) => {
    // Words, or at least a picture or file to show: an attachment alone is a message.
    if (value.kind === "MESSAGE" && !value.body && value.attachments.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body"],
        message: "Say something, or attach a picture or file",
      });
    }
    if (value.kind === "EVENT" && !value.event) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["event"],
        message: "An event needs its details",
      });
    }
    if (value.kind === "EVENT" && value.parentPostId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentPostId"],
        message: "A reply cannot be an event",
      });
    }
  });
export type GroupPostCreate = z.infer<typeof groupPostCreateSchema>;

export const groupPostUpdateSchema = z.object({
  /** Absent leaves the text alone; blank clears it, which only a message that keeps an attachment may do. */
  body: trimmedOptional(GROUP_POST_BODY_MAX),
  /** Ids of this message's existing attachments to take off it. */
  removeAttachmentIds: z.array(uuidSchema).max(GROUP_POST_MAX_ATTACHMENTS).optional(),
  /** Newly uploaded attachments to add after the ones it already has. */
  addAttachments: z.array(groupPostAttachmentSchema).max(GROUP_POST_MAX_ATTACHMENTS).optional(),
  /** Absent leaves mentions alone, so an event-only edit cannot wipe them. */
  mentionedAppUserIds: z.array(uuidSchema).max(50).optional(),
  /** Absent leaves @everyone alone, for the same reason. */
  mentionsEveryone: z.boolean().optional(),
  event: groupEventFieldsSchema.optional(),
});
export type GroupPostUpdate = z.infer<typeof groupPostUpdateSchema>;

export const groupRsvpSchema = z.object({
  response: groupRsvpResponseSchema,
  guestCount: z.number().int().min(0).max(50).default(0),
});
export type GroupRsvp = z.infer<typeof groupRsvpSchema>;

/**
 * Most different emoji one group post or prayer request can carry, as Slack
 * caps it -- keeps a row of pills sane.
 */
export const REACTION_MAX_EMOJI = 20;

const EMOJI_GRAPHEME =
  /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u;

/**
 * Exactly one emoji: a single grapheme (so a skin tone, a ZWJ family, a flag or
 * a keycap each count as one) that begins like an emoji. Not the `v`-flag
 * RGI_Emoji property, which this file's ES2022 target cannot spell and an older
 * Safari -- this module is shared with the SPA -- would throw on at load.
 */
export function isSingleEmoji(value: string): boolean {
  return [...new Intl.Segmenter().segment(value)].length === 1 && EMOJI_GRAPHEME.test(value);
}

export const reactionEmojiSchema = z
  .string()
  .max(32)
  .refine(isSingleEmoji, { message: "That is not a single emoji" });

export const groupPostReportSchema = z.object({
  reason: trimmedOptional(GROUP_REPORT_REASON_MAX),
});
export type GroupPostReport = z.infer<typeof groupPostReportSchema>;

export interface GroupMemberDto {
  personId: string;
  appUserId: string;
  name: string;
  thumbUrl: string | null;
  role: GroupMemberRole;
  joinedAt: string;
}

export interface GroupJoinRequestDto {
  id: string;
  groupId: string;
  groupTitle: string;
  personId: string;
  personName: string;
  status: GroupJoinRequestStatus;
  requestedAt: string;
  decidedAt: string | null;
}

/** A row in the groups list. */
export interface GroupSummaryDto {
  id: string;
  title: string;
  description: string | null;
  thumbUrl: string | null;
  fullUrl: string | null;
  /** The groups-page card crop, or null until someone frames one. See FamilySummaryDto.cardUrl. */
  cardUrl: string | null;
  visibility: GroupVisibility;
  memberCount: number;
  archivedAt: string | null;
  /** The caller's own role, or null when they are not a member. */
  myRole: GroupMemberRole | null;
  /** Posts since the caller's `last_read_at` for this group. */
  unreadCount: number;
  /** The caller's own undecided request to join this group, if any. */
  pendingJoinRequestId: string | null;
  /** Whether the caller has pinned this group to the top of their list. */
  pinned: boolean;
}

export interface GroupDto extends GroupSummaryDto {
  organizationId: string;
  /**
   * The intrinsic size of the group photo, from its free-form crop -- same
   * reasoning as FamilyDto.photoWidth/Height: the page needs this to reserve
   * the box before the image paints. Null when there is no photo, or it
   * predates this field.
   */
  photoWidth: number | null;
  photoHeight: number | null;
  postingRestricted: boolean;
  invitesRestricted: boolean;
  repliesRestricted: boolean;
  createdByPersonId: string | null;
  createdByName: string | null;
  createdAt: string;
  members: GroupMemberDto[];
  /** Requests waiting on the caller to decide. Empty unless the caller is an admin. */
  pendingJoinRequests: GroupJoinRequestDto[];
  /** The caller's exception for this group, or null when they follow their default. */
  notificationPref: GroupNotificationPref | null;
  /** The caller's account-wide default, so the panel can name what "default" means. */
  notificationPrefDefault: GroupNotificationPref;
  /**
   * Per-row capability flags, as on PersonDto.canEdit -- the SPA renders off
   * these rather than re-deriving the membership/role/restriction rules in two
   * places. See services/groups.ts groupAccess for where they come from.
   */
  canPost: boolean;
  canInvite: boolean;
  canReply: boolean;
  /** May add or remove the caller's own emoji reactions. */
  canReact: boolean;
  canModerate: boolean;
  canConvertVisibility: GroupVisibility[];
  canArchive: boolean;
  canRequestToJoin: boolean;
  /**
   * True when the caller can see this group only because they are a parish
   * admin and not a member -- what the UI discloses (see
   * requirements/groups.md, Membership & Admins). Always false for Public
   * groups, which anyone can read.
   */
  viewingAsAdmin: boolean;
}

export interface GroupEventDto {
  title: string;
  description: string | null;
  eventDate: string;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  /**
   * Members' headcounts by answer, plus `publicAttending`: everyone who RSVP'd
   * through the public share page *and their guests*. Members' guests are not
   * in `yes` -- that is a count of people answering, as it always was.
   */
  rsvpCounts: { yes: number; no: number; maybe: number; publicAttending: number };
  /** The caller's own RSVP, or null if they have not answered. */
  myRsvp: { response: GroupRsvpResponse; guestCount: number } | null;
  /**
   * What /e/<shareToken> resolves. Only ever on this authenticated DTO, so only
   * somebody who can already read the event learns it. Never rotated.
   */
  shareToken: string;
  /** Whether the share page is open to people without an account. */
  publicRsvpEnabled: boolean;
}

/**
 * Somebody who RSVP'd through the public share page, without an account.
 * Always "going" -- the public form has no other answer.
 */
export interface PublicEventRsvpDto {
  id: string;
  firstName: string;
  lastName: string;
  guestCount: number;
  createdAt: string;
  /**
   * Only for the event's author and the group's moderators, who may need to
   * follow up; null for everyone else. A plain member reading the roster has
   * no reason to collect a stranger's address.
   */
  email: string | null;
}

/** Most public RSVPs one event takes before the endpoint answers 429. */
export const PUBLIC_RSVP_MAX_PER_EVENT = 500;

/** The public share page's RSVP form. Every field is required. */
export const publicEventRsvpSchema = z.object({
  firstName: z.string().trim().min(1, "Enter your first name").max(100),
  lastName: z.string().trim().min(1, "Enter your last name").max(100),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(254),
  // No .default(): the form requires the field, and 0 is a real answer to it.
  guestCount: z.number({ required_error: "Enter the number of guests" }).int().min(0).max(50),
});
export type PublicEventRsvpInput = z.infer<typeof publicEventRsvpSchema>;

/**
 * "Request to join" from the share page. The organization is the event's,
 * looked up from the token -- an anonymous caller never gets to name one.
 */
export const publicJoinRequestSchema = publicEventRsvpSchema.omit({ guestCount: true });
export type PublicJoinRequestInput = z.infer<typeof publicJoinRequestSchema>;

/**
 * An event as the public share page shows it, to anyone holding the URL.
 *
 * Only ever returned when the organizer ticked "Allow Public RSVP"; otherwise
 * the endpoint 404s, indistinguishable from a made-up token. Even then it
 * carries no names -- not the members', not other strangers' -- and no photos.
 */
export interface PublicEventDto {
  title: string;
  description: string | null;
  /** yyyy-mm-dd, naive local, as stored -- see V16__groups.sql. */
  eventDate: string;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  /** The post's soft delete. A cancelled event still answers, so a printed flyer can say so. */
  cancelled: boolean;
  publicRsvpEnabled: boolean;
  organizationName: string;
  /** PUBLIC groups only; null for PRIVATE and SECRET -- a secret group must not be named. */
  groupName: string | null;
  /**
   * Headcounts only, whatever the group's visibility. Never names.
   *
   * `attending` is everyone coming: members who said yes, their guests, and
   * everybody who RSVP'd through this page with theirs -- the same figure as
   * the roster's "total attending". `yes` counts members answering only.
   */
  rsvpCounts: { yes: number; no: number; maybe: number; attending: number };
  // No group or post id: a reader who signs in is sent on by
  // /api/events/by-token, so this payload never needs to carry a secret
  // group's id to anyone.
}

/** What /api/events/by-token/:token resolves a share token to, and nothing more. */
export interface EventTokenTargetDto {
  groupId: string;
  postId: string;
}

/**
 * One person's RSVP, for the full roster behind `GroupEventDto.rsvpCounts` --
 * that only ever carries headcounts, never who or how many guests. `guestCount`
 * is only ever nonzero for a YES, since `groupRsvpSchema` is the only place it
 * is written and nothing stops the field being set before a YES, but the UI
 * only surfaces it there.
 */
export interface GroupEventRsvpDto {
  appUserId: string;
  personId: string;
  name: string;
  thumbUrl: string | null;
  response: GroupRsvpResponse;
  guestCount: number;
}

export interface GroupPostAttachmentDto {
  id: string;
  kind: GroupAttachmentKind;
  filename: string;
  contentType: string;
  byteSize: number;
  /** Only set for an IMAGE attachment. */
  thumbUrl: string | null;
  fullUrl: string | null;
  width: number | null;
  height: number | null;
  /** The raw object, for a FILE attachment's download link. */
  downloadUrl: string | null;
}

export interface GroupPostMentionDto {
  appUserId: string;
  personId: string;
  name: string;
}

/**
 * Somebody who reacted. A group post's reactors carry no photo -- the group page
 * already has its member list to find one in -- while a prayer request's do,
 * since that page has no list of people to look them up from.
 */
export interface ReactorDto extends GroupPostMentionDto {
  thumbUrl?: string | null;
}

/**
 * One emoji on a group post or a prayer request, with everyone who put it
 * there, earliest first.
 */
export interface ReactionDto {
  emoji: string;
  /** Whether the caller is among `reactors` -- what highlights the pill and makes a click remove. */
  reactedByMe: boolean;
  reactors: ReactorDto[];
}

export interface GroupPostDto {
  id: string;
  groupId: string;
  authorPersonId: string;
  authorName: string;
  authorThumbUrl: string | null;
  parentPostId: string | null;
  kind: GroupPostKind;
  /** Null for a deleted post -- the tombstone copy is in `deletedAt`/`deletedBySelf`. */
  body: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  /** Whether the author removed it themselves, vs. a group or parish admin. */
  deletedBySelf: boolean | null;
  createdAt: string;
  attachments: GroupPostAttachmentDto[];
  mentions: GroupPostMentionDto[];
  /** Whether the post says "@everyone"; false for a deleted post. */
  mentionsEveryone: boolean;
  /** In the order each emoji was first used; empty for a deleted post. */
  reactions: ReactionDto[];
  event: GroupEventDto | null;
  /** How many replies exist, whether or not this response included them. */
  replyCount: number;
  /** When the newest reply was posted, or null with none -- what the feed's reply summary says. */
  lastReplyAt: string | null;
  canEdit: boolean;
  canDelete: boolean;
  canReport: boolean;
  /** A cancelled event its own author cancelled can be re-activated by that author. */
  canRestore: boolean;
}

export interface GroupPostReportDto {
  id: string;
  groupId: string;
  groupTitle: string;
  postId: string | null;
  postExcerpt: string;
  reporterName: string | null;
  reason: string | null;
  status: GroupPostReportStatus;
  createdAt: string;
}

/** One row of the Files tab -- an attachment plus enough of its post to show context. */
/**
 * What an open group page polls: a stamp that changes whenever anything in the
 * group does, and who else is typing right now.
 */
export interface GroupLiveDto {
  activityAt: string;
  typing: string[];
}

export interface GroupFileDto {
  postId: string;
  postCreatedAt: string;
  authorPersonId: string;
  authorName: string;
  attachment: GroupPostAttachmentDto;
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
// Map view
// ---------------------------------------------------------------------------
/**
 * One thing that lives at an address, as the map draws it.
 *
 * "If people share the exact same address AND are in the same family, show only
 * the family name; if people share an address that aren't in the same family,
 * you must show all of those people." So an address yields a mixture: one entry
 * per family with two or more people there, plus one entry per person who is
 * the only one of theirs there. A house shared by two families and a lodger is
 * three entries, not six people and not one address.
 *
 * A `"person"` entry is therefore not the same as somebody with no family. It
 * is whoever is on their own at this address -- a lodger, or the one member of
 * a household who lives here while the rest of them are elsewhere. There is no
 * group to name in either case, so both are shown as themselves.
 */
/**
 * One person at an address.
 *
 * Names arrive in parts rather than joined, because `Avatar` builds initials
 * from them and would otherwise have to split a string back up -- which gets
 * "Anna Maria Popov" wrong.
 */
export interface MapMemberDto {
  id: string;
  firstName: string;
  lastName: string | null;
  thumbUrl: string | null;
}

export interface MapOccupantDto {
  /**
   * `"family"` only when two or more of them live at this address. One on
   * their own is a `"person"`, however many relatives they have elsewhere.
   */
  kind: "family" | "person";
  /** A family id or a person id, depending on `kind`. */
  id: string;
  /** The family name, or the person's full name. */
  label: string;
  /**
   * For a family, everyone in it who lives here -- the drawer lists them and
   * each one links into the directory, and there are always at least two of
   * them. For a person, just themselves: the panel needs their name in parts
   * for an avatar, and a one-element list beats a second optional field that
   * only one of the two kinds ever fills in.
   */
  members: MapMemberDto[];
}

/** One pin. Everybody at the same address shares it, by construction. */
export interface MapLocationDto {
  placeId: string;
  latitude: number;
  longitude: number;
  formattedAddress: string;
  occupants: MapOccupantDto[];
}

export interface MapDto {
  /**
   * Where to open. Null when the parish has saved no church address, or has
   * saved one that would not geocode -- in which case the map centres on the
   * centroid of everybody instead, and admins are told to fix it.
   */
  church: { latitude: number; longitude: number; formattedAddress: string } | null;
  locations: MapLocationDto[];
  /**
   * How many people have an address that could not be placed. Shown to admins
   * as a count rather than a list: it is a prompt to go and look, and naming
   * them on a map page they are absent from would be a second directory.
   */
  unmappedCount: number;
}

// ---------------------------------------------------------------------------
// Admin: organizations and invitations
// ---------------------------------------------------------------------------
/**
 * The church's own address, and the switch that decides whether this parish
 * has a map at all.
 *
 * Split out from `organizationWriteSchema` because the two are edited by
 * different people. An admin may set their parish's address -- they are the
 * one warned that it is missing, and a warning about something only a super
 * admin can fix is a dead end -- but only a super admin may turn Map View on,
 * because that switch starts a billable Google integration.
 */
export const organizationAddressSchema = addressSchema;
export type OrganizationAddress = z.infer<typeof organizationAddressSchema>;

export const organizationWriteSchema = z.object({
  name: z.string().trim().min(1).max(150),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "Lowercase letters, numbers and hyphens only")
    .max(60),
  /**
   * Optional so that every caller written before the map existed still
   * validates. Absent means "leave it as it is", not "switch it off" -- this
   * schema is deliberately not `.partial()`, so the distinction has to be
   * carried by the field itself.
   */
  mapViewEnabled: z.boolean().optional(),
  ...organizationAddressSchema.shape,
});
export type OrganizationWrite = z.infer<typeof organizationWriteSchema>;

/**
 * The church's own address, as an administrator sees it.
 *
 * Narrower than `OrganizationDto` on purpose: it is what
 * `GET`/`PATCH /api/organizations/current` deal in, and those exist so an
 * administrator can fix the address Map View warns them about without being
 * handed -- or being able to change -- the parish name, its short name or the
 * Map View switch.
 */
export interface OrganizationAddressDto {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  placeId: string | null;
  /** Null until the address has been geocoded, or when it could not be. */
  latitude: number | null;
  longitude: number | null;
}

export interface OrganizationDto {
  id: string;
  name: string;
  slug: string;
  personCount: number;
  familyCount: number;
  /** Whether this parish has Map View. Super admins only may change it. */
  mapViewEnabled: boolean;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  placeId: string | null;
  /** Null until the church address has been geocoded. */
  latitude: number | null;
  longitude: number | null;
}

export const inviteUserSchema = z.object({
  email: emailSchema,
  firstName: z.string().trim().min(1).max(100),
  lastName: trimmedOptional(100),
  role: roleSchema,
  /**
   * The organization being viewed, or null to leave a SUPER_ADMIN invite
   * without a parish. Any other organization is refused; the account always
   * lands in the one being viewed.
   */
  organizationId: uuidSchema.nullable().optional(),
  /** Optionally place the new person straight into a family. */
  familyId: uuidSchema.nullable().optional(),
});
export type InviteUser = z.infer<typeof inviteUserSchema>;

/**
 * "Request to be added", from the sign-in page -- the one write anybody can
 * make without signing in.
 *
 * `website` is a honeypot: the field is hidden from people, so anything in it
 * was typed by a script, and the route accepts the request without keeping it.
 */
export const directoryRequestSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: emailSchema,
  organizationId: uuidSchema,
  website: z.string().max(500).optional(),
});
export type DirectoryRequestInput = z.infer<typeof directoryRequestSchema>;

/** A pending request, as People & Accounts lists it. */
export interface DirectoryRequestDto {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  organizationId: string;
  requestedAt: string;
}

/** A church as the sign-in page's picker shows it: nothing but its name. */
export interface DirectoryRequestChurchDto {
  id: string;
  name: string;
}

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

/** `POST /me/email` -- start a self-service change of the sign-in address. */
export const requestEmailChangeSchema = z.object({ email: emailSchema });
export type RequestEmailChange = z.infer<typeof requestEmailChangeSchema>;

/** `POST /me/email/confirm` -- the code emailed to the new address. */
export const confirmEmailChangeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code"),
});
export type ConfirmEmailChange = z.infer<typeof confirmEmailChangeSchema>;

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
  /**
   * Whether this parish has Map View. Gates the route, the Directory's link to
   * it, and the endpoint behind it.
   *
   * Read from the organization the caller is currently acting in, so a super
   * admin who switches to a parish without a map loses it too -- which is
   * right: they are looking at that parish, not at their own.
   */
  mapViewEnabled: boolean;
  /**
   * The Google Maps browser key, or null.
   *
   * Delivered here rather than baked into the bundle by a `VITE_` variable
   * because the bundle is public and gets scraped; behind the JWT authorizer it
   * only reaches people who are already signed in. It is not thereby a secret
   * -- anyone can read it in devtools -- which is why the key itself is
   * restricted to this site's referrers and capped in the Google console. This
   * only keeps it off the open internet.
   *
   * Null for two independent reasons: the deployment has no key, or this parish
   * has Map View switched off. The SPA does not need to tell them apart,
   * because `mapViewEnabled` has already sent anyone in the second case
   * somewhere else.
   */
  mapsBrowserKey: string | null;
  /**
   * The Map ID the styled vector map is published under. Not a secret, and
   * required rather than optional: Advanced Markers do not render without one.
   */
  mapsMapId: string | null;
  /**
   * The version of the group guidelines this account last agreed to, or null
   * if never. The groups pages ask again whenever it is not
   * `GROUP_GUIDELINES_VERSION`.
   */
  groupGuidelinesAgreedVersion: number | null;
  /** When that agreement was made, as an ISO timestamp, or null if never. */
  groupGuidelinesAgreedAt: string | null;
  /**
   * A self-service sign-in email change this account started but has not yet
   * confirmed, or null. Carried here (as well as on the write response that
   * started it) so reloading mid-flow resumes it instead of losing it.
   */
  pendingEmailChange: PendingEmailChangeDto | null;
}

// ---------------------------------------------------------------------------
// Group guidelines
// ---------------------------------------------------------------------------
/**
 * What every member agrees to before using the groups pages.
 *
 * Bump the version whenever the text changes in substance: everyone who agreed
 * to an older version is asked again on their next visit.
 */
export const GROUP_GUIDELINES_VERSION = 1;

export const GROUP_GUIDELINES: readonly { title: string; body: string }[] = [
  {
    title: "Parish-focused use",
    body: "Use the groups page for parish life: events, ministry coordination, volunteer needs, announcements, words of encouragement, etc.",
  },
  {
    title: "Fundraising",
    body: "Fundraising for the church or charitable causes is welcome.",
  },
  {
    title: "Charitable speech",
    body: "No gossip or criticism of individuals or clergy. Bring concerns to the priest or parish council directly (Matthew 18:15).",
  },
  {
    title: "No political debate",
    body: "No partisan content, political debate, or divisive social commentary.",
  },
  {
    title: "No contentious topics",
    body: "Don't share unverified teachings or \u201cprophecies,\u201d and don't debate jurisdictions, the calendar, or other controversies within Orthodoxy.",
  },
  {
    title: "No pastoral matters",
    body: "Confession and pastoral matters are never discussed in the group.",
  },
  {
    title: "Refrain during services",
    body: "Don't use the groups page during services.",
  },
  {
    title: "Moderator authority",
    body: "The priest and moderators may remove posts or members who don't follow these guidelines. Report concerns to a moderator privately, not publicly, or use the Report option on a post (in its message menu) to flag it for review.",
  },
  {
    title: "Agreement",
    body: "Using the groups page means you agree to these guidelines.",
  },
];

export const groupGuidelinesAgreementSchema = z.object({
  version: z.literal(GROUP_GUIDELINES_VERSION),
});

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

/**
 * What a uuid found inside `changes` turned out to name, resolved at read time
 * for the same reason `AuditTargetDto.label` is: the names move, the ids do
 * not, and nothing was denormalized onto the row when it was written.
 */
export interface AuditReferenceDto {
  label: string;
  /** Which table it was found in. The page uses this to decide whether to link. */
  type: AuditEntityType;
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
   * The uuids found inside `changes`, keyed by the id as it appears there
   * (lowercased). Only the ones that resolved: an id naming nothing is absent
   * from the map, and the page shows it verbatim rather than guessing at it.
   *
   * Per entry rather than per page, even though resolution runs once per page
   * of entries: the SPA's infinite query flattens pages into one list before
   * any component sees it, so a page-level map would have nowhere to live.
   */
  references: Record<string, AuditReferenceDto>;
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
    renditions: z.object({
      thumb: renditionSizeSchema,
      full: renditionSizeSchema,
      // The families/groups-page card. Family or group only -- a person
      // framing their own photo has nothing shaped like a directory card to
      // presign.
      card: renditionSizeSchema.optional(),
    }),
    personId: uuidSchema.optional(),
    familyId: uuidSchema.optional(),
    /** A group's own cover photo -- free-form crop, thumb/full, and a card. */
    groupId: uuidSchema.optional(),
  })
  .refine((v) => [v.personId, v.familyId, v.groupId].filter(Boolean).length === 1, {
    message: "Provide exactly one of personId, familyId or groupId",
  })
  .refine((v) => !v.renditions.card || Boolean(v.familyId) || Boolean(v.groupId), {
    message: "Only a family or group photo can have a card rendition",
    path: ["renditions", "card"],
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

/**
 * Non-image attachments a group post may carry. Deliberately not decoded to a
 * canvas -- see useAttachmentPicker in the SPA and the `group-post` passthrough
 * in api/src/photos.ts, which stores one object rather than two renditions.
 * PDF, the three common Office formats, plain text and CSV: the set
 * requirements/groups.md names ("pictures and documents"), with video deferred
 * to a later phase.
 */
export const GROUP_DOCUMENT_CONTENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
] as const;
export type GroupDocumentContentType = (typeof GROUP_DOCUMENT_CONTENT_TYPES)[number];

/**
 * Presigning one group-post attachment. A discriminated union on `kind` rather
 * than one shape with optional fields, because the two are presigned
 * completely differently: an image gets two renditions the way a
 * prayer-request image does, a file gets exactly one presigned PUT for the
 * object as the browser has it.
 *
 * No owner field, same reasoning as `prayerRequestImageUploadSchema`: scoped to
 * the caller's own person record, so the upload can happen before the post it
 * will be attached to exists.
 */
export const groupAttachmentUploadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("IMAGE"),
    contentType: z.enum(PHOTO_UPLOAD_TYPES),
    filename: z.string().trim().min(1).max(255),
    renditions: z.object({ thumb: renditionSizeSchema, full: renditionSizeSchema }),
  }),
  z.object({
    kind: z.literal("FILE"),
    contentType: z.enum(GROUP_DOCUMENT_CONTENT_TYPES),
    filename: z.string().trim().min(1).max(255),
    contentLength: z.number().int().positive().max(MAX_PHOTO_BYTES),
  }),
]);
export type GroupAttachmentUpload = z.infer<typeof groupAttachmentUploadSchema>;

export interface GroupAttachmentUploadDto {
  photoKey: string;
  kind: GroupAttachmentKind;
  /** One URL for a FILE, `{thumb, full}` for an IMAGE. */
  uploadUrls: { file: string } | Record<PhotoRendition, string>;
}

export interface PhotoUploadDto {
  /**
   * The prefix both renditions live under, ending in "/". This is what gets
   * stored in `photo_key` and handed back to the attach endpoint.
   */
  photoKey: string;
  uploadUrls: Record<PhotoRendition, string> & { card?: string };
}

/**
 * Attaching an already-uploaded photo, or clearing one with a null key.
 *
 * Dimensions are only meaningful for a family or group, whose crop is
 * free-form; the person endpoint ignores them. `hasCard` is family/group only
 * too, and only meaningful alongside a key -- clearing a photo always clears
 * it.
 */
export const photoAttachSchema = z
  .object({
    photoKey: z.string().min(1).max(500).nullable(),
    photoWidth: z.number().int().positive().max(20000).nullable().optional(),
    photoHeight: z.number().int().positive().max(20000).nullable().optional(),
    hasCard: z.boolean().optional(),
  })
  .refine((v) => v.photoKey === null || v.photoKey.endsWith("/"), {
    message: "A photo key must be the rendition prefix, ending in /",
    path: ["photoKey"],
  })
  .refine((v) => Boolean(v.photoWidth) === Boolean(v.photoHeight), {
    message: "Provide both photoWidth and photoHeight, or neither",
    path: ["photoWidth"],
  })
  .refine((v) => v.photoKey !== null || !v.hasCard, {
    message: "A photo with no key cannot have a card rendition",
    path: ["hasCard"],
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

/**
 * The one definition of "a search term", read by the route that searches and by
 * the UI that shows what matched.
 *
 * `/directory/search` ANDs one `ilike '%term%'` per term against the resolved
 * view's concatenated `search_text`, and the directory highlights those same
 * terms on each card. Two copies of this rule would drift, and the failure is
 * silent and specific: a card would mark a fragment the server never filtered
 * on, or go unable to explain why it is in the results at all.
 *
 * The cap is on the raw split, not on what survives filtering -- terms past the
 * eighth were never part of the predicate, so nothing may be highlighted for
 * them. Case is left alone: the server needs the term verbatim to escape it for
 * LIKE, and ILIKE is case-insensitive anyway.
 */
export function searchTerms(q: string): string[] {
  return q.trim().split(/\s+/).filter(Boolean).slice(0, 8);
}
