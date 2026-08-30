import { HTTPException } from "hono/http-exception";
import { one, type Queryable } from "../db";
import { INHERITABLE_ATTRIBUTES, type InheritableAttribute, type Inheritance } from "../types";

/**
 * The rules around "a Person that is a member of a family can choose to
 * inherit the following attributes from another family member".
 *
 * The database has the pointers and the cheap constraints (not self, family
 * required); the invariants that need to look at another row live here, where
 * we can return a message the UI can show:
 *
 *   - the source must be a living, non-deleted person in the same family and
 *     organization;
 *   - the source must not itself inherit that same attribute. Allowing a chain
 *     would let a cycle form (A inherits from B inherits from A) and the
 *     resolution view, which does a single join, would silently return null.
 *     One hop is also all anyone actually wants: children inherit from a
 *     parent, not from a sibling who inherits from a parent.
 */

export const INHERIT_COLUMN: Record<InheritableAttribute, string> = {
  email: "inherit_email_from_person_id",
  phone: "inherit_phone_from_person_id",
  altPhone: "inherit_alt_phone_from_person_id",
  lastName: "inherit_last_name_from_person_id",
  address: "inherit_address_from_person_id",
};

export const INHERIT_FIELD: Record<InheritableAttribute, keyof Inheritance> = {
  email: "inheritEmailFromPersonId",
  phone: "inheritPhoneFromPersonId",
  altPhone: "inheritAltPhoneFromPersonId",
  lastName: "inheritLastNameFromPersonId",
  address: "inheritAddressFromPersonId",
};

const ATTRIBUTE_LABEL: Record<InheritableAttribute, string> = {
  email: "email",
  phone: "phone number",
  altPhone: "alternate phone number",
  lastName: "last name",
  address: "address",
};

interface SourceRow {
  id: string;
  organization_id: string;
  family_id: string | null;
  first_name: string;
  last_name: string | null;
  inherits_same_attribute: string | null;
}

export interface InheritanceTarget {
  /** Null when validating a person who does not exist yet. */
  personId: string | null;
  organizationId: string;
  familyId: string | null;
}

/**
 * Throws a 400 with a readable message if any requested inheritance is
 * invalid. Only attributes present in `requested` are checked, so a PATCH that
 * does not mention inheritance is left alone.
 */
export async function validateInheritance(
  q: Queryable,
  target: InheritanceTarget,
  requested: Inheritance
): Promise<void> {
  for (const attribute of INHERITABLE_ATTRIBUTES) {
    const field = INHERIT_FIELD[attribute];
    if (!(field in requested)) continue;

    const sourceId = requested[field];
    if (sourceId == null) continue;

    const label = ATTRIBUTE_LABEL[attribute];

    if (!target.familyId) {
      throw new HTTPException(400, {
        message: `Join a family before inheriting a ${label}`,
      });
    }
    if (sourceId === target.personId) {
      throw new HTTPException(400, {
        message: `Cannot inherit a ${label} from yourself`,
      });
    }

    const source = await one<SourceRow>(
      q,
      `select id,
              organization_id,
              family_id,
              first_name,
              last_name,
              ${INHERIT_COLUMN[attribute]} as inherits_same_attribute
         from persons
        where id = $1
          and deleted_at is null`,
      [sourceId]
    );

    if (!source || source.organization_id !== target.organizationId) {
      throw new HTTPException(404, { message: "That family member was not found" });
    }
    if (source.family_id !== target.familyId) {
      throw new HTTPException(400, {
        message: `A ${label} can only be inherited from someone in the same family`,
      });
    }
    if (source.inherits_same_attribute) {
      const name = [source.first_name, source.last_name].filter(Boolean).join(" ");
      throw new HTTPException(400, {
        message: `${name} already inherits their ${label} from someone else — inherit from that person instead`,
      });
    }
  }
}

/**
 * Clears any inheritance pointing at `personId`, and any inheritance
 * `personId` themselves had. Called when someone leaves a family or is
 * deleted: without this, the resolution view would keep serving a value from
 * someone who is no longer a relative.
 */
export async function clearInheritanceFor(q: Queryable, personId: string): Promise<void> {
  const columns = Object.values(INHERIT_COLUMN);
  await q.query(
    `update persons
        set ${columns.map((c) => `${c} = null`).join(", ")}
      where id = $1`,
    [personId]
  );
  await q.query(
    `update persons
        set ${columns.map((c) => `${c} = case when ${c} = $1 then null else ${c} end`).join(", ")}
      where ${columns.map((c) => `${c} = $1`).join(" or ")}`,
    [personId]
  );
}
