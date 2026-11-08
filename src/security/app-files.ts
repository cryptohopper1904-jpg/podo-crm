/**
 * Hilfen für die Sicherheitstests: Dateien unter src/app aufzählen und in URL-Pfade übersetzen.
 * (Nur Dateisystem – kein Next-Start nötig.)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(__dirname, "../..");
export const SRC = path.join(ROOT, "src");
export const APP = path.join(SRC, "app");

export function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");
export const read = (p: string) => readFileSync(p, "utf8");

const SAMPLE_ID = "00000000-0000-4000-8000-000000000000";

/** src/app/(app)/kunden/[id]/page.tsx → /kunden/<uuid> ; null für private Ordner (_x) und parallele Slots (@x). */
export function urlPathOf(file: string): string | null {
  const segs = path.relative(APP, path.dirname(file)).split(path.sep).filter(Boolean);
  const out: string[] = [];
  for (const s of segs) {
    if (s.startsWith("_") || s.startsWith("@")) return null;
    if (s.startsWith("(") && s.endsWith(")")) continue;
    if (/^\[\[?\.\.\./.test(s)) out.push("a", "b");
    else if (s.startsWith("[")) out.push(SAMPLE_ID);
    else out.push(s);
  }
  return "/" + out.join("/");
}

export type AppRoute = { file: string; kind: "page" | "route"; path: string };

export function appRoutes(): AppRoute[] {
  return walk(APP)
    .filter((f) => /[\\/](page\.(tsx|ts|jsx|js|mdx)|route\.(ts|js))$/.test(f))
    .flatMap((f) => {
      const p = urlPathOf(f);
      return p ? [{ file: rel(f), kind: /route\.(ts|js)$/.test(f) ? ("route" as const) : ("page" as const), path: p }] : [];
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Datei beginnt (nach Kommentaren) mit der Direktive "use server". */
export function isServerActionFile(src: string): boolean {
  const body = src.replace(/^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  return /^["']use server["']/.test(body);
}

/** Teilt eine Datei in Funktionsdefinitionen auf: { name, exported, body } (heuristisch, Top-Level). */
export function functionsOf(src: string): { name: string; exported: boolean; body: string }[] {
  const re = /^(export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*\(|^(export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm;
  const hits = [...src.matchAll(re)];
  return hits.map((m, i) => ({
    name: m[2] ?? m[4],
    exported: !!(m[1] ?? m[3]),
    body: src.slice(m.index!, i + 1 < hits.length ? hits[i + 1].index : src.length),
  }));
}
