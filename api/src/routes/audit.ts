import { Hono } from "hono";
import { requireOrganizationId, requireRole, type AppEnv } from "../auth";
import { parseLimit } from "./paging";
import { escapeLike } from "./directory";
import {
  AUDIT_ACTIONS,
  fullName,
  uuidSchema,
  type AuditActorDto,
  type AuditActorLookupDto,
  type AuditLogEntryDto,
  type AuditLogFilterOptionsDto,
  type AuditLogPageDto,
} from "../types";

/**
 * Reading the audit log.
 *
 * The table has been written since the first migration and never read, which is
 * half a trail: `audit()` records who edited whose phone number, and until this
 * route existed there was no way to ask. Admins see their own parish, super
 * admins whichever they have selected.
 *
 * Every filter is applied here rather than in the browser. The page loads fifty
 * rows at a time out of a table nothing prunes, so filtering the loaded rows
 * would search the last fifty entries and quietly call that the answer.
 */
const routes = new Hono<AppEnv>();

/**
 * Admins and above. `requireRole` matches on a floor, so this admits ADMIN and
 * SUPER_ADMIN and refuses PRAYER_REQUEST_ADMIN, which is the line that matters:
 * an approver is a member with one extra privilege, and the log holds every
 * edit anyone in the parish has made.
 *
 * One `use` covers the bare mount path as well -- see the admin of
 * `GET /api/organizations` getting a 403 in api/test/api.authz.test.ts. The
 * two-line form in routes/admin.ts is only needed for a nested prefix like
 * `/users/*`, which genuinely misses `/users`.
 */
routes.use("/*", requireRole("ADMIN"));

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** A typeahead nobody scrolls, matching the ceilings on /directory/lookup. */
const DEFAULT_ACTOR_LIMIT = 20;
const MAX_ACTOR_LIMIT = 50;

/**
 * Whose parish an entry belongs to.
 *
 * A super admin also sees the rows with no organization at all. That is not a
 * loophole -- it is where `organization.create` lands, because creating a parish
 * necessarily happens before there is one to have selected, and only a super
 * admin can do it. Excluding them would leave a permanent hole in every view;
 * including them for everyone would show one parish another's activity. They do
 * show up under each parish a super admin looks at, which is why the entry
 * carries `unassignedOrganization` for the page to badge.
 */
function organizationScope(isSuperAdmin: boolean): string {
  return isSuperAdmin
    ? "(a.organization_id = $1 or a.organization_id is null)"
    : "a.organization_id = $1";
}

/**
 * The name to show for what was acted on, resolved now rather than stored then.
 *
 * A CASE of correlated primary-key lookups rather than six left joins: only one
 * of them can apply to any row, and `entity_id` is deliberately not a foreign
 * key -- the trail has to outlive what it describes -- so there is nothing for
 * a join to be planned against.
 *
 * None of these exclude soft-deleted rows. Naming somebody who has since been
 * deleted is the entire point of keeping the entry.
 */
const TARGET_LABEL = `
  case a.entity_type
    when 'person' then (
      select nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')
        from persons_resolved p
       where p.id = a.entity_id)
    when 'family' then (select f.name from families f where f.id = a.entity_id)
    when 'appUser' then (select u.email::text from app_users u where u.id = a.entity_id)
    when 'organization' then (select o.name from organizations o where o.id = a.entity_id)
    when 'prayerRequest' then (select r.title from prayer_requests r where r.id = a.entity_id)
    -- A special date has no name of its own, so it borrows whose it is, which is
    -- what somebody reading "Special date edited" actually wants to know.
    when 'specialDate' then (
      select nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')
        from special_dates s
        join persons_resolved p on p.id = s.person_id
       where s.id = a.entity_id)
    else null
  end`;

/**
 * The actor's name comes from their directory record, which is joined without
 * excluding soft-deleted rows -- `persons.app_user_id` is unique across all of
 * them, so this stays one-to-one, and an audit entry should still name somebody
 * whose record was since retired.
 */
const ACTOR_JOIN = `
  left join app_users au on au.id = a.actor_app_user_id
  left join persons ap on ap.app_user_id = au.id`;

interface EntryRow {
  id: string;
  created_at: Date;
  action: string;
  entity_type: string;
  entity_id: string | null;
  organization_id: string | null;
  changes: unknown;
  actor_app_user_id: string | null;
  actor_email: string | null;
  actor_first_name: string | null;
  actor_last_name: string | null;
  target_label: string | null;
}

interface ActorRow {
  actor_app_user_id: string | null;
  actor_email: string | null;
  actor_first_name: string | null;
  actor_last_name: string | null;
}

function toActor(row: ActorRow): AuditActorDto {
  const name = row.actor_first_name
    ? fullName({ firstName: row.actor_first_name, lastName: row.actor_last_name })
    : null;
  return {
    appUserId: row.actor_app_user_id,
    email: row.actor_email,
    name: name || null,
  };
}

function toEntry(row: EntryRow): AuditLogEntryDto {
  return {
    id: row.id,
    createdAt: row.created_at.toISOString(),
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actor: toActor(row),
    target: {
      label: row.target_label,
      missing: row.entity_id !== null && row.target_label === null,
    },
    changes: row.changes ?? null,
    unassignedOrganization: row.organization_id === null,
  };
}

/** Only the uuids Postgres will accept, so a typed-in filter cannot 500 the page. */
function parseUuids(raw: string[]): string[] {
  return raw.flatMap((value) => {
    const parsed = uuidSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * An instant, or null when it is not one.
 *
 * Null means the bound is simply not applied, which follows `parseLimit` and
 * `parseFlag`: a malformed query parameter shows a page rather than an error.
 * The client sends `toISOString()` output, and it sends instants rather than
 * calendar dates on purpose -- `created_at` is a moment, "yesterday" depends on
 * the reader's timezone, and only the browser knows what that is.
 */
function parseInstant(raw: string | undefined): string | null {
  if (!raw) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

/** The log itself, newest first. */
routes.get("/", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const limit = parseLimit(c.req.query("limit"), DEFAULT_LIMIT, MAX_LIMIT);

  const params: unknown[] = [organizationId];
  const conditions: string[] = [];

  /*
   * Placeholders are collected as they are pushed rather than numbered by hand,
   * the way /directory/lookup does it. Four independently optional filters and a
   * cursor make hand-numbering a set of $n that only line up for one
   * combination of them.
   */
  const actions = c.req.queries("action") ?? [];
  if (actions.length > 0) {
    params.push(actions);
    conditions.push(`a.action = any($${params.length}::text[])`);
  }

  const entityTypes = c.req.queries("entityType") ?? [];
  if (entityTypes.length > 0) {
    params.push(entityTypes);
    conditions.push(`a.entity_type = any($${params.length}::text[])`);
  }

  /*
   * An actor filter of nothing-but-nonsense matches nobody rather than
   * everybody. Dropping the condition would widen the page instead of narrowing
   * it, which is the one direction a filter must never fail in.
   */
  const rawActorIds = c.req.queries("actorId") ?? [];
  const actorIds = parseUuids(rawActorIds);
  if (actorIds.length > 0) {
    params.push(actorIds);
    conditions.push(`a.actor_app_user_id = any($${params.length}::uuid[])`);
  } else if (rawActorIds.length > 0) {
    conditions.push("false");
  }

  const from = parseInstant(c.req.query("from"));
  if (from) {
    params.push(from);
    conditions.push(`a.created_at >= $${params.length}::timestamptz`);
  }

  // Half-open, so the client can pass midnight after the last day it wants and
  // have that day be included whole.
  const to = parseInstant(c.req.query("to"));
  if (to) {
    params.push(to);
    conditions.push(`a.created_at < $${params.length}::timestamptz`);
  }

  /*
   * Keyset pagination on (created_at desc, id desc).
   *
   * The tie-break is required, not belt-and-braces. `created_at` is not unique
   * -- both merge paths write two entries inside one transaction, at the same
   * instant -- and it has to be the row-wise comparison: `created_at <= $x and
   * id < $y` would drop every earlier row that happens to share a timestamp
   * with the cursor. `id` is a bigserial, so the pair is a total order.
   */
  const cursorCreatedAt = parseInstant(c.req.query("cursorCreatedAt"));
  const cursorId = c.req.query("cursorId");
  if (cursorCreatedAt && cursorId && /^\d+$/.test(cursorId)) {
    params.push(cursorCreatedAt, cursorId);
    conditions.push(
      `(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`
    );
  }

  // One row more than asked for, which is how the next cursor is decided
  // without a second count query.
  params.push(limit + 1);

  const { rows } = await db.query<EntryRow>(
    `select a.id::text as id,
            a.created_at,
            a.action,
            a.entity_type,
            a.entity_id,
            a.organization_id,
            a.changes,
            a.actor_app_user_id,
            au.email::text as actor_email,
            ap.first_name as actor_first_name,
            ap.last_name as actor_last_name,
            ${TARGET_LABEL} as target_label
       from audit_log a
       ${ACTOR_JOIN}
      where ${organizationScope(caller.isSuperAdmin)}
        ${conditions.map((condition) => `and ${condition}`).join("\n        ")}
      order by a.created_at desc, a.id desc
      limit $${params.length}`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  const body: AuditLogPageDto = {
    entries: page.map(toEntry),
    nextCursor: hasMore && last ? { createdAt: last.created_at.toISOString(), id: last.id } : null,
  };
  return c.json(body);
});

/**
 * What the action and entity type filters may offer, taken from the rows
 * themselves.
 *
 * Two cheap distincts over one parish, in one round trip. Derived rather than
 * listed so the page can never hide an entry -- an action added at a call site
 * and not to `AUDIT_ACTIONS` appears here the first time it is written -- and
 * so that no option is ever offered that comes back empty, which also means no
 * option is offered for something no part of the app can do.
 */
routes.get("/filters", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const scope = organizationScope(caller.isSuperAdmin);

  const [actions, entityTypes] = await Promise.all([
    db.query<{ action: string }>(
      `select distinct a.action from audit_log a where ${scope} order by a.action`,
      [organizationId]
    ),
    db.query<{ entity_type: string }>(
      `select distinct a.entity_type from audit_log a where ${scope} order by a.entity_type`,
      [organizationId]
    ),
  ]);

  const body: AuditLogFilterOptionsDto = {
    // Ordered by the lifecycle grouping in AUDIT_ACTIONS rather than
    // alphabetically, so the list reads "create, update, delete" per group.
    // Anything the constant has not caught up with sorts to the end instead of
    // being dropped.
    actions: actions.rows
      .map((row) => row.action)
      .sort((left, right) => actionRank(left) - actionRank(right) || left.localeCompare(right)),
    entityTypes: entityTypes.rows.map((row) => row.entity_type),
  };
  return c.json(body);
});

/**
 * The people who have done something here, a few at a time.
 *
 * Backs a typeahead rather than a list of checkboxes: there is one actor per
 * account that has ever acted, so at parish scale the list is fine and at ten
 * thousand members it is a form control nobody can use. Searching on the server
 * is what removes the ceiling, exactly as `/directory/lookup` does for the
 * pickers elsewhere in the app.
 *
 * Restricted to actors that appear in *this* log, which is the point and the
 * reason `/admin/users` cannot serve it. That endpoint is scoped to the
 * caller's home organization -- so a super admin who acted in this parish is
 * missing from it -- and for a super admin caller it returns every account in
 * every parish, most of whom have never touched this one.
 *
 * `actorId` resolves specific ids instead of searching, for the chips that have
 * to name whoever a shared or reloaded URL already selected. Same question,
 * same scoping rules, so the same handler rather than a near-copy of it.
 */
routes.get("/actors", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const scope = organizationScope(caller.isSuperAdmin);

  const requestedIds = parseUuids(c.req.queries("actorId") ?? []);
  const resolving = requestedIds.length > 0;

  const params: unknown[] = [organizationId];
  const conditions: string[] = [];

  if (resolving) {
    params.push(requestedIds);
    conditions.push(`a.actor_app_user_id = any($${params.length}::uuid[])`);
  } else {
    /*
     * Every term must match, so "paul sch" narrows the way it does in the
     * directory's pickers. An empty term falls through with no condition, which
     * leaves the first page showing -- the one thing a plain list did well was
     * let you look before you knew what you were looking for.
     */
    const term = (c.req.query("q") ?? "").trim();
    for (const word of term.split(/\s+/).filter(Boolean).slice(0, 8)) {
      params.push(`%${escapeLike(word)}%`);
      conditions.push(
        `(coalesce(ap.first_name, '') || ' ' || coalesce(ap.last_name, '') || ' ' || au.email::text)
           ilike $${params.length}`
      );
    }
  }

  const limit = resolving
    ? requestedIds.length
    : parseLimit(c.req.query("limit"), DEFAULT_ACTOR_LIMIT, MAX_ACTOR_LIMIT);

  const { rows } = await db.query<ActorRow>(
    `select distinct
            a.actor_app_user_id,
            au.email::text as actor_email,
            ap.first_name as actor_first_name,
            ap.last_name as actor_last_name
       from audit_log a
       ${ACTOR_JOIN}
      where ${scope}
        and a.actor_app_user_id is not null
        ${conditions.map((condition) => `and ${condition}`).join("\n        ")}
      -- Cast in the ORDER BY too: with SELECT DISTINCT, Postgres matches the
      -- ordering against the select list expression-for-expression, and a bare
      -- citext au.email is not the au.email::text up there.
      order by ap.first_name nulls last, ap.last_name nulls last, au.email::text
      limit ${limit}`,
    params
  );

  const body: AuditActorLookupDto = { actors: rows.map(toActor) };
  return c.json(body);
});

function actionRank(action: string): number {
  const index = (AUDIT_ACTIONS as readonly string[]).indexOf(action);
  return index === -1 ? AUDIT_ACTIONS.length : index;
}

export default routes;
