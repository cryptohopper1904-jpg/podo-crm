/**
 * Löschlauf für gekündigte Praxen (Betreiber-Werkzeug).
 *
 *   DATABASE_MIGRATION_URL=postgres://<eigentümer>@…/podo pnpm exec tsx scripts/purge-organizations.ts            # Probelauf (Standard)
 *   DATABASE_MIGRATION_URL=…                          pnpm exec tsx scripts/purge-organizations.ts --execute  # endgültig löschen
 *   … --org <uuid>   nur diese Praxis (muss ebenfalls fällig sein)
 *
 * Fällig = organizations.deletion_requested_at älter als 30 Tage (src/lib/org-deletion.ts).
 * Benötigt die EIGENTÜMER-Rolle der Tabellen (nicht die App-Rolle): Nur der Eigentümer darf die
 * Unveränderbarkeits-Trigger innerhalb der Lösch-Transaktion aussetzen (Details: src/server/purge-organization.ts).
 * Löscht anschließend <STORAGE_DIR>/<org-id>/. Verschlüsselte Backups laufen nach ihrer Frist (14 Tage) aus.
 */
import path from "node:path";
import { Pool } from "pg";
import { assertTableOwner, findDueOrganizations, purgeOrganization } from "../src/server/purge-organization";

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const orgArg = args.includes("--org") ? args[args.indexOf("--org") + 1] : null;
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error("DATABASE_MIGRATION_URL (Eigentümer-Rolle) fehlt – mit der App-Rolle ist keine Löschung möglich.");
  const storageRoot = process.env.STORAGE_DIR ?? path.join(process.cwd(), "data", "storage");

  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await assertTableOwner(client);
    const due = await findDueOrganizations(client);
    const targets = orgArg ? due.filter((o) => o.id === orgArg) : due;
    if (orgArg && !targets.length) throw new Error(`Praxis ${orgArg} ist nicht zur Löschung fällig.`);
    console.log(`${execute ? "LÖSCHLAUF" : "PROBELAUF (nichts wird gelöscht, --execute zum Ausführen)"} · ${targets.length} fällige Praxis(en) · Ablage: ${storageRoot}`);
    let failed = 0;
    for (const o of targets) {
      try {
        const r = await purgeOrganization(client, o.id, { execute, storageRoot, log: (l) => console.log(l) });
        const total = Object.values(r.rows).reduce((a, b) => a + b, 0);
        console.log(`${execute ? "gelöscht" : "würde löschen"}: ${o.slug} (${o.id}), beantragt ${o.deletionRequestedAt.toISOString()} · ${total} Zeilen · ${r.users} Benutzer${r.usersKept ? ` (${r.usersKept} behalten)` : ""}`);
        if (!execute) for (const [t, n] of Object.entries(r.rows)) if (n) console.log(`    ${t.padEnd(26)} ${n}`);
      } catch (e) {
        failed++;
        console.error(`FEHLER bei ${o.slug} (${o.id}): ${(e as Error).message}`);
      }
    }
    if (failed) process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
