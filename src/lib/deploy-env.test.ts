import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Gesamt-Review H2: Der App-Container darf nur die Variablen bekommen, die die App braucht – nie das Passwort
 * des Tabelleneigentümers (RLS/Trigger abschaltbar), die Backup-Passphrase oder Bootstrap-Passwörter.
 * (Einfacher Zeilen-Parser statt YAML-Bibliothek: geprüft wird nur die Struktur von deploy/docker-compose.yml.)
 */
const compose = readFileSync(path.join(process.cwd(), "deploy/docker-compose.yml"), "utf8");

function serviceBlock(name: string): string {
  const lines = compose.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `Dienst ${name}`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && /^ {2}[a-z_-]+:/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).filter((l) => !/^\s*#/.test(l)).join("\n");
}

function envKeys(block: string): string[] {
  const lines = block.split("\n");
  const start = lines.findIndex((l) => l === "    environment:");
  if (start < 0) return [];
  const keys: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^ {4}\S/.test(l)) break;
    const m = /^ {6}([A-Z_][A-Z0-9_]*):/.exec(l);
    if (m) keys.push(m[1]);
  }
  return keys;
}

const SECRETS_NOT_FOR_APP = ["DB_OWNER_PASSWORD", "BACKUP_PASSPHRASE", "BOOTSTRAP_ADMIN_PASSWORD", "BOOTSTRAP_PRACTICE_OWNER_PASSWORD", "SEED_DEMO_PASSWORD"];
/** Nur Entwicklung/Tests bzw. vom Image gesetzt */
// APP_COMMIT: im Image gesetzt (Dockerfile, Build-Argument GIT_SHA), nicht über die Compose-Umgebung
const NOT_NEEDED_IN_CONTAINER = new Set(["NODE_ENV", "VITEST", "TEST_DATABASE_URL", "TEST_OWNER_DATABASE_URL", "APP_COMMIT"]);
/** Laufen nur im migrate-Container (deploy/Dockerfile.migrate), nicht in der App */
const MIGRATE_ONLY = new Set(["src/lib/bootstrap.ts", "src/lib/demo-seed.ts"]);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
  });
}

describe("deploy/docker-compose.yml – Umgebung des App-Containers", () => {
  const app = serviceBlock("app");
  const keys = envKeys(app);

  it("kein env_file (sonst landet die ganze deploy/.env in der App)", () => {
    expect(app).not.toMatch(/^\s+env_file:/m);
  });

  it("keine Betriebsgeheimnisse in der App", () => {
    for (const k of SECRETS_NOT_FOR_APP) {
      expect(keys).not.toContain(k);
      expect(app).not.toContain(`\${${k}`);
    }
    expect(app).not.toContain("podo_owner");
  });

  it("jede von der App gelesene Variable ist durchgereicht", () => {
    const used = new Set<string>();
    for (const f of walk(path.join(process.cwd(), "src"))) {
      if (MIGRATE_ONLY.has(path.relative(process.cwd(), f))) continue;
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/(?:process\.)?env\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1]);
    }
    const missing = [...used].filter((k) => !NOT_NEEDED_IN_CONTAINER.has(k) && !keys.includes(k));
    expect(missing).toEqual([]);
  });

  it("Praxissuche: eigenes LLM (LEAD_LLM_*) mit Freigabe, nur in src/server/lead-search.ts gelesen", () => {
    for (const k of ["LEAD_SEARCH_LLM_APPROVED", "LEAD_LLM_BASE_URL", "LEAD_LLM_API_KEY", "LEAD_LLM_MODEL"]) expect(keys).toContain(k);
    const readers = walk(path.join(process.cwd(), "src"))
      .filter((f) => /env\.LEAD_LLM_|env\.LEAD_SEARCH_LLM_APPROVED/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(process.cwd(), f));
    expect(readers).toEqual(["src/server/lead-search.ts"]);
    // die Praxissuche nutzt NICHT die globalen LLM_* (Patientendaten-Funktionen)
    expect(readFileSync(path.join(process.cwd(), "src/server/lead-search.ts"), "utf8")).not.toMatch(/env\.LLM_/);
  });

  it("Eigentümer-Passwort nur bei db/migrate/backup, Backup-Passphrase nur bei backup", () => {
    expect(serviceBlock("migrate")).toContain("${DB_OWNER_PASSWORD}");
    expect(serviceBlock("backup")).toContain("${DB_OWNER_PASSWORD}");
    expect(serviceBlock("backup")).toContain("${BACKUP_PASSPHRASE");
    for (const s of ["app", "cron", "caddy", "migrate", "db"]) expect(serviceBlock(s)).not.toContain("BACKUP_PASSPHRASE");
    for (const s of ["app", "cron", "caddy"]) expect(serviceBlock(s)).not.toContain("DB_OWNER_PASSWORD");
  });
});
