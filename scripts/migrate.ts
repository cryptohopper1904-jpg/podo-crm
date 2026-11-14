/** Führt alle Migrationen aus (als DB-Eigentümer, nicht als App-Rolle). */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Migration 0048 legt den eindeutigen Index je SumUp-Transaktion nur an, wenn es keine doppelten Referenzen gibt.
 * Fehlt er, laut warnen (Deploy läuft weiter) – die Dubletten müssen fachlich geklärt werden.
 */
async function warnMissingPaymentRefIndex(pool: Pool) {
  const r = await pool.query("select 1 from pg_indexes where schemaname = 'public' and indexname = 'payments_org_sumup_ref'");
  if (r.rowCount) return;
  console.error(
    [
      "",
      "WARNUNG: Index payments_org_sumup_ref fehlt – doppelte SumUp-Referenzen in payments vorhanden (Migration 0048).",
      "SumUp-Zahlungen sind dann nur über die Zeilensperre gegen Doppelbuchung geschützt. Dubletten prüfen",
      "(als Superuser bzw. Rolle mit BYPASSRLS, RLS ist erzwungen):",
      "  select organization_id, external_ref, count(*), array_agg(invoice_id) from payments",
      "  where external_ref like 'sumup:%' group by 1, 2 having count(*) > 1;",
      "Nach der Klärung (Storno/Gegenbuchung, Steuerberatung) Migration erneut ausführen oder den Index anlegen:",
      "  create unique index payments_org_sumup_ref on payments (organization_id, external_ref) where external_ref like 'sumup:%';",
      "",
    ].join("\n"),
  );
}

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_MIGRATION_URL fehlt");
  const pool = new Pool({ connectionString: url });
  // NOTICEs aus Migrationen (z. B. 0048: Index wegen Dubletten nicht angelegt) im Deploy-Log ausgeben
  pool.on("connect", (client) => {
    client.on("notice", (n) => {
      // harmlose Meldungen idempotenter DDL („… does not exist, skipping“ / „already exists, skipping“) auslassen
      if (/, skipping$/.test(n.message ?? "")) return;
      console.warn(`[migrate] NOTICE: ${n.message}`);
    });
  });
  await pool.query("create extension if not exists pgcrypto");
  // Trigramm-Suche (Patientensuche „Meinten Sie“, Migration 0044) – auch dort idempotent angelegt
  await pool.query("create extension if not exists pg_trgm");
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  // App-Rolle (kein Superuser, unterliegt RLS) mit Rechten versorgen, falls vorhanden
  const appRole = process.env.DB_APP_ROLE ?? "podo_app";
  if (!/^[a-z_][a-z0-9_]*$/.test(appRole)) throw new Error("Ungültiger Rollenname");
  const r = await pool.query("select 1 from pg_roles where rolname = $1", [appRole]);
  if (r.rowCount) {
    await pool.query(`grant usage on schema public to ${appRole}`);
    await pool.query(`grant select, insert, update, delete on all tables in schema public to ${appRole}`);
    await pool.query(`grant usage, select on all sequences in schema public to ${appRole}`);
    // Einlösungen von Aktionscodes sind ein Nachweis: die App-Rolle darf sie nur anlegen und lesen.
    // Gelöscht werden sie nur mit der Praxis (FK-Kaskade bzw. Löschlauf als Eigentümer, src/server/purge-organization.ts).
    await pool.query(`revoke update, delete on promo_redemptions from ${appRole}`);
    // Vertriebs-Einstellungen (genau eine Zeile, Kanarienwert des Sperrlisten-Schlüssels, Trigger 0043): die App-Rolle
    // darf sie nicht löschen – sonst ließe sich der Kanarienwert per Löschen und Neuanlegen umgehen.
    await pool.query(`revoke delete on sales_settings from ${appRole}`);
    // nur lesend: Migrationsstand für /api/health/deep (Tabelle legt drizzle beim ersten migrate an)
    await pool.query(`grant usage on schema drizzle to ${appRole}`);
    await pool.query(`grant select on drizzle.__drizzle_migrations to ${appRole}`);
  }
  await warnMissingPaymentRefIndex(pool);
  await pool.end();
  console.log("Migrationen ausgeführt.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
