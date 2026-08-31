import { Hono } from "hono";
import { requireOrganizationId, type AppEnv } from "../auth";
import { PERSON_COLUMNS, PERSON_ORDER, toSummaries, type PersonRow } from "../services/persons";
import { fullName, uuidSchema, type PersonLookupDto } from "../types";

/**
 * Browsing and searching the directory.
 *
 * Both are organization-scoped, which is also what keeps search cheap: the
 * `persons_browse_idx` index narrows to one parish first, and the ILIKE then
 * runs over a few hundred rows. That is why "search anything in any data
 * field" can be a single ILIKE against the resolved view's `search_text`
 * rather than a maintained tsvector or trigram index -- there is no scale here
 * that would justify the write-side machinery.
 */
const routes = new Hono<AppEnv>();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** A dropdown nobody scrolls, so the picker's ceiling is far lower than browse's. */
const DEFAULT_LOOKUP_LIMIT = 20;
const MAX_LOOKUP_LIMIT = 50;

function parseLookupLimit(raw: string | undefined): number {
  const value = Number(raw ?? DEFAULT_LOOKUP_LIMIT);
  if (!Number.isFinite(value)) return DEFAULT_LOOKUP_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LOOKUP_LIMIT);
}

function parseLimit(raw: string | undefined): number {
  const value = Number(raw ?? DEFAULT_LIMIT);
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT);
}

/**
 * "Scrollable view of the entire directory, sorted by last name."
 *
 * Keyset pagination on (last_name, first_name, id) rather than OFFSET, so
 * scrolling cannot skip or repeat someone when a record is edited mid-scroll.
 * The cursor is the last row of the previous page.
 */
routes.get("/", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const limit = parseLimit(c.req.query("limit"));

  const cursorLastName = c.req.query("cursorLastName") ?? null;
  const cursorFirstName = c.req.query("cursorFirstName") ?? null;
  const cursorId = c.req.query("cursorId") ?? null;

  // `nulls last` in the ordering means the keyset comparison has to treat a
  // missing last name as larger than any present one, which is what the
  // coalesce to U+FFFF does.
  const keyset = cursorId
    ? `and (coalesce(r.last_name, chr(65535)), r.first_name, r.id)
         > (coalesce($2, chr(65535)), $3, $4::uuid)`
    : "";

  const params: unknown[] = [organizationId];
  if (cursorId) params.push(cursorLastName, cursorFirstName ?? "", cursorId);
  params.push(limit + 1);

  const { rows } = await db.query<PersonRow>(
    `select ${PERSON_COLUMNS}
       from persons_resolved r
      where r.organization_id = $1
        and r.deleted_at is null
        ${keyset}
      ${PERSON_ORDER}
      limit $${params.length}`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return c.json({
    people: toSummaries(caller, page),
    nextCursor:
      hasMore && last
        ? { lastName: last.last_name, firstName: last.first_name, id: last.id }
        : null,
  });
});

/** "Search for users where the search contents match anything in any data field." */
routes.get("/search", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const q = (c.req.query("q") ?? "").trim();

  if (q.length === 0) return c.json({ people: [], query: "" });

  // Every whitespace-separated term must match somewhere, so "smith chicago"
  // narrows rather than widens. `%` and `_` are escaped so a typed wildcard is
  // treated as a literal.
  const terms = q.split(/\s+/).slice(0, 8);
  const conditions = terms.map((_, i) => `r.search_text ilike $${i + 2}`).join(" and ");
  const params = [organizationId, ...terms.map((term) => `%${escapeLike(term)}%`)];

  const { rows } = await db.query<PersonRow>(
    `select ${PERSON_COLUMNS}
       from persons_resolved r
      where r.organization_id = $1
        and r.deleted_at is null
        and ${conditions}
      ${PERSON_ORDER}
      limit ${MAX_LIMIT}`,
    params
  );

  return c.json({ people: toSummaries(caller, rows), query: q });
});

/**
 * The type-ahead picker behind "Married to", and anywhere else one person has
 * to be chosen out of the parish.
 *
 * Separate from `/search` on purpose. That one matches "anything in any data
 * field", which is right for the directory's search box and wrong here: typing "Newport"
 * into a spouse picker should not offer everyone who lives on that street. So
 * this matches names only, returns a slim row rather than the whole resolved
 * record, and caps hard -- a dropdown nobody scrolls past 20 rows of.
 *
 * It reads `persons_resolved` rather than `persons` because `last_name` is
 * inheritable: a child who takes the family surname has a null of their own
 * and would otherwise be unfindable by it.
 */
routes.get("/lookup", async (c) => {
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const q = (c.req.query("q") ?? "").trim();
  const limit = parseLookupLimit(c.req.query("limit"));

  const excludeRaw = c.req.query("exclude");
  const exclude = excludeRaw ? uuidSchema.safeParse(excludeRaw) : null;

  const params: unknown[] = [organizationId];
  const conditions: string[] = [];

  if (exclude?.success) {
    params.push(exclude.data);
    conditions.push(`r.id <> $${params.length}::uuid`);
  }

  // Every term must match, so "mar sch" narrows the way it does on the search
  // page. An empty q falls through with no name condition, which leaves the
  // first page showing -- the one thing a plain <select> did well was let you
  // browse before you knew what you were looking for.
  for (const term of q.split(/\s+/).filter(Boolean).slice(0, 8)) {
    params.push(`%${escapeLike(term)}%`);
    conditions.push(
      `(coalesce(r.first_name, '') || ' ' || coalesce(r.last_name, '')) ilike $${params.length}`
    );
  }

  params.push(limit);

  const { rows } = await db.query<{
    id: string;
    first_name: string;
    last_name: string | null;
    family_name: string | null;
  }>(
    `select r.id, r.first_name, r.last_name, r.family_name
       from persons_resolved r
      where r.organization_id = $1
        and r.deleted_at is null
        ${conditions.map((condition) => `and ${condition}`).join("\n        ")}
      ${PERSON_ORDER}
      limit $${params.length}`,
    params
  );

  const people: PersonLookupDto[] = rows.map((row) => ({
    id: row.id,
    name: fullName({ firstName: row.first_name, lastName: row.last_name }),
    familyName: row.family_name,
  }));
  return c.json({ people });
});

export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export default routes;
