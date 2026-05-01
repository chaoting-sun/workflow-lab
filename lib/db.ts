import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { getConfig } from "./config";

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<QueryResult<R>>;
}

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: getConfig().DATABASE_URL });
  }
  return pool;
}

async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: ReadonlyArray<unknown>,
): Promise<QueryResult<R>> {
  return getPool().query<R>(text, params as unknown[] | undefined);
}

async function tx<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback errors so the original error surfaces.
    }
    throw err;
  } finally {
    client.release();
  }
}

export const db = { query, tx };

export async function closeDb(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}
