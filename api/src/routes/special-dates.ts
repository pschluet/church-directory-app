import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireOrganizationId, type AppEnv } from "../auth";
import { one } from "../db";
import { audit } from "../audit";
import { assertCanEditPerson } from "../services/access";
import { SPECIAL_DATE_SELECT, toSpecialDate, type SpecialDateRow } from "../services/persons";
import {
  allMonthDayKeys,
  compareByTypeThenName,
  DEFAULT_WINDOW_DAYS,
  expandMonth,
  expandWindow,
  monthDayKey,
  parseIsoDate,
  resolveRelativeRows,
  toIsoDate,
  yearCountFor,
} from "../services/upcoming-dates";
import {
  formatSpecialDateRule,
  specialDateWriteSchema,
  uuidSchema,
  type MoveableFeast,
  type RuleDirection,
  type RuleUnit,
  type SpecialDateOccurrenceDto,
  type UpcomingDatesDto,
} from "../types";

/**
 * Special dates, and the "what's coming up" views.
 *
 * A wedding anniversary is one row linking two people, so it surfaces once
 * with both names rather than twice.
 */
const routes = new Hono<AppEnv>();

interface OccurrenceRow extends SpecialDateRow {
  /** Null for a relative row -- it has no fixed (month, day) to key on. */
  month_day_key: number | null;
}

async function loadOccurrences(
  db: AppEnv["Variables"]["db"],
  organizationId: string,
  keys: number[],
  /** Narrow to one family, for the family page's year ahead. */
  familyId: string | null = null
): Promise<OccurrenceRow[]> {
  if (keys.length === 0) return [];
  const { rows } = await db.query<OccurrenceRow>(
    `${SPECIAL_DATE_SELECT}
      where sd.organization_id = $1
        and p.deleted_at is null
        -- Deleted on the related side counts as deleted too, or a couple
        -- keeps appearing here with one spouse's name rendered as a link
        -- that 404s. Null-safe: only an anniversary has a second person.
        and (sd.related_person_id is null or rp.deleted_at is null)
        and (
          -- Fixed: the stored month and day fall inside the window.
          (sd.month is not null and (sd.month * 100 + sd.day) = any($2::int[]))
          -- Relative: every rule in the organization, resolved in JS below.
          -- At most one name day per person (special_dates_one_feast_day_idx),
          -- so this is bounded by the parish and cheap to resolve in bulk.
          or sd.rule_reference is not null
        )
        -- The related person as well as the owner: an anniversary is stored
        -- once against one spouse, so a couple where only the related half is
        -- in this family is still that family's anniversary, and has to
        -- surface on its list.
        and ($3::uuid is null or p.family_id = $3 or rp.family_id = $3)`,
    [organizationId, keys, familyId]
  );
  return rows.map((row) => ({
    ...row,
    month_day_key: row.month != null && row.day != null ? monthDayKey(row.month, row.day) : null,
  }));
}

/**
 * Maps rows onto the calendar days of a window. A fixed row can land on more
 * than one day only when the window is long enough to wrap a year, which the
 * 366-day cap makes the outer limit. A relative row can land on zero, one, or
 * two days in a window of that length -- see resolveRelativeRows.
 */
function groupByDay(
  caller: AppEnv["Variables"]["caller"],
  window: ReturnType<typeof expandWindow>,
  rows: OccurrenceRow[]
): UpcomingDatesDto["days"] {
  const byKey = new Map<number, OccurrenceRow[]>();
  for (const row of rows) {
    if (row.month_day_key == null) continue;
    const list = byKey.get(row.month_day_key);
    if (list) list.push(row);
    else byKey.set(row.month_day_key, [row]);
  }
  const byIso = resolveRelativeRows(
    window,
    rows
      .filter((row) => row.rule_reference != null)
      .map((row) => ({
        row,
        rule: {
          reference: row.rule_reference!,
          direction: row.rule_direction!,
          unit: row.rule_unit!,
          count: row.rule_count!,
          weekday: row.rule_weekday,
        },
      }))
  );

  return window.map((day) => {
    const occurrences: SpecialDateOccurrenceDto[] = [];
    for (const key of day.monthDayKeys) {
      for (const row of byKey.get(key) ?? []) {
        const base = toSpecialDate(caller, row);
        occurrences.push({
          ...base,
          date: day.iso,
          yearCount: yearCountFor(day.year, row.year, row.show_year_count),
        });
      }
    }
    for (const { row } of byIso.get(day.iso) ?? []) {
      // A relative date is always a FEAST_DAY (special_dates_rule_only_feast_day),
      // which never has a year or show_year_count, so yearCount is always null --
      // call the real function rather than hardcoding that, so the two paths
      // can never silently disagree.
      occurrences.push({
        ...toSpecialDate(caller, row),
        date: day.iso,
        yearCount: yearCountFor(day.year, row.year, row.show_year_count),
      });
    }
    // "Dates are grouped by date then special date type."
    occurrences.sort(compareByTypeThenName);
    return { date: day.iso, dates: occurrences };
  });
}

/**
 * "Shows list of upcoming dates within the next 7 days (today and the next 6
 * days); can optionally change the default range to whatever you want."
 *
 * `start` comes from the browser as yyyy-mm-dd, so "today" is the user's today
 * and the server's timezone never enters into it.
 */
routes.get("/upcoming", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);

  const startParam = c.req.query("start");
  const start = startParam ?? toIsoDate(new Date());
  try {
    parseIsoDate(start);
  } catch {
    throw new HTTPException(400, { message: "start must be a yyyy-mm-dd date" });
  }
  const days = Number(c.req.query("days") ?? DEFAULT_WINDOW_DAYS);
  const familyIdParam = c.req.query("familyId");
  const familyId = familyIdParam ? uuidSchema.parse(familyIdParam) : null;

  const window = expandWindow(start, Number.isFinite(days) ? days : DEFAULT_WINDOW_DAYS);
  const rows = await loadOccurrences(db, organizationId, allMonthDayKeys(window), familyId);

  const body: UpcomingDatesDto = {
    start: window[0]?.iso ?? start,
    end: window[window.length - 1]?.iso ?? start,
    days: groupByDay(caller, window, rows),
  };
  return c.json(body);
});

/**
 * The month grid: which days in a month have anything on them, and what. The
 * SPA renders dots from the counts and the detail list from `dates`.
 */
routes.get("/calendar", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);

  const now = new Date();
  const year = Number(c.req.query("year") ?? now.getUTCFullYear());
  const month = Number(c.req.query("month") ?? now.getUTCMonth() + 1);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    throw new HTTPException(400, { message: "year is out of range" });
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new HTTPException(400, { message: "month must be 1-12" });
  }

  const window = expandMonth(year, month);
  const rows = await loadOccurrences(db, organizationId, allMonthDayKeys(window));

  return c.json({ year, month, days: groupByDay(caller, window, rows) });
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Organization-scoped, so another parish's ids 404 rather than 403. */
async function assertCanEditPersonById(
  db: AppEnv["Variables"]["db"],
  caller: AppEnv["Variables"]["caller"],
  personId: string,
  organizationId: string
): Promise<void> {
  const row = await one<{
    id: string;
    organization_id: string;
    family_id: string | null;
    app_user_id: string | null;
  }>(
    db,
    `select id, organization_id, family_id, app_user_id
       from persons where id = $1 and organization_id = $2 and deleted_at is null`,
    [personId, organizationId]
  );
  if (!row) throw new HTTPException(404, { message: "Person not found" });
  assertCanEditPerson(caller, {
    id: row.id,
    organizationId: row.organization_id,
    familyId: row.family_id,
    appUserId: row.app_user_id,
  });
}

/**
 * The other half of an anniversary has to be a live person in the same parish.
 *
 * Shared by POST and PATCH: the update used to write `related_person_id`
 * unchecked, which was a second way to produce the dangling link that deleting
 * a person used to leave behind -- an edit could point an anniversary at
 * someone soft-deleted, or at another parish's member entirely.
 */
async function assertRelatedPersonIsUsable(
  db: AppEnv["Variables"]["db"],
  relatedPersonId: string | null | undefined,
  personId: string,
  organizationId: string
): Promise<void> {
  if (!relatedPersonId) return;
  if (relatedPersonId === personId) {
    throw new HTTPException(400, { message: "An anniversary must link two different people" });
  }
  const related = await one<{ id: string }>(
    db,
    "select id from persons where id = $1 and organization_id = $2 and deleted_at is null",
    [relatedPersonId, organizationId]
  );
  if (!related) throw new HTTPException(404, { message: "The other person was not found" });
}

/**
 * `payload.rule`, if any, as the pretty string the audit log should carry.
 *
 * Never put the raw rule object on an audit `changes` payload: AuditChanges's
 * `asRenderableFields` requires every value to be a scalar or an array of
 * scalars, so one nested object makes it give up on the *entire* entry and
 * fall back to a raw JSON dump -- not just this field.
 */
function auditChangesFor(
  personId: string,
  payload: ReturnType<typeof specialDateWriteSchema.parse>
): Record<string, unknown> {
  return { personId, ...payload, rule: payload.rule ? formatSpecialDateRule(payload.rule) : null };
}

routes.post("/", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const raw = (await c.req.json()) as Record<string, unknown>;
  const personId = uuidSchema.parse(raw.personId);
  const payload = specialDateWriteSchema.parse(raw);

  await assertCanEditPersonById(db, caller, personId, organizationId);

  await assertRelatedPersonIsUsable(db, payload.relatedPersonId, personId, organizationId);

  const created = await one<{ id: string }>(
    db,
    `insert into special_dates
       (organization_id, person_id, related_person_id, type, month, day, year,
        show_year_count, rule_reference, rule_direction, rule_unit, rule_count, rule_weekday)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning id`,
    [
      organizationId,
      personId,
      payload.relatedPersonId ?? null,
      payload.type,
      payload.month ?? null,
      payload.day ?? null,
      payload.year ?? null,
      payload.showYearCount,
      payload.rule?.reference ?? null,
      payload.rule?.direction ?? null,
      payload.rule?.unit ?? null,
      payload.rule?.count ?? null,
      payload.rule?.weekday ?? null,
    ]
  );
  if (!created) throw new HTTPException(500, { message: "Could not save that date" });

  await audit(db, caller, {
    action: "specialDate.create",
    entityType: "specialDate",
    entityId: created.id,
    changes: auditChangesFor(personId, payload),
  });

  const row = await one<SpecialDateRow>(db, `${SPECIAL_DATE_SELECT} where sd.id = $1`, [
    created.id,
  ]);
  return c.json(row ? toSpecialDate(caller, row) : { id: created.id }, 201);
});

routes.patch("/:id", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const payload = specialDateWriteSchema.parse(await c.req.json());

  const existing = await one<{ person_id: string }>(
    db,
    "select person_id from special_dates where id = $1 and organization_id = $2",
    [id, organizationId]
  );
  if (!existing) throw new HTTPException(404, { message: "Date not found" });
  await assertCanEditPersonById(db, caller, existing.person_id, organizationId);
  await assertRelatedPersonIsUsable(
    db,
    payload.relatedPersonId,
    existing.person_id,
    organizationId
  );

  await db.query(
    `update special_dates
        set type = $2, month = $3, day = $4, year = $5,
            show_year_count = $6, related_person_id = $7,
            rule_reference = $8, rule_direction = $9, rule_unit = $10,
            rule_count = $11, rule_weekday = $12
      where id = $1`,
    [
      id,
      payload.type,
      payload.month ?? null,
      payload.day ?? null,
      payload.year ?? null,
      payload.showYearCount,
      payload.relatedPersonId ?? null,
      payload.rule?.reference ?? null,
      payload.rule?.direction ?? null,
      payload.rule?.unit ?? null,
      payload.rule?.count ?? null,
      payload.rule?.weekday ?? null,
    ]
  );

  await audit(db, caller, {
    action: "specialDate.update",
    entityType: "specialDate",
    entityId: id,
    changes: auditChangesFor(existing.person_id, payload),
  });

  const row = await one<SpecialDateRow>(db, `${SPECIAL_DATE_SELECT} where sd.id = $1`, [id]);
  return c.json(row ? toSpecialDate(caller, row) : { id });
});

routes.delete("/:id", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));

  /*
   * The whole row, not just `person_id` -- this is a hard delete, so it is the
   * only chance to record what the date actually was. Without this, the audit
   * entry names nothing: `TARGET_LABEL` has no row left to resolve, and the
   * card read "special date, since deleted" with an empty body.
   */
  const existing = await one<{
    person_id: string;
    related_person_id: string | null;
    type: string;
    month: number | null;
    day: number | null;
    year: number | null;
    show_year_count: boolean;
    rule_reference: MoveableFeast | null;
    rule_direction: RuleDirection | null;
    rule_unit: RuleUnit | null;
    rule_count: number | null;
    rule_weekday: number | null;
  }>(
    db,
    `select person_id, related_person_id, type, month, day, year, show_year_count,
            rule_reference, rule_direction, rule_unit, rule_count, rule_weekday
       from special_dates where id = $1 and organization_id = $2`,
    [id, organizationId]
  );
  if (!existing) throw new HTTPException(404, { message: "Date not found" });
  await assertCanEditPersonById(db, caller, existing.person_id, organizationId);

  await db.query("delete from special_dates where id = $1", [id]);
  // The same shape `specialDate.create` writes, so the three entries for one
  // date read side by side. `rule` is pre-formatted to a string for the same
  // reason as `auditChangesFor` above: a nested object here would make
  // AuditChanges fall back to a raw JSON dump for the whole entry.
  await audit(db, caller, {
    action: "specialDate.delete",
    entityType: "specialDate",
    entityId: id,
    changes: {
      personId: existing.person_id,
      type: existing.type,
      month: existing.month,
      day: existing.day,
      year: existing.year,
      showYearCount: existing.show_year_count,
      relatedPersonId: existing.related_person_id,
      rule: existing.rule_reference
        ? formatSpecialDateRule({
            reference: existing.rule_reference,
            direction: existing.rule_direction!,
            unit: existing.rule_unit!,
            count: existing.rule_count!,
            weekday: existing.rule_weekday,
          })
        : null,
    },
  });
  return c.body(null, 204);
});

export default routes;
