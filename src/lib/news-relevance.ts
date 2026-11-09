/**
 * Relevanzfilter für die News-Seite: Nur Meldungen, die für Podolog:innen relevant sind.
 * Reine Funktionen (ohne DB/Netz) – getestet in news-relevance.test.ts.
 */
import { wordRegex } from "./unicode-regex";

/** Gewichtete Schlagwörter. Treffer werden je Regel einmal gezählt. */
const POSITIVE: [number, RegExp][] = [
  // eindeutig podologisch
  [4, wordRegex(String.raw`\bpodolog\w*`)],
  [4, wordRegex(String.raw`\bfußpfleg\w*|\bfusspfleg\w*`)],
  [4, wordRegex(String.raw`\bdiabetisch\w*\s+fuß\w*|\bfußsyndrom\w*|\bfußulk\w*|\bfußulzer\w*`)],
  [4, wordRegex(String.raw`\bnagel(korrektur|spange)\w*|\bkorrekturspange\w*|\bunguis\s+incarnatus\b|\beingewachsen\w*\s+(zehen|fuß)?n[äa]gel\w*`)],
  [4, wordRegex(String.raw`\bonychomykose\w*|\bhühneraug\w*|\bfußgesundheit\b|\bpodiat\w*`)],
  [3, wordRegex(String.raw`\bheilmittelerbring\w*|\bnagelpilz\w*|\bclavus\b|\bclavi\b|\bhallux\b`)],
  // unterstützend (allein nicht ausreichend)
  [2, wordRegex(String.raw`\bheilmittel\w*`)],
  [2, wordRegex(String.raw`\bfußnag\w*|\bzehennag\w*|\bfußsohle\w*|\bfußdeformit\w*|\bspreizfuß\w*|\bplantar\w*`)],
  [1, wordRegex(String.raw`\bfuß\b|\bfüße[n]?\b|\bfüßen\b`)],
  [1, wordRegex(String.raw`\borthes\w*|\borthos\w*|\beinlage\w*|\bwundversorgung\b|\bwundmanagement\b|\bamputation\w*`)],
  [1, wordRegex(String.raw`\bdiabet\w*`)],
];
/** Abkürzung DFS nur in Großbuchstaben (sonst z. B. Deutsche Flugsicherung) – zählt nur unterstützend. */
const DFS = wordRegex(String.raw`\bDFS\b`, "");

/** Ausschlüsse gegen typische Fehltreffer. */
const NEGATIVE: [number, RegExp][] = [
  [20, wordRegex(String.raw`\bpodolski\w*`)],
  [6, wordRegex(String.raw`\bflugsicherung\b|\bfluglots\w*|\bluftraum\w*`)],
  [4, wordRegex(String.raw`\bhufpfleg\w*|\bhufschmied\w*|\bpfoten\w*`)],
];

/** Mindestpunktzahl für allgemeine Quellen. */
export const RELEVANCE_THRESHOLD = 4;

export function relevanceScore(text: string): number {
  let score = 0;
  for (const [w, re] of POSITIVE) if (re.test(text)) score += w;
  if (DFS.test(text)) score += 2;
  for (const [w, re] of NEGATIVE) if (re.test(text)) score -= w;
  return score;
}

/**
 * Podologie-spezifische Quellen (Fachverband, Fachzeitschrift) passieren immer – außer bei harten Ausschlüssen.
 * Allgemeine Quellen (Google-News-Suche, G-BA, Ärzteblatt …) müssen die Schwelle erreichen.
 */
export function isRelevantNews(text: string, podiatrySpecific: boolean): boolean {
  const score = relevanceScore(text);
  return podiatrySpecific ? score > -10 : score >= RELEVANCE_THRESHOLD;
}

// ───────────────────────── Normalisierung & Dedupe ─────────────────────────

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|oc|ref|ref_src|wt_mc|wt\.mc_id|at_\w+|pk_\w+|piwik_\w+|mtm_\w+)$/i;

/** Entfernt Tracking-Parameter und Fragment; ungültige URLs bleiben unverändert. */
export function cleanNewsUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
  u.hash = "";
  return u.toString();
}

/** Entfernt den „ - Herausgeber“-Anhang, den Google News an Titel hängt. */
export function stripPublisherSuffix(title: string, publisher?: string | null): string {
  const t = title.trim();
  const suffix = publisher ? ` - ${publisher}` : "";
  return suffix && t.endsWith(suffix) ? t.slice(0, -suffix.length).trim() : t;
}

/** Titel ohne Herausgeber-Anhang, Kleinschreibung, ohne Akzente, nur Buchstaben/Ziffern. */
export function normalizeNewsTitle(title: string, publisher?: string | null): string {
  return stripPublisherSuffix(title, publisher)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Entfernt Dubletten (gleicher bereinigter Link oder gleicher normalisierter Titel); das erste Vorkommen gewinnt. */
export function dedupeNews<T extends { url: string; title: string; publisher?: string | null }>(items: T[]): T[] {
  const urls = new Set<string>();
  const titles = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const url = cleanNewsUrl(it.url);
    const title = normalizeNewsTitle(it.title, it.publisher);
    if (urls.has(url) || (title && titles.has(title))) continue;
    urls.add(url);
    if (title) titles.add(title);
    out.push(it);
  }
  return out;
}

/** Kurzer Anrisstext (keine Volltextübernahme): max. `max` Zeichen an Wortgrenze; leer, wenn er nur den Titel wiederholt. */
export function newsSnippet(text: string, title: string, max = 280): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  const nt = normalizeNewsTitle(title);
  const nx = normalizeNewsTitle(t);
  if (nx === nt || (nt && nx.startsWith(nt) && nx.length - nt.length < 60)) return "";
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–-]+$/, "")} …`;
}
