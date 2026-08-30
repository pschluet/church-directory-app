import { HTTPException } from "hono/http-exception";
import type { Caller } from "../auth";

/**
 * Who may change what.
 *
 * From the requirements:
 *   - Users manage their own directory data and see everyone else's.
 *   - "anyone in the family with a user account can manage the information for
 *     these non-user family members" -- note *non-user*: another adult with
 *     their own account manages themselves, even if you share a family.
 *   - Admins may edit information for other Users or Persons in their
 *     organization.
 *   - Super Admins may do all of that in any organization.
 *
 * Read access is organization-wide, which is enforced by every query filtering
 * on organization_id rather than by a check here.
 */

export interface PersonAccessFacts {
  id: string;
  organizationId: string;
  familyId: string | null;
  appUserId: string | null;
}

export function canEditPerson(caller: Caller, person: PersonAccessFacts): boolean {
  if (person.organizationId !== caller.organizationId) return false;
  if (caller.isAdmin) return true;

  // Your own record.
  if (caller.personId && person.id === caller.personId) return true;

  // A family member who has no account of their own.
  if (
    person.appUserId === null &&
    person.familyId !== null &&
    caller.familyId !== null &&
    person.familyId === caller.familyId
  ) {
    return true;
  }

  return false;
}

export function assertCanEditPerson(caller: Caller, person: PersonAccessFacts): void {
  if (!canEditPerson(caller, person)) {
    throw new HTTPException(403, {
      message: "You can only edit your own details and those of family members without an account",
    });
  }
}

/**
 * Family details (name, photo) and its membership are editable by any member
 * with an account, and by admins.
 */
export function canEditFamily(
  caller: Caller,
  family: { organizationId: string; id: string }
): boolean {
  if (family.organizationId !== caller.organizationId) return false;
  if (caller.isAdmin) return true;
  return caller.familyId === family.id;
}

export function assertCanEditFamily(
  caller: Caller,
  family: { organizationId: string; id: string }
): void {
  if (!canEditFamily(caller, family)) {
    throw new HTTPException(403, { message: "Only members of this family can change it" });
  }
}

/**
 * Which roles a caller may hand out. An admin may create admins and users
 * inside their own organization; only a super admin may mint another super
 * admin, or place someone in a different organization.
 */
export function assertCanGrantRole(
  caller: Caller,
  role: "SUPER_ADMIN" | "ADMIN" | "USER",
  organizationId: string | null
): void {
  if (role === "SUPER_ADMIN") {
    if (!caller.isSuperAdmin) {
      throw new HTTPException(403, { message: "Only a super admin can create a super admin" });
    }
    return;
  }
  if (!caller.isAdmin) {
    throw new HTTPException(403, { message: "Only admins can invite people" });
  }
  if (!caller.isSuperAdmin && organizationId !== caller.homeOrganizationId) {
    throw new HTTPException(403, {
      message: "You can only invite people into your own organization",
    });
  }
}
