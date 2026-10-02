import type { Queryable } from "../db";
import type { AuditEntityType, AuditReferenceDto } from "../types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_DEPTH = 8;
const MAX_IDS = 500;

/**
 * Every whole-string uuid in a `changes` payload, including inside arrays.
 *
 * Anchored, not searched: a photo key is
 * `photos/{orgId}/person/{personId}/{uuid}.jpg`, and an unanchored match would
 * pull three ids out of a string that names none of them. Field names are
 * never inspected -- a payload's keys are never themselves ids.
 *
 * Bounded so a pathological payload cannot cost the page: past eight levels or
 * five hundred ids, collection stops and the remainder renders as a raw uuid
 * on the page -- an honest degradation, and unreachable in practice (the
 * largest real payload today is one family's `personIds`).
 */
export function collectUuids(changes: unknown): string[] {
  const found = new Set<string>();

  function walk(value: unknown, depth: number): void {
    if (found.size >= MAX_IDS || depth > MAX_DEPTH) return;
    if (typeof value === "string") {
      if (UUID_PATTERN.test(value)) found.add(value.toLowerCase());
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (found.size >= MAX_IDS) return;
        walk(item, depth + 1);
      }
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) {
        if (found.size >= MAX_IDS) return;
        walk(item, depth + 1);
      }
    }
  }

  walk(changes, 0);
  return [...found];
}

interface ReferenceRow {
  id: string;
  type: AuditEntityType;
  label: string | null;
}

/**
 * A fixed rank, so resolution is deterministic rather than dependent on row
 * order in the one case two tables both claim the same id. Real uuids make
 * that vanishingly unlikely, but "first wins" has to mean something specific.
 */
const TYPE_RANK: Record<AuditEntityType, number> = {
  person: 0,
  family: 1,
  appUser: 2,
  organization: 3,
  prayerRequest: 4,
  specialDate: 5,
};

/**
 * What the uuids inside a page's `changes` payloads turned out to name,
 * resolved now rather than stored then -- the same reasoning `TARGET_LABEL` in
 * routes/audit.ts already applies to the entity each row acted on.
 *
 * One statement over the whole page's id set, not one per entry: the cost is
 * bounded per page, not per row. Four tables and no more, because nothing
 * recorded today carries a prayer request or special date id; the day
 * something does, it is one more `union all` branch.
 *
 * Deliberately not scoped to an organization, for the reason `TARGET_LABEL`
 * is not either: the person a payload names may since have moved to another
 * parish, or been soft-deleted, and that is exactly when naming them matters.
 * The caller is always an admin reading a row that already carried this id.
 *
 * Soft-deleted people are included, via `persons_resolved`, matching
 * `TARGET_LABEL`. An id that matches nothing, or whose label is empty, is
 * omitted rather than returned with a null label -- the page then shows the
 * raw id rather than this guessing at one.
 */
export async function resolveAuditReferences(
  db: Queryable,
  ids: string[]
): Promise<Map<string, AuditReferenceDto>> {
  const map = new Map<string, AuditReferenceDto>();
  if (ids.length === 0) return map;

  const { rows } = await db.query<ReferenceRow>(
    `select p.id::text as id, 'person'::text as type,
            nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') as label
       from persons_resolved p where p.id = any($1::uuid[])
     union all
     select f.id::text, 'family', f.name
       from families f where f.id = any($1::uuid[])
     union all
     select u.id::text, 'appUser', u.email::text
       from app_users u where u.id = any($1::uuid[])
     union all
     select o.id::text, 'organization', o.name
       from organizations o where o.id = any($1::uuid[])`,
    [ids]
  );

  for (const row of rows) {
    if (!row.label) continue;
    const existing = map.get(row.id);
    if (existing && TYPE_RANK[existing.type] <= TYPE_RANK[row.type]) continue;
    map.set(row.id, { label: row.label, type: row.type });
  }

  return map;
}
