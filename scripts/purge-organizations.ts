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
import { readdir, rm } from "node:fs/promises";
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
    // Verwaiste Ablage-Ordner (Praxis existiert nicht mehr, z. B. weil das Löschen der Dateien nach dem DB-Commit
    // fehlschlug) werden bei jedem Lauf erneut erkannt und – mit --execute – entfernt.
    if (!orgArg) {
      const dirs = await readdir(storageRoot, { withFileTypes: true }).catch(() => []);
      const ids = dirs.filter((d) => d.isDirectory() && /^[0-9a-f-]{36}$/.test(d.name)).map((d) => d.name);
      if (ids.length) {
        const { rows } = await client.query<{ id: string }>("select id::text from organizations where id = any($1::uuid[])", [ids]);
        const existing = new Set(rows.map((r) => r.id));
        for (const id of ids.filter((x) => !existing.has(x))) {
          if (execute) {
            try {
              await rm(path.join(storageRoot, id), { recursive: true, force: true });
              console.log(`verwaiste Ablage entfernt: ${id}`);
            } catch (e) {
              failed++;
              console.error(`FEHLER beim Entfernen der Ablage ${id}: ${(e as Error).message}`);
            }
          } else console.log(`würde verwaiste Ablage entfernen: ${id}`);
        }
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
