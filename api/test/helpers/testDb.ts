import { Pool } from "pg";
import type { Queryable } from "../../src/db";

/**
 * A real Postgres for the route tests.
 *
 * The alternative -- a hand-written fake query layer -- would mean
 * reimplementing enough of Postgres to be wrong in interesting ways, and would
 * cover none of the SQL that carries most of this app's logic: the inheritance
 * resolution view, the CHECK constraints encoding the special-date rules, the
 * keyset pagination comparison. So the suites run against `directory_test`,
 * migrated once by test/globalSetup.ts.
 *
 * Whether a database is available is decided once in globalSetup and read here
 * with vitest's `inject`, so no suite needs a top-level await.
 */

const CONNECTION = {
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? "postgres",
  password: process.env.DB_PASSWORD ?? "postgres",
  database: process.env.DB_NAME ?? "directory_test",
};

let pool: Pool | undefined;

function getPool(): Pool {
  pool ??= new Pool({ ...CONNECTION, max: 4, connectionTimeoutMillis: 3000 });
  return pool;
}

export function testDb(): Queryable {
  const active = getPool();
  const queryable: Queryable = {
    query: (sql, params) => active.query(sql, params as never[]),
    // Route tests assert behaviour, not isolation levels, and every test starts
    // from a truncated database anyway.
    transaction: (fn) => fn(queryable),
  };
  return queryable;
}

const TABLES = [
  "audit_log",
  "special_dates",
  "family_join_requests",
  "person_merge_requests",
  "notifications",
  "notification_preferences",
  "push_subscriptions",
  "prayer_request_images",
  "prayer_requests",
  "persons",
  "families",
  "app_users",
  "organizations",
];

/**
 * Called from `beforeEach`, which is usually before anything has touched the
 * database in this file -- so it has to open the pool itself rather than
 * quietly doing nothing and letting the previous file's rows leak through.
 */
export async function resetTables(): Promise<void> {
  await getPool().query(`truncate ${TABLES.join(", ")} restart identity cascade`);
}

export async function closeDatabase(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
