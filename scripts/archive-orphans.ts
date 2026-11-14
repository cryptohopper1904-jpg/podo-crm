/**
 * Abgleich der Dateiablage mit der Datenbank (Betreiber-Werkzeug): findet verschlüsselte Dateien unter
 * <storage-dir>/<org-id>/, die in KEINER Tabelle mit Dateiverweis verzeichnet sind – z. B. wenn nach einem Fehler beim
 * Ausstellen das Aufräumen selbst scheiterte (src/server/document-archive.ts).
 *
 *   DATABASE_MIGRATION_URL=postgres://<eigentümer>@…/podo pnpm exec tsx scripts/archive-orphans.ts --storage-dir /data/storage
 *       Probelauf: nur auflisten
 *   … --storage-dir /data/storage --quarantine
 *       verschieben nach <storage-dir>/_quarantaene/<Zeitstempel>/… (Standard für das Aufräumen, umkehrbar)
 *   … --storage-dir /data/storage --delete
 *       endgültig löschen (erst nach Prüfung der Quarantäne)
 *   --max <n>   Obergrenze (Standard 50 Dateien und höchstens 5 % der Dateien einer Praxis) – darüber Abbruch ohne Änderung
 *
 * Verweise: feste Liste (KNOWN_TABLES) – zusätzlich werden alle Tabellen mit Spalte storage_key aus dem Schema gelesen;
 * eine unbekannte Tabelle führt zum Abbruch (sonst könnten deren Dateien fälschlich als verwaist gelten).
 * Nur Dateien, die älter als eine Stunde sind (laufende Vorgänge schreiben die Datei vor dem Eintrag).
 * RLS ist auch für den Eigentümer erzwungen → je Praxis app.org_id.
 */
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient } from "pg";

/** Tabellen mit Dateiverweis (storage_key) – bei neuen Tabellen hier ergänzen */
export const KNOWN_TABLES = ["document_archive", "media", "organization_logos"] as const;
const MIN_AGE_MS = 60 * 60 * 1000;
const KEY_RE = /^[a-z0-9/-]+\.bin$/;
const QUARANTINE = "_quarantaene";

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

async function referencedKeys(client: PoolClient, org: string): Promise<Set<string>> {
  const keys = new Set<string>();
  await client.query("begin");
  try {
    await client.query("select set_config('app.org_id', $1, true)", [org]);
    for (const t of KNOWN_TABLES) {
      const { rows } = await client.query<{ k: string }>(`select storage_key as k from "${t}" where organization_id = $1 and storage_key is not null`, [org]);
      for (const r of rows) keys.add(r.k);
    }
  } finally {
    await client.query("rollback");
  }
  return keys;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const mode = process.argv.includes("--delete") ? "delete" : process.argv.includes("--quarantine") ? "quarantine" : "list";
  const root = arg("--storage-dir");
  if (!root) throw new Error("--storage-dir <Pfad> fehlt (Pflicht – kein Standardpfad, damit nicht versehentlich die falsche Ablage geprüft wird).");
  const max = Number(arg("--max") ?? 50);
  if (!Number.isInteger(max) || max < 1) throw new Error("--max muss eine positive ganze Zahl sein.");
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error("DATABASE_MIGRATION_URL (Eigentümer-Rolle) fehlt.");
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    const { rows: cols } = await client.query<{ t: string }>(
      "select table_name as t from information_schema.columns where table_schema = 'public' and column_name = 'storage_key' order by 1",
    );
    const unknown = cols.map((c) => c.t).filter((t) => !(KNOWN_TABLES as readonly string[]).includes(t));
    if (unknown.length) throw new Error(`Unbekannte Tabelle(n) mit storage_key: ${unknown.join(", ")} – bitte KNOWN_TABLES ergänzen. Abbruch ohne Änderung.`);

    const { rows: orgs } = await client.query<{ id: string }>("select id::text from organizations");
    console.log(`${mode === "list" ? "PROBELAUF" : mode === "quarantine" ? "QUARANTÄNE" : "LÖSCHEN"} · Ablage ${root} · Tabellen: ${KNOWN_TABLES.join(", ")}`);
    const found: { file: string; key: string }[] = [];
    for (const { id } of orgs) {
      const known = await referencedKeys(client, id);
      const orgFound: { file: string; key: string }[] = [];
      let total = 0;
      for await (const file of walk(path.join(root, id))) {
        const key = path.relative(root, file).split(path.sep).join("/");
        if (!KEY_RE.test(key)) continue;
        total++;
        if (known.has(key)) continue;
        if (Date.now() - (await stat(file)).mtimeMs < MIN_AGE_MS) continue;
        orgFound.push({ file, key });
      }
      // Plausibilität: viele „verwaiste“ Dateien deuten eher auf eine falsche Datenbank/Ablage hin
      if (mode !== "list" && orgFound.length > Math.max(1, Math.floor(total * 0.05)) && orgFound.length > 1) {
        throw new Error(`Praxis ${id}: ${orgFound.length} von ${total} Dateien wären verwaist (> 5 %) – Abbruch ohne Änderung. Bitte Datenbank/Ablage prüfen.`);
      }
      found.push(...orgFound);
    }
    if (mode !== "list" && found.length > max) throw new Error(`${found.length} verwaiste Dateien (> ${max}) – Abbruch ohne Änderung. Mit --max erhöhen, wenn geprüft.`);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const f of found) {
      if (mode === "list") console.log(`verwaist: ${f.key}`);
      else if (mode === "quarantine") {
        const dest = path.join(root, QUARANTINE, stamp, f.key);
        await mkdir(path.dirname(dest), { recursive: true });
        await rename(f.file, dest);
        console.log(`in Quarantäne: ${f.key}`);
      } else {
        await rm(f.file, { force: true });
        console.log(`gelöscht: ${f.key}`);
      }
    }
    console.log(`${found.length} verwaiste Datei(en)${mode === "quarantine" ? ` → ${path.join(root, QUARANTINE, stamp)}` : mode === "delete" ? " gelöscht" : ""}.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
