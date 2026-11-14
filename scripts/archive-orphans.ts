/**
 * Abgleich der Dateiablage mit der Datenbank (Betreiber-Werkzeug): findet verschlüsselte Dateien unter
 * <STORAGE_DIR>/<org-id>/, die in KEINER Tabelle mit Spalte storage_key verzeichnet sind (Beleg-Archiv, Medien,
 * Logos …) – z. B. wenn nach einem Fehler beim Ausstellen das Aufräumen selbst scheiterte (src/server/document-archive.ts).
 *
 *   DATABASE_MIGRATION_URL=postgres://<eigentümer>@…/podo pnpm exec tsx scripts/archive-orphans.ts            # Probelauf
 *   DATABASE_MIGRATION_URL=…                          pnpm exec tsx scripts/archive-orphans.ts --delete   # entfernen
 *
 * Berücksichtigt nur Dateien, die älter als eine Stunde sind (laufende Vorgänge schreiben die Datei vor dem Eintrag).
 * Verzeichnete Dateien werden nie angefasst. RLS ist auch für den Eigentümer erzwungen → je Praxis app.org_id.
 */
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient } from "pg";

const MIN_AGE_MS = 60 * 60 * 1000;
const KEY_RE = /^[a-z0-9/-]+\.bin$/;

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

async function referencedKeys(client: PoolClient, org: string, tables: string[]): Promise<Set<string>> {
  const keys = new Set<string>();
  await client.query("begin");
  try {
    await client.query("select set_config('app.org_id', $1, true)", [org]);
    for (const t of tables) {
      const { rows } = await client.query<{ k: string }>(`select storage_key as k from "${t}" where organization_id = $1 and storage_key is not null`, [org]);
      for (const r of rows) keys.add(r.k);
    }
  } finally {
    await client.query("rollback");
  }
  return keys;
}

async function main() {
  const del = process.argv.includes("--delete");
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error("DATABASE_MIGRATION_URL (Eigentümer-Rolle) fehlt.");
  const root = process.env.STORAGE_DIR ?? path.join(process.cwd(), "data", "storage");
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  let orphans = 0;
  try {
    const { rows: cols } = await client.query<{ t: string }>(
      `select c.table_name as t from information_schema.columns c
        join information_schema.columns o on o.table_schema = c.table_schema and o.table_name = c.table_name and o.column_name = 'organization_id'
       where c.table_schema = 'public' and c.column_name = 'storage_key' order by 1`,
    );
    const tables = cols.map((c) => c.t).filter((t) => /^[a-z_][a-z0-9_]*$/.test(t));
    const { rows: orgs } = await client.query<{ id: string }>("select id::text from organizations");
    console.log(`${del ? "ENTFERNEN" : "PROBELAUF (--delete zum Entfernen)"} · Ablage ${root} · Tabellen: ${tables.join(", ")}`);
    for (const { id } of orgs) {
      const dir = path.join(root, id);
      const known = await referencedKeys(client, id, tables);
      for await (const file of walk(dir)) {
        const key = path.relative(root, file).split(path.sep).join("/");
        if (!KEY_RE.test(key) || known.has(key)) continue;
        if (Date.now() - (await stat(file)).mtimeMs < MIN_AGE_MS) continue;
        orphans++;
        if (del) {
          await rm(file, { force: true });
          console.log(`entfernt: ${key}`);
        } else console.log(`verwaist: ${key}`);
      }
    }
    console.log(`${orphans} verwaiste Datei(en)${del ? " entfernt" : ""}.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
