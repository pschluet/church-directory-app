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
  toIsoDate,
  yearCountFor,
} from "../services/upcoming-dates";
import {
  specialDateWriteSchema,
  uuidSchema,
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
  month_day_key: number;
}

async function loadOccurrences(
  db: AppEnv["Variables"]["db"],
  organizationId: string,
  keys: number[]
): Promise<OccurrenceRow[]> {
  if (keys.length === 0) return [];
  const { rows } = await db.query<OccurrenceRow>(
    `${SPECIAL_DATE_SELECT}
      where sd.organization_id = $1
        and p.deleted_at is null
        and (sd.month * 100 + sd.day) = any($2::int[])`,
    [organizationId, keys]
  );
  return rows.map((row) => ({ ...row, month_day_key: monthDayKey(row.month, row.day) }));
}

/**
 * Maps rows onto the calendar days of a window. A row can land on more than one
 * day only when the window is long enough to wrap a year, which the 366-day cap
 * makes the outer limit.
 */
function groupByDay(
  window: ReturnType<typeof expandWindow>,
  rows: OccurrenceRow[]
): UpcomingDatesDto["days"] {
  const byKey = new Map<number, OccurrenceRow[]>();
  for (const row of rows) {
    const list = byKey.get(row.month_day_key);
    if (list) list.push(row);
    else byKey.set(row.month_day_key, [row]);
  }

  return window.map((day) => {
    const occurrences: SpecialDateOccurrenceDto[] = [];
    for (const key of day.monthDayKeys) {
      for (const row of byKey.get(key) ?? []) {
        const base = toSpecialDate(row);
        occurrences.push({
          ...base,
          date: day.iso,
          yearCount: yearCountFor(day.year, row.year, row.show_year_count),
        });
      }
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

  const window = expandWindow(start, Number.isFinite(days) ? days : DEFAULT_WINDOW_DAYS);
  const rows = await loadOccurrences(db, organizationId, allMonthDayKeys(window));

  const body: UpcomingDatesDto = {
    start: window[0]?.iso ?? start,
    end: window[window.length - 1]?.iso ?? start,
    days: groupByDay(window, rows),
  };
  return c.json(body);
});

/**
 * The month grid: which days in a month have anything on them, and what. The
 * SPA renders dots from the counts and the detail list from `dates`.
 */
routes.get("/calendar", async (c) => {
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

  return c.json({ year, month, days: groupByDay(window, rows) });
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

routes.post("/", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const raw = (await c.req.json()) as Record<string, unknown>;
  const personId = uuidSchema.parse(raw.personId);
  const payload = specialDateWriteSchema.parse(raw);

  await assertCanEditPersonById(db, caller, personId, organizationId);

  if (payload.relatedPersonId) {
    if (payload.relatedPersonId === personId) {
      throw new HTTPException(400, { message: "An anniversary must link two different people" });
    }
    const related = await one<{ id: string }>(
      db,
      "select id from persons where id = $1 and organization_id = $2 and deleted_at is null",
      [payload.relatedPersonId, organizationId]
    );
    if (!related) throw new HTTPException(404, { message: "The other person was not found" });
  }

  const created = await one<{ id: string }>(
    db,
    `insert into special_dates
       (organization_id, person_id, related_person_id, type, month, day, year, show_year_count)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      organizationId,
      personId,
      payload.relatedPersonId ?? null,
      payload.type,
      payload.month,
      payload.day,
      payload.year ?? null,
      payload.showYearCount,
    ]
  );
  if (!created) throw new HTTPException(500, { message: "Could not save that date" });

  await audit(db, caller, {
    action: "specialDate.create",
    entityType: "specialDate",
    entityId: created.id,
    changes: { personId, ...payload },
  });

  const row = await one<SpecialDateRow>(db, `${SPECIAL_DATE_SELECT} where sd.id = $1`, [
    created.id,
  ]);
  return c.json(row ? toSpecialDate(row) : { id: created.id }, 201);
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

  await db.query(
    `update special_dates
        set type = $2, month = $3, day = $4, year = $5,
            show_year_count = $6, related_person_id = $7
      where id = $1`,
    [
      id,
      payload.type,
      payload.month,
      payload.day,
      payload.year ?? null,
      payload.showYearCount,
      payload.relatedPersonId ?? null,
    ]
  );

  await audit(db, caller, {
    action: "specialDate.update",
    entityType: "specialDate",
    entityId: id,
    changes: payload,
  });

  const row = await one<SpecialDateRow>(db, `${SPECIAL_DATE_SELECT} where sd.id = $1`, [id]);
  return c.json(row ? toSpecialDate(row) : { id });
});

routes.delete("/:id", async (c) => {
  const caller = c.get("caller");
  const db = c.get("db");
  const organizationId = requireOrganizationId(c);
  const id = uuidSchema.parse(c.req.param("id"));

  const existing = await one<{ person_id: string }>(
    db,
    "select person_id from special_dates where id = $1 and organization_id = $2",
    [id, organizationId]
  );
  if (!existing) throw new HTTPException(404, { message: "Date not found" });
  await assertCanEditPersonById(db, caller, existing.person_id, organizationId);

  await db.query("delete from special_dates where id = $1", [id]);
  await audit(db, caller, {
    action: "specialDate.delete",
    entityType: "specialDate",
    entityId: id,
  });
  return c.body(null, 204);
});

export default routes;
