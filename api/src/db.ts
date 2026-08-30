import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { Signer } from "@aws-sdk/rds-signer";
import { RDS_CA_BUNDLE } from "./rds-ca";

/**
 * Postgres access.
 *
 * Two authentication modes, chosen by DB_AUTH:
 *
 *   iam       Deployed. The Lambda sits in the VPC with no internet route, so
 *             it cannot call Secrets Manager. `@aws-sdk/rds-signer` builds an
 *             auth token by signing locally -- no network call at all -- and
 *             that token is used as the password. Tokens are valid for 15
 *             minutes, but they only authenticate the handshake, so pooled
 *             connections established with one keep working afterwards; we
 *             simply mint a fresh token for each new connection.
 *
 *   password  Local development and tests, against the Docker Postgres.
 *
 * The pool is deliberately tiny. db.t4g.micro has roughly 110 max_connections,
 * and a Lambda container handles one request at a time, so more than a couple
 * of connections per container buys nothing and risks exhausting the server
 * across concurrent cold starts. That also means there is no need for RDS Proxy.
 */

// The defaults are the docker-compose Postgres, matching scripts/seed.ts and the
// test helpers so local runs need no environment. The deployed Lambda sets all of
// them explicitly from the stack (infra/lib/church-directory-stack.ts).
const DB_HOST = process.env.DB_HOST ?? "localhost";
const DB_PORT = Number(process.env.DB_PORT ?? "5432");
const DB_NAME = process.env.DB_NAME ?? "directory";
const DB_USER = process.env.DB_USER ?? "postgres";
const DB_AUTH = (process.env.DB_AUTH ?? "password") as "iam" | "password";
const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

let pool: Pool | undefined;

export function getPool(): Pool {
  if (pool) return pool;

  if (DB_AUTH === "iam") {
    const signer = new Signer({
      hostname: DB_HOST,
      port: DB_PORT,
      username: DB_USER,
      region: AWS_REGION,
    });
    pool = new Pool({
      host: DB_HOST,
      port: DB_PORT,
      database: DB_NAME,
      user: DB_USER,
      // `password` may be a function; pg calls it per new connection, which is
      // exactly the token lifetime we want.
      password: () => signer.getAuthToken(),
      ssl: { ca: RDS_CA_BUNDLE, rejectUnauthorized: true },
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  } else {
    pool = new Pool({
      host: DB_HOST,
      port: DB_PORT,
      database: DB_NAME,
      user: DB_USER,
      password: requiredEnv("DB_PASSWORD"),
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  // An idle-client error would otherwise take the whole process down.
  pool.on("error", (err) => {
    console.error("Unexpected idle Postgres client error", err);
  });

  return pool;
}

/**
 * The single seam every route goes through, so tests can swap in a fake
 * (test/helpers/fakeDb.ts) without a live database.
 *
 * `transaction` is part of the interface rather than a free function so that
 * routes needing atomicity do not have to know whether they are talking to a
 * real pool: the fake simply runs the callback inline.
 */
export interface Queryable {
  query<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/**
 * Used wherever a request writes more than one row -- inviting a user
 * (app_users + persons), approving a join request (family_join_requests +
 * persons), moving someone between families.
 */
async function withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client: PoolClient = await getPool().connect();
  const tx: Queryable = {
    query: (sql, params) => client.query(sql, params as never[]),
    // Already inside a transaction; nesting would need savepoints and nothing
    // here needs them.
    transaction: (inner) => inner(tx),
  };
  try {
    await client.query("begin");
    const result = await fn(tx);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export const db: Queryable = {
  query: (sql, params) => getPool().query(sql, params as never[]),
  transaction: withTransaction,
};

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** First row or null -- the shape almost every lookup wants. */
export async function one<T extends QueryResultRow>(
  q: Queryable,
  sql: string,
  params?: unknown[]
): Promise<T | null> {
  const { rows } = await q.query<T>(sql, params);
  return rows[0] ?? null;
}
