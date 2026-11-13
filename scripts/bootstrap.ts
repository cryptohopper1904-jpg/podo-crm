/**
 * Bootstrap per Umgebung (frische Server ohne Shell): Plattform-Admin und optional eine Praxis anlegen.
 * Läuft im migrate-Container NACH scripts/migrate.ts (als DB-Eigentümer). Idempotent – siehe src/lib/bootstrap.ts.
 *   BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_NAME / BOOTSTRAP_ADMIN_PASSWORD
 *   BOOTSTRAP_PRACTICE_JSON (Pfad oder JSON) / BOOTSTRAP_PRACTICE_OWNER_PASSWORD
 *   BOOTSTRAP_ADMIN_DEMO=false → keine „Demo-Praxis (Beispieldaten)“ für den Plattform-Admin (Standard: an)
 *   BOOTSTRAP_STRICT=true → Konfigurationsfehler lassen den Container fehlschlagen (Standard: nur Warnung,
 *   damit die App trotzdem startet).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/db/schema";
import { BootstrapError, runBootstrap } from "../src/lib/bootstrap";

async function main() {
  const env = process.env;
  if (!env.BOOTSTRAP_ADMIN_EMAIL?.trim() && !env.BOOTSTRAP_PRACTICE_JSON?.trim()) {
    console.log("Bootstrap: keine BOOTSTRAP_*-Variablen gesetzt – nichts zu tun.");
    return;
  }
  const url = env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_MIGRATION_URL fehlt");
  const pool = new Pool({ connectionString: url });
  try {
    const r = await runBootstrap(drizzle(pool, { schema }), env);
    console.log(`Bootstrap: Plattform-Admin ${r.admin}, Praxis ${r.practice}${r.practiceSlug ? ` (${r.practiceSlug})` : ""}${r.billingMode ? `, Abrechnungsmodus ${r.billingMode === "set" ? "gesetzt" : "unverändert"}` : ""}${r.documents ? `, Belege-Angaben ${r.documents === "set" ? "gesetzt" : "unverändert"}` : ""}, Demo-Praxis ${r.demo}.`);
    for (const w of r.warnings) console.warn(`Bootstrap-Hinweis: ${w}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  // Passwörter erscheinen nie in Meldungen (BootstrapError nennt nur Variablennamen)
  const msg = e instanceof BootstrapError ? e.message : e instanceof Error ? e.message : String(e);
  console.error(`Bootstrap fehlgeschlagen: ${msg}`);
  process.exit(process.env.BOOTSTRAP_STRICT === "true" || !(e instanceof BootstrapError) ? 1 : 0);
});
