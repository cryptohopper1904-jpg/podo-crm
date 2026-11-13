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
/** „Meinten Sie“ nur bei weniger direkten Treffern als hier (1 = nur ohne direkten Treffer; Rechenzeit, Appsec-Review) */
export const FUZZY_BELOW_HITS = 1;
/** Höchstens so viele „Meinten Sie“-Vorschläge */
export const FUZZY_LIMIT = 5;
/** Mindest-Ähnlichkeit (0–1) für „Meinten Sie“ */
export const FUZZY_MIN_SCORE = 0.45;
/** Längster Suchtext (wie die Suchmaske der Liste sinnvoll begrenzt) */
export const SUGGEST_MAX_CHARS = 80;

/** Kleinbuchstaben, Umlaute/Akzente entfernt (ä→a, é→e), ß→ss, Leerraum zusammengefasst */
const ASCII = /^[\x20-\x7e]*$/;
export function normalizeName(s: string): string {
  // schneller Weg für reines ASCII (häufigster Fall): keine Unicode-Zerlegung nötig
  if (ASCII.test(s)) return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

/** Höchstens so viele Kandidaten bewertet closestNames (Rest wird ignoriert; Rechenzeit, Appsec-Review) */
export const FUZZY_MAX_CANDIDATES = 2_000;

/** Für „Meinten Sie“ werden Suchtext und Namen auf so viele Zeichen gekürzt (Rechenzeit begrenzt) */
export const FUZZY_MAX_CHARS = 40;

const clip = (norm: string) => norm.slice(0, FUZZY_MAX_CHARS).trim();

/** Trigramme eines bereits normalisierten Texts (wie pg_trgm: je Wort „  wort “) */
function gramsOf(norm: string): Set<string> {
  const out = new Set<string>();
  for (const w of norm.split(" ")) {
    if (!w) continue;
    const p = `  ${w} `;
    for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  }
  return out;
}

export function trigrams(s: string): Set<string> {
  return gramsOf(normalizeName(s));
}

function gramSim(ta: Set<string>, tb: Set<string>): number {
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export function trigramSimilarity(a: string, b: string): number {
  return gramSim(trigrams(a), trigrams(b));
}

/**
 * Damerau-Levenshtein (optimal string alignment) auf normalisierten Texten, mit drei rollierenden Zeilen
 * statt Matrix. Mit `max`: Abbruch, sobald eine ganze Zeile `max` übersteigt → Rückgabe max + 1.
 */
function boundedDistance(s: string, t: string, max = Infinity): number {
  if (s === t) return 0;
  if (Math.abs(s.length - t.length) > max) return max + 1;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const n = t.length;
  if (rowBuf.length < 3 * (n + 1)) rowBuf = new Int32Array(3 * (n + 1) * 2);
  // drei rollierende Zeilen in einem wiederverwendeten Puffer (keine Matrix, keine Allokation je Vergleich)
  let p2 = 0;
  let p1 = n + 1;
  let cu = 2 * (n + 1);
  const r = rowBuf;
  for (let j = 0; j <= n; j++) r[p1 + j] = j;
  for (let i = 1; i <= s.length; i++) {
    r[cu] = i;
    let rowMin = i;
    const si = s.charCodeAt(i - 1);
    const sPrev = i > 1 ? s.charCodeAt(i - 2) : -1;
    for (let j = 1; j <= n; j++) {
      const tj = t.charCodeAt(j - 1);
      const cost = si === tj ? 0 : 1;
      let v = r[p1 + j] + 1;
      const ins = r[cu + j - 1] + 1;
      if (ins < v) v = ins;
      const sub = r[p1 + j - 1] + cost;
      if (sub < v) v = sub;
      if (j > 1 && si === t.charCodeAt(j - 2) && sPrev === tj) {
        const tr = r[p2 + j - 2] + 1;
        if (tr < v) v = tr;
      }
      r[cu + j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const tmp = p2;
    p2 = p1;
    p1 = cu;
    cu = tmp;
  }
  return r[p1 + n];
}
let rowBuf = new Int32Array(3 * 64);

export function editDistance(a: string, b: string): number {
  return boundedDistance(normalizeName(a), normalizeName(b));
}

/** 1 = gleich, 0 = nichts gemeinsam (Distanz relativ zur längeren Zeichenkette) */
export function editSimilarity(a: string, b: string): number {
  const s = normalizeName(a);
  const t = normalizeName(b);
  const len = Math.max(s.length, t.length);
  if (!len) return 0;
  return 1 - boundedDistance(s, t) / len;
}

/** Ähnlichkeit zweier Texte (0–1) */
export function similarity(a: string, b: string): number {
  return Math.max(trigramSimilarity(a, b), editSimilarity(a, b));
}

/** Zeichen-Histogramm (Buchstaben/Ziffern auf 128 Fächer; Kollisionen schwächen nur die Schranke) */
function histogram(s: string): Int16Array {
  const h = new Int16Array(128);
  for (let i = 0; i < s.length; i++) h[s.charCodeAt(i) & 127]++;
  return h;
}

/** Untere Schranke der Editierdistanz: jede Operation ändert die Histogramm-Differenz (L1) um höchstens 2 */
const histScratch = new Int16Array(128);
function histogramBound(hq: Int16Array, t: string): number {
  histScratch.set(hq);
  for (let i = 0; i < t.length; i++) histScratch[t.charCodeAt(i) & 127]--;
  let l1 = 0;
  for (let i = 0; i < 128; i++) l1 += Math.abs(histScratch[i]);
  return Math.ceil(l1 / 2);
}

/** Suchtext einmal vorbereiten (normalisiert, gekürzt, Trigramme, Histogramm) */
export type PreparedQuery = { norm: string; codes: Float64Array; hist: Int16Array; multiWord: boolean };
export function prepareQuery(q: string): PreparedQuery {
  const norm = clip(normalizeName(q));
  return { norm, codes: gramCodes(norm), hist: histogram(norm), multiWord: norm.includes(" ") };
}

function binaryHas(a: Float64Array, x: number): boolean {
  let lo = 0, hi = a.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (a[m] === x) return true;
    if (a[m] < x) lo = m + 1; else hi = m - 1;
  }
  return false;
}

/**
 * Editier-Ähnlichkeit zu einem normalisierten Text, nur wenn sie `need` übertreffen kann (sonst 0):
 * Längen- und Histogramm-Schranke vorab, dann Damerau-Levenshtein mit frühem Abbruch.
 */
function editScore(pq: PreparedQuery, t: string, need: number): number {
  if (!t) return 0;
  const len = Math.max(pq.norm.length, t.length);
  // Distanz d ergibt 1 - d/len; nur interessant, wenn > need → d < (1 - need) * len
  const max = Math.ceil((1 - need) * len) - 1;
  if (max < 0 || Math.abs(pq.norm.length - t.length) > max) return 0;
  if (histogramBound(pq.hist, t) > max) return 0;
  const d = boundedDistance(pq.norm, t, max);
  return d > max ? 0 : 1 - d / len;
}

export type NameCandidate = { id: string; lastName: string; firstName: string | null };

/**
 * Trigramme als Zahlen (3 × 16 Bit → eine Zahl < 2^48), sortiert und ohne Dubletten – deutlich schneller als
 * Mengen von Teilzeichenketten. Für die Bewertung vieler Kandidaten.
 */
function gramCodes(norm: string): Float64Array {
  const buf = new Float64Array(norm.length + 2);
  let n = 0;
  let c0 = 32;
  let c1 = 32;
  let inWord = false;
  for (let i = 0; i <= norm.length; i++) {
    const c = i < norm.length ? norm.charCodeAt(i) : 32;
    if (c === 32) {
      if (inWord) buf[n++] = c0 * 4294967296 + c1 * 65536 + 32; // Wortende „xy “
      inWord = false;
      c0 = 32;
      c1 = 32;
      continue;
    }
    inWord = true;
    buf[n++] = c0 * 4294967296 + c1 * 65536 + c;
    c0 = c1;
    c1 = c;
  }
  const out = buf.subarray(0, n).sort();
  let w = 0;
  for (let r = 0; r < n; r++) if (r === 0 || out[r] !== out[r - 1]) out[w++] = out[r];
  return out.subarray(0, w);
}

const NO_CODES = new Float64Array(0);

/** Anzahl gemeinsamer Elemente zweier sortierter Listen ohne Dubletten */
function sharedCount(a: Float64Array, b: Float64Array): number {
  let i = 0, j = 0, n = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { n++; i++; j++; } else if (a[i] < b[j]) i++; else j++;
  }
  return n;
}

/**
 * Bester Wert über Nachname, Vorname und beide vollen Namen; 0, wenn `min` nicht erreicht wird.
 * Trigramme sind wortweise – „Vorname Nachname“ und „Nachname Vorname“ haben dieselbe Menge (Vereinigung).
 * Levenshtein: einteiliger Suchtext gegen Nach-/Vorname, mehrteiliger gegen beide vollen Namen.
 */
function candidateScore(pq: PreparedQuery, c: Pick<NameCandidate, "lastName" | "firstName">, min: number): number {
  if (!pq.norm) return 0;
  const last = clip(normalizeName(c.lastName));
  const first = c.firstName ? clip(normalizeName(c.firstName)) : "";
  const gl = gramCodes(last);
  const gf = first ? gramCodes(first) : NO_CODES;
  const sl = sharedCount(pq.codes, gl);
  const sf = sharedCount(pq.codes, gf);
  const inter = sharedCount(gl, gf);
  // Vereinigung L ∪ F: gemeinsame mit Suchtext = sl + sf − (Suchtext ∩ L ∩ F)
  const triple = inter ? sharedCount(pq.codes, gl.filter((g) => binaryHas(gf, g))) : 0;
  const su = sl + sf - triple;
  const nq = pq.codes.length;
  const jac = (shared: number, size: number) => (nq && size ? shared / (nq + size - shared) : 0);
  let best = Math.max(jac(sl, gl.length), jac(sf, gf.length), jac(su, gl.length + gf.length - inter));
  const variants = pq.multiWord ? (first ? [`${first} ${last}`, `${last} ${first}`] : [last]) : first ? [last, first] : [last];
  for (const v of variants) best = Math.max(best, editScore(pq, clip(v), Math.max(min, best)));
  return best >= min ? best : 0;
}

/** Ähnlichkeit eines Suchtexts zu einer Person: bester Wert über Nachname, Vorname und beide vollen Namen */
export function nameScore(query: string, c: Pick<NameCandidate, "lastName" | "firstName">): number {
  return candidateScore(prepareQuery(query), c, 0);
}

/** Ein Suchtext, der „Meinten Sie“ sinnvoll macht: mindestens 3 Zeichen und nicht nur Ziffern/Datum */
export function fuzzyEligible(q: string): boolean {
  const n = normalizeName(q);
  return n.replace(/\s/g, "").length >= 3 && /\p{L}/u.test(n);
}

/**
 * Ähnlichste Personen zu einem Suchtext (absteigend nach Ähnlichkeit, dann Name).
 * `exclude` = direkte Treffer, die schon angezeigt werden. Suchtext und Namen werden auf FUZZY_MAX_CHARS gekürzt.
 */
export function closestNames<T extends NameCandidate>(
  query: string,
  candidates: readonly T[],
  opts: { limit?: number; minScore?: number; exclude?: ReadonlySet<string> } = {},
): (T & { score: number })[] {
  const limit = opts.limit ?? FUZZY_LIMIT;
  const min = opts.minScore ?? FUZZY_MIN_SCORE;
  const pq = prepareQuery(query);
  if (!pq.norm) return [];
  const scored: (T & { score: number })[] = [];
  // harte Obergrenze der Rechenarbeit, egal was der Aufrufer übergibt (Vorfilter liefert ≤ 200 bzw. ≤ 2000)
  for (const c of candidates.length > FUZZY_MAX_CANDIDATES ? candidates.slice(0, FUZZY_MAX_CANDIDATES) : candidates) {
    if (opts.exclude?.has(c.id)) continue;
    const score = candidateScore(pq, c, min);
    if (score >= min && score > 0) scored.push({ ...c, score });
  }
  scored.sort((a, b) => b.score - a.score || a.lastName.localeCompare(b.lastName, "de") || (a.firstName ?? "").localeCompare(b.firstName ?? "", "de") || a.id.localeCompare(b.id));
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
