/**
 * Lineare HTML-Hilfen für die Praxissuche (fremde Webseiten = nicht vertrauenswürdige Eingabe).
 * Bewusst OHNE rückverfolgende reguläre Ausdrücke über die ganze Seite (ReDoS): nur indexOf-Schleifen,
 * jede Stelle wird höchstens einmal gelesen; fehlt ein Endmarker, wird der Rest abgeschnitten (nie neu gesucht).
 */

/** Nur ASCII-Großbuchstaben klein (Länge bleibt gleich → Indizes passen zum Original). */
const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

const isTagNameEnd = (c: string | undefined) => c === undefined || c === ">" || c === "/" || c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/** Entfernt Tags, Kommentare, <script>/<style>-Inhalte; ersetzt sie durch Leerzeichen. O(n). */
export function stripHtml(html: string): string {
  const lower = asciiLower(html);
  const out: string[] = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt), " ");
    if (lower.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    const raw = lower.startsWith("<script", lt) && isTagNameEnd(lower[lt + 7]) ? "script" : lower.startsWith("<style", lt) && isTagNameEnd(lower[lt + 6]) ? "style" : null;
    if (raw) {
      const close = lower.indexOf(`</${raw}`, lt + raw.length + 1);
      if (close < 0) break;
      const gt = html.indexOf(">", close);
      if (gt < 0) break;
      i = gt + 1;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) break;
    i = gt + 1;
  }
  return out.join("");
}

const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const MAX_TAG = 2048;
const TEXT_WINDOW = 2000;
const MAX_ANCHORS = 2000;

/** Alle <a href>-Links mit ihrem Text (je Tag/Text begrenzt, höchstens 2000 Links). Linear in der Seitenlänge. */
export function anchors(html: string): { href: string; text: string }[] {
  const lower = asciiLower(html);
  const out: { href: string; text: string }[] = [];
  let i = 0;
  while (out.length < MAX_ANCHORS) {
    const at = lower.indexOf("<a", i);
    if (at < 0) break;
    const c = lower[at + 2];
    if (!(c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f")) {
      i = at + 2;
      continue;
    }
    const gt = html.indexOf(">", at);
    if (gt < 0) break;
    const tag = html.slice(at, Math.min(gt, at + MAX_TAG));
    const m = HREF_RE.exec(tag);
    const win = html.slice(gt + 1, gt + 1 + TEXT_WINDOW);
    const close = lower.slice(gt + 1, gt + 1 + TEXT_WINDOW).indexOf("</a");
    const text = stripHtml(close >= 0 ? win.slice(0, close) : win.slice(0, 300));
    if (m) out.push({ href: (m[1] ?? m[2] ?? m[3] ?? "").trim(), text });
    i = gt + 1;
  }
  return out;
}

/**
 * Platzhalter-Vergleich für robots.txt (`*` = beliebig, `$` am Ende = Pfadende), ohne RegExp: gierig mit
 * Rücksprungmarke, O(Pfadlänge · Musterlänge). Regeln über 512 Zeichen oder mit mehr als 16 `*` werden ignoriert.
 * Mit `budget` werden alle Schritte gezählt; ist es aufgebraucht, kommt null zurück.
 */
export function wildcardMatch(pattern: string, path: string, budget?: { steps: number }): boolean | null {
  if (!pattern || pattern.length > 512) return false;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  let stars = 0;
  for (const ch of body) if (ch === "*") stars++;
  if (stars > 16) return false;
  // ohne „$“ ist es ein Präfix-Vergleich = Muster mit angehängtem „*“
  const p = anchored ? body : `${body}*`;
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (i < path.length) {
    // gemeinsames Schrittbudget (viele Regeln × langer Pfad): erschöpft → null (Aufrufer wertet als „verboten“)
    if (budget && --budget.steps < 0) return null;
    if (j < p.length && p[j] !== "*" && p[j] === path[i]) {
      i++;
      j++;
    } else if (j < p.length && p[j] === "*") {
      star = j++;
      mark = i;
    } else if (star >= 0) {
      j = star + 1;
      i = ++mark;
    } else {
      return false;
    }
  }
  while (j < p.length && p[j] === "*") j++;
  return j === p.length;
}
