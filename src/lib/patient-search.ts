/**
 * Live-Patientensuche (Kopfzeile): reine Hilfsfunktionen ohne DB – Normalisierung, Suchwörter und die
 * fehlertolerante Ähnlichkeit für „Meinten Sie: …“.
 *
 * Ähnlichkeit = Maximum aus Trigramm-Ähnlichkeit (wie pg_trgm: Wörter mit Leerzeichen-Rand, Jaccard der
 * Trigramm-Mengen) und einer Levenshtein-Ähnlichkeit (Damerau: Vertauschung zweier Nachbarbuchstaben zählt 1).
 * Trigramme fangen ausgelassene/zusätzliche Silben, Levenshtein kurze Tippfehler („Mustre“ → „Muster“).
 * Verglichen wird jeweils mit Nachname, Vorname und den vollen Namen in beiden Reihenfolgen.
 */

/** Ab so vielen Zeichen werden Vorschläge geladen */
export const SUGGEST_MIN_CHARS = 2;
/** Höchstens so viele direkte Treffer im Vorschlagsfeld */
export const SUGGEST_LIMIT = 8;
/** „Meinten Sie“ nur bei weniger direkten Treffern als hier */
export const FUZZY_BELOW_HITS = 3;
/** Höchstens so viele „Meinten Sie“-Vorschläge */
export const FUZZY_LIMIT = 5;
/** Mindest-Ähnlichkeit (0–1) für „Meinten Sie“ */
export const FUZZY_MIN_SCORE = 0.45;
/** Längster Suchtext (wie die Suchmaske der Liste sinnvoll begrenzt) */
export const SUGGEST_MAX_CHARS = 80;

/** Kleinbuchstaben, Umlaute/Akzente entfernt (ä→a, é→e), ß→ss, Leerraum zusammengefasst */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Suchtext prüfen und kürzen; null = zu kurz/ungültig */
export function cleanQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const q = raw.replace(/\s+/g, " ").trim();
  if (q.length < SUGGEST_MIN_CHARS || q.length > SUGGEST_MAX_CHARS) return null;
  return q;
}

/** Suchwörter (Komma/Leerzeichen getrennt, „Muster, Erika“ = „Erika Muster“), höchstens 4 */
export function queryTokens(q: string): string[] {
  return q
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 4);
}

/** Trigramme wie pg_trgm: je Wort „  wort “ → Menge der 3er-Folgen */
export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalizeName(s).split(" ")) {
    if (!w) continue;
    const p = `  ${w} `;
    for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  }
  return out;
}

export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/** Damerau-Levenshtein (optimal string alignment) auf normalisierten Texten */
export function editDistance(a: string, b: string): number {
  const s = normalizeName(a);
  const t = normalizeName(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const rows = s.length + 1;
  const cols = t.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => {
    const r = new Array<number>(cols).fill(0);
    r[0] = i;
    return r;
  });
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
      d[i][j] = v;
    }
  }
  return d[rows - 1][cols - 1];
}

/** 1 = gleich, 0 = nichts gemeinsam (Distanz relativ zur längeren Zeichenkette) */
export function editSimilarity(a: string, b: string): number {
  const la = normalizeName(a).length;
  const lb = normalizeName(b).length;
  const len = Math.max(la, lb);
  if (!len) return 0;
  return 1 - editDistance(a, b) / len;
}

/** Ähnlichkeit zweier Texte (0–1) */
export function similarity(a: string, b: string): number {
  return Math.max(trigramSimilarity(a, b), editSimilarity(a, b));
}

export type NameCandidate = { id: string; lastName: string; firstName: string | null };

/** Ähnlichkeit eines Suchtexts zu einer Person: bester Wert über Nachname, Vorname und beide vollen Namen */
export function nameScore(query: string, c: Pick<NameCandidate, "lastName" | "firstName">): number {
  const variants = [c.lastName];
  if (c.firstName) variants.push(c.firstName, `${c.firstName} ${c.lastName}`, `${c.lastName} ${c.firstName}`);
  let best = 0;
  for (const v of variants) best = Math.max(best, similarity(query, v));
  return best;
}

/** Ein Suchtext, der „Meinten Sie“ sinnvoll macht: mindestens 3 Zeichen und nicht nur Ziffern/Datum */
export function fuzzyEligible(q: string): boolean {
  const n = normalizeName(q);
  return n.replace(/\s/g, "").length >= 3 && /\p{L}/u.test(n);
}

/**
 * Ähnlichste Personen zu einem Suchtext (absteigend nach Ähnlichkeit, dann Name).
 * `exclude` = direkte Treffer, die schon angezeigt werden.
 */
export function closestNames<T extends NameCandidate>(
  query: string,
  candidates: readonly T[],
  opts: { limit?: number; minScore?: number; exclude?: ReadonlySet<string> } = {},
): (T & { score: number })[] {
  const limit = opts.limit ?? FUZZY_LIMIT;
  const min = opts.minScore ?? FUZZY_MIN_SCORE;
  const scored: (T & { score: number })[] = [];
  for (const c of candidates) {
    if (opts.exclude?.has(c.id)) continue;
    const score = nameScore(query, c);
    if (score >= min) scored.push({ ...c, score });
  }
  scored.sort((a, b) => b.score - a.score || a.lastName.localeCompare(b.lastName, "de") || (a.firstName ?? "").localeCompare(b.firstName ?? "", "de"));
  return scored.slice(0, limit);
}

/** Text für „Meinten Sie: …“ – der Namensteil, der dem Suchtext am nächsten kommt */
export function suggestedQuery(query: string, c: Pick<NameCandidate, "lastName" | "firstName">): string {
  const tokens = queryTokens(query);
  if (tokens.length >= 2 && c.firstName) {
    const a = `${c.firstName} ${c.lastName}`;
    const b = `${c.lastName} ${c.firstName}`;
    return similarity(query, a) >= similarity(query, b) ? a : b;
  }
  if (c.firstName && similarity(query, c.firstName) > similarity(query, c.lastName)) return c.firstName;
  return c.lastName;
}
