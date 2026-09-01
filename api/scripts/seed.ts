/**
 * Seeds the local database with enough of a parish to exercise every view:
 * two organizations (so the super admin's switcher has something to do),
 * families with inherited attributes, people with and without accounts, and
 * special dates placed relative to today so the upcoming list is never empty.
 *
 * Safe to re-run: it clears the tables first. Never point this at production.
 */
import { Pool } from "pg";

const DB_NAME = process.env.DB_NAME ?? "directory";
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL ?? "paul@paulschlueter.com";

if (process.env.DB_AUTH === "iam") {
  console.error("Refusing to seed: DB_AUTH=iam means this is pointed at RDS, not local Postgres.");
  process.exit(1);
}

const pool = new Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  database: DB_NAME,
  user: process.env.DB_USER ?? "postgres",
  password: process.env.DB_PASSWORD ?? "postgres",
});

/** A month/day `offset` days from today, for dates that should be "coming up". */
function relativeDate(offsetDays: number): { month: number; day: number } {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

async function main(): Promise<void> {
  await pool.query(
    `truncate audit_log, special_dates, family_join_requests, person_merge_requests,
              persons, families, app_users, organizations restart identity cascade`
  );

  const { rows: orgs } = await pool.query<{ id: string; slug: string }>(
    `insert into organizations (name, slug) values
       ('All Saints Antiochian Orthodox Church', 'all-saints'),
       ('St. George Orthodox Church', 'st-george')
     returning id, slug`
  );
  const allSaints = orgs.find((o) => o.slug === "all-saints")!.id;
  const stGeorge = orgs.find((o) => o.slug === "st-george")!.id;

  // The bootstrap super admin, matching V3__bootstrap_super_admin.sql. Left
  // with no cognito_sub so the bind-by-email path is exercised on first sign-in.
  await pool.query(
    `insert into app_users (email, role, organization_id, status)
     values ($1, 'SUPER_ADMIN', null, 'INVITED')`,
    [SUPER_ADMIN_EMAIL]
  );

  const families = new Map<string, string>();
  for (const [orgId, name] of [
    [allSaints, "Schlueter"],
    [allSaints, "Popov"],
    [allSaints, "Haddad"],
    [stGeorge, "Georgiev"],
  ] as const) {
    const { rows } = await pool.query<{ id: string }>(
      "insert into families (organization_id, name) values ($1, $2) returning id",
      [orgId, name]
    );
    families.set(name, rows[0]!.id);
  }

  async function addUser(options: {
    organizationId: string;
    email: string;
    role: "SUPER_ADMIN" | "ADMIN" | "USER";
    firstName: string;
    lastName: string;
    familyName?: string;
    phone?: string;
    address?: [string, string, string, string];
    patronSaint?: string;
  }): Promise<string> {
    const { rows: userRows } = await pool.query<{ id: string }>(
      `insert into app_users (cognito_sub, email, role, organization_id, status)
       values ($1, $2, $3, $4, 'ACTIVE') returning id`,
      [`dev-${options.email}`, options.email, options.role, options.organizationId]
    );
    const [line1, city, state, postal] = options.address ?? ["", "", "", ""];
    const { rows } = await pool.query<{ id: string }>(
      `insert into persons (organization_id, family_id, app_user_id, first_name, last_name,
                            email, phone, address_line1, city, state, postal_code, patron_saint)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       returning id`,
      [
        options.organizationId,
        options.familyName ? families.get(options.familyName) : null,
        userRows[0]!.id,
        options.firstName,
        options.lastName,
        options.email,
        options.phone ?? null,
        line1 || null,
        city || null,
        state || null,
        postal || null,
        options.patronSaint ?? null,
      ]
    );
    return rows[0]!.id;
  }

  const paul = await addUser({
    organizationId: allSaints,
    email: "paul@example.com",
    role: "ADMIN",
    firstName: "Paul",
    lastName: "Schlueter",
    familyName: "Schlueter",
    phone: "+13125551234",
    address: ["4129 W Newport Ave", "Chicago", "IL", "60641"],
    patronSaint: "St. Paul the Apostle",
  });

  const maria = await addUser({
    organizationId: allSaints,
    email: "maria@example.com",
    role: "USER",
    firstName: "Maria",
    lastName: "Schlueter",
    familyName: "Schlueter",
    phone: "+13125552345",
    address: ["4129 W Newport Ave", "Chicago", "IL", "60641"],
    patronSaint: "St. Mary of Egypt",
  });

  const boris = await addUser({
    organizationId: allSaints,
    email: "boris@example.com",
    role: "USER",
    firstName: "Boris",
    lastName: "Popov",
    familyName: "Popov",
    phone: "+17735553456",
    address: ["1200 N Ashland Ave", "Chicago", "IL", "60622"],
    patronSaint: "St. Boris",
  });

  await addUser({
    organizationId: allSaints,
    email: "layla@example.com",
    role: "USER",
    firstName: "Layla",
    lastName: "Haddad",
    familyName: "Haddad",
    phone: "+18475554567",
    address: ["55 Green Bay Rd", "Wilmette", "IL", "60091"],
  });

  await addUser({
    organizationId: stGeorge,
    email: "dimitar@example.com",
    role: "ADMIN",
    firstName: "Dimitar",
    lastName: "Georgiev",
    familyName: "Georgiev",
    phone: "+13125559876",
    address: ["917 N Wood St", "Chicago", "IL", "60622"],
  });

  // Children with no account, inheriting from a parent -- the case the
  // resolution view exists for.
  async function addChild(
    familyName: string,
    firstName: string,
    inheritFrom: string,
    patronSaint?: string
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `insert into persons (organization_id, family_id, first_name, patron_saint,
                            inherit_last_name_from_person_id,
                            inherit_email_from_person_id,
                            inherit_phone_from_person_id,
                            inherit_address_from_person_id)
       values ($1, $2, $3, $4, $5, $5, $5, $5)
       returning id`,
      [allSaints, families.get(familyName), firstName, patronSaint ?? null, inheritFrom]
    );
    return rows[0]!.id;
  }

  const anna = await addChild("Schlueter", "Anna", paul, "St. Anna");
  const nikolai = await addChild("Schlueter", "Nikolai", paul, "St. Nicholas");
  const ivan = await addChild("Popov", "Ivan", boris, "St. John of Kronstadt");

  async function addDate(
    personId: string,
    type: "BIRTHDAY" | "ANNIVERSARY" | "FEAST_DAY",
    month: number,
    day: number,
    options: { year?: number; showYearCount?: boolean; relatedPersonId?: string } = {}
  ): Promise<void> {
    await pool.query(
      `insert into special_dates
         (organization_id, person_id, related_person_id, type, month, day, year, show_year_count)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        allSaints,
        personId,
        options.relatedPersonId ?? null,
        type,
        month,
        day,
        options.year ?? null,
        options.showYearCount ?? false,
      ]
    );
  }

  // Spread across the next few days so the default 7-day window has content,
  // and a couple further out for the 30-day range and the calendar view.
  const today = relativeDate(0);
  const inTwo = relativeDate(2);
  const inThree = relativeDate(3);
  const inFive = relativeDate(5);
  const inTwenty = relativeDate(20);

  // Age shown.
  await addDate(paul, "BIRTHDAY", today.month, today.day, { year: 1985, showYearCount: true });
  // Age deliberately withheld, though a year is on record.
  await addDate(maria, "BIRTHDAY", inTwo.month, inTwo.day, { year: 1987 });
  // Month and day only.
  await addDate(anna, "BIRTHDAY", inThree.month, inThree.day);
  await addDate(nikolai, "BIRTHDAY", inTwenty.month, inTwenty.day, { year: 2015 });
  // Feast days -- the patron saint's day, month and day only.
  await addDate(anna, "FEAST_DAY", today.month, today.day);
  await addDate(ivan, "FEAST_DAY", inFive.month, inFive.day);
  await addDate(boris, "FEAST_DAY", inTwo.month, inTwo.day);
  // One anniversary, linking two people, years shown.
  await addDate(paul, "ANNIVERSARY", inFive.month, inFive.day, {
    year: 2010,
    showYearCount: true,
    relatedPersonId: maria,
  });
  // A leap-day feast, to check the 1 March fallback.
  await addDate(nikolai, "FEAST_DAY", 2, 29);

  // A join request waiting for approval.
  await pool.query(
    `insert into family_join_requests (organization_id, family_id, person_id)
     values ($1, $2, $3)`,
    [allSaints, families.get("Schlueter"), boris]
  );

  const { rows: counts } = await pool.query<{ people: string; dates: string }>(
    `select (select count(*) from persons) as people,
            (select count(*) from special_dates) as dates`
  );

  console.log(
    `Seeded ${DB_NAME}: 2 organizations, ${families.size} families, ` +
      `${counts[0]!.people} people, ${counts[0]!.dates} special dates.`
  );
  console.log(`Sign in locally with: DEV_AUTH_EMAIL=paul@example.com (admin)`);
  console.log(`             or       DEV_AUTH_EMAIL=${SUPER_ADMIN_EMAIL} (super admin)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
