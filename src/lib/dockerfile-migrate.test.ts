import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Der migrate-Container (deploy/Dockerfile.migrate) kopiert nur ausgewählte Dateien. Importiert ein Skript
 * eine weitere Datei, die dort fehlt, scheitert jedes Update erst auf dem Server („Cannot find module“) –
 * und die neue Version wird zurückgerollt. Dieser Test geht alle relativen Importe der Container-Skripte durch.
 */
const ROOT = path.join(__dirname, "../..");
const ENTRIES = ["scripts/migrate.ts", "scripts/bootstrap.ts", "scripts/seed-demo.ts"];

function copiedPaths(): string[] {
  const docker = readFileSync(path.join(ROOT, "deploy/Dockerfile.migrate"), "utf8");
  const out: string[] = [];
  for (const line of docker.split("\n")) {
    const m = /^COPY\s+(.+)$/.exec(line.trim());
    if (!m || m[1].startsWith("--from")) continue;
    const parts = m[1].split(/\s+/);
    parts.pop(); // Ziel
    out.push(...parts.map((p) => p.replace(/\/$/, "")));
  }
  return out;
}

function resolveImport(from: string, spec: string): string | null {
  const base = path.join(path.dirname(from), spec);
  for (const c of [base + ".ts", base + ".tsx", path.join(base, "index.ts"), base]) {
    if (existsSync(path.join(ROOT, c)) && !c.endsWith("/")) {
      if (/\.(ts|tsx|json)$/.test(c)) return c;
    }
  }
  return null;
}

function localImports(file: string): string[] {
  const src = readFileSync(path.join(ROOT, file), "utf8");
  const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  specs.push(...[...src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]));
  const out: string[] = [];
  for (const s of specs) {
    if (s.startsWith("@/")) out.push(resolveImport("src/x.ts", "./" + s.slice(2)) ?? `UNRESOLVED:${s}`);
    else if (s.startsWith(".")) out.push(resolveImport(file, s) ?? `UNRESOLVED:${s} (in ${file})`);
  }
  return out;
}

describe("deploy/Dockerfile.migrate", () => {
  it("kopiert jede Datei, die migrate/bootstrap/seed-demo (rekursiv) importieren", () => {
    const copied = copiedPaths();
    const isCopied = (f: string) => copied.some((c) => f === c || f.startsWith(c + "/"));
    const seen = new Set<string>();
    const queue = [...ENTRIES];
    const missing: string[] = [];
    while (queue.length) {
      const f = queue.shift()!;
      if (seen.has(f)) continue;
      seen.add(f);
      if (f.startsWith("UNRESOLVED:")) { missing.push(f); continue; }
      if (!isCopied(f)) missing.push(f);
      queue.push(...localImports(f));
    }
    expect(missing).toEqual([]);
  });
});
