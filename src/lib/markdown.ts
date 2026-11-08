/**
 * Sehr kleiner, sicherer Markdown-Parser für die eigenen Rechtstexte (docs/legal/*.md).
 *
 * - Erzeugt einen Syntaxbaum statt HTML; gerendert wird mit React (src/components/markdown.tsx),
 *   das jeden Text escaped. Rohes HTML im Markdown wird NICHT interpretiert, sondern als Text angezeigt.
 * - Links nur mit erlaubten Zielen (https, http, mailto, tel, relative Pfade "/…" und Anker "#…"),
 *   alles andere (javascript:, data: …) wird zu reinem Text.
 * - Platzhalter wie [FIRMENNAME] oder [ANSCHRIFT] werden als eigener Knoten markiert, damit sie
 *   auf der Website deutlich sichtbar sind.
 *
 * Unterstützt: Überschriften (#–####), Absätze, Listen (-, *, 1.), Zitate (>), Tabellen (|),
 * Trennlinien (---), **fett**, *kursiv*, `Code`, [Link](Ziel).
 */

export type Inline =
  | { type: "text"; value: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; value: string }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "placeholder"; value: string };

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4; id: string; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "quote"; children: Block[] }
  | { type: "table"; head: Inline[][]; rows: Inline[][][] }
  | { type: "hr" };

const SAFE_HREF = /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i;

export function safeHref(href: string): string | null {
  const h = href.trim();
  if (!SAFE_HREF.test(h)) return null;
  // Steuerzeichen/Leerzeichen in URLs nicht zulassen
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\s]/.test(h)) return null;
  return h;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const PLACEHOLDER = /^\[([A-ZÄÖÜ][A-ZÄÖÜ0-9 _\-/.,]*)\](?!\()/;

/** Inline-Elemente parsen (rekursiv für fett/kursiv/Linktext). */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ type: "text", value: buf });
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length && /[\\`*_[\]()#>|-]/.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ type: "code", value: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (rest.startsWith("**")) {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ type: "strong", children: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && src[i + 1] !== ch && src[i + 1] !== " ") {
      const end = src.indexOf(ch, i + 1);
      // "_" nur an Wortgrenzen (z. B. snake_case nicht kursiv setzen)
      const boundaryOk = ch === "*" || ((i === 0 || /\W/.test(src[i - 1])) && (end + 1 >= src.length || /\W/.test(src[end + 1])));
      if (end > i + 1 && src[end - 1] !== " " && boundaryOk) {
        flush();
        out.push({ type: "em", children: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const ph = PLACEHOLDER.exec(rest);
      if (ph) {
        flush();
        out.push({ type: "placeholder", value: `[${ph[1]}]` });
        i += ph[0].length;
        continue;
      }
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
      if (link) {
        flush();
        const href = safeHref(link[2]);
        if (href) out.push({ type: "link", href, children: parseInline(link[1]) });
        else out.push(...parseInline(link[1]));
        i += link[0].length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

const isTableSep = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
const LIST_ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const usedIds = new Map<string, number>();
  let i = 0;

  const uniqueId = (text: string) => {
    const base = slugify(text) || "abschnitt";
    const n = usedIds.get(base) ?? 0;
    usedIds.set(base, n + 1);
    return n ? `${base}-${n + 1}` : base;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length as 1 | 2 | 3 | 4, id: uniqueId(h[2]), children: parseInline(h[2]) });
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) inner.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ type: "quote", children: parseMarkdown(inner.join("\n")) });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]).map(parseInline));
      blocks.push({ type: "table", head, rows });
      continue;
    }
    const li = LIST_ITEM.exec(line);
    if (li) {
      const ordered = !li[1];
      const items: string[] = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (m && !m[1] === ordered) {
          items.push(m[3]);
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          // eingerückte Fortsetzungszeile
          items[items.length - 1] += " " + lines[i].trim();
          i++;
        } else break;
      }
      blocks.push({ type: "list", ordered, items: items.map(parseInline) });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4})\s/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !LIST_ITEM.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "paragraph", children: parseInline(para.join(" ")) });
  }
  return blocks;
}

/** Reiner Text eines Inline-Baums (z. B. für Überschriften im Inhaltsverzeichnis). */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.type === "text" || n.type === "code" || n.type === "placeholder" ? n.value : inlineText(n.children)))
    .join("");
}
