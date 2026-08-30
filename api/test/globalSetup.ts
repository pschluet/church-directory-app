import { Pool } from "pg";
import type { TestProject } from "vitest/node";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Creates `directory_test` and runs the real migrations once for the whole
 * suite. Doing this per test file made the files race each other on
 * `drop schema public cascade`, which showed up as every database-backed suite
 * mysteriously skipping.
 *
 * If Postgres is not running, this is a no-op: the suites that need a database
 * detect that themselves and skip, so `npm test` still runs offline.
 */

const CONNECTION = {
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? "postgres",
  password: process.env.DB_PASSWORD ?? "postgres",
};

const TEST_DATABASE = process.env.DB_NAME ?? "directory_test";
const MIGRATIONS_DIR = path.resolve(__dirname, "../../db/migrations");

/** Flyway substitutes these; the tests do the same so the SQL is identical. */
const PLACEHOLDERS: Record<string, string> = {
  appRole: "directory_app",
  appRoleLocalPassword: "directory_app",
  superAdminEmail: "bootstrap-super-admin@test.example",
};

declare module "vitest" {
  export interface ProvidedContext {
    /** False when Postgres is not running, so the suites that need it skip. */
    hasDatabase: boolean;
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const admin = new Pool({ ...CONNECTION, database: "postgres", connectionTimeoutMillis: 3000 });
  try {
    const { rows } = await admin.query("select 1 from pg_database where datname = $1", [
      TEST_DATABASE,
    ]);
    if (rows.length === 0) await admin.query(`create database ${TEST_DATABASE}`);
  } catch (err) {
    console.warn(
      `Postgres is not reachable at ${CONNECTION.host}:${CONNECTION.port} — database-backed tests will skip.`,
      err instanceof Error ? err.message : err
    );
    project.provide("hasDatabase", false);
    return;
  } finally {
    await admin.end();
  }

  const target = new Pool({ ...CONNECTION, database: TEST_DATABASE });
  try {
    // Start from nothing: a half-migrated database left by an earlier run is
    // far more confusing than a slightly slower suite.
    await target.query("drop schema if exists public cascade; create schema public;");
    for (const file of fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const sql = fs
        .readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")
        .replace(/\$\{(\w+)\}/g, (match, name: string) => PLACEHOLDERS[name] ?? match);
      await target.query(sql);
    }
  } finally {
    await target.end();
  }

  project.provide("hasDatabase", true);
}
