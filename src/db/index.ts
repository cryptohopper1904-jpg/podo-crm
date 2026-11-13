import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { pool?: Pool };

const pool =
  globalForDb.pool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    // ist der Pool erschöpft, nach 10 s mit Fehler abbrechen statt unbegrenzt zu warten
    connectionTimeoutMillis: 10_000,
  });
if (process.env.NODE_ENV !== "production") globalForDb.pool = pool;

export const db = drizzle(pool, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Führt `fn` in einer Transaktion aus, in der `app.org_id` gesetzt ist.
 * Row-Level-Security (drizzle/0001_security.sql) lässt dann nur Zeilen dieses Mandanten zu.
 * App-Code filtert zusätzlich immer selbst nach organizationId (Defense in Depth).
 */
export async function withOrg<T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${organizationId}, true)`);
    return fn(tx);
  });
}

export { schema };
