/** Führt alle Migrationen aus (als DB-Eigentümer, nicht als App-Rolle). */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_MIGRATION_URL fehlt");
  const pool = new Pool({ connectionString: url });
  await pool.query("create extension if not exists pgcrypto");
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  // App-Rolle (kein Superuser, unterliegt RLS) mit Rechten versorgen, falls vorhanden
  const appRole = process.env.DB_APP_ROLE ?? "podo_app";
  if (!/^[a-z_][a-z0-9_]*$/.test(appRole)) throw new Error("Ungültiger Rollenname");
  const r = await pool.query("select 1 from pg_roles where rolname = $1", [appRole]);
  if (r.rowCount) {
    await pool.query(`grant usage on schema public to ${appRole}`);
    await pool.query(`grant select, insert, update, delete on all tables in schema public to ${appRole}`);
    await pool.query(`grant usage, select on all sequences in schema public to ${appRole}`);
    // nur lesend: Migrationsstand für /api/health/deep (Tabelle legt drizzle beim ersten migrate an)
    await pool.query(`grant usage on schema drizzle to ${appRole}`);
    await pool.query(`grant select on drizzle.__drizzle_migrations to ${appRole}`);
  }
  await pool.end();
  console.log("Migrationen ausgeführt.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
