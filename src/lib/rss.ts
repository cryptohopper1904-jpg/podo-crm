/**
 * Winziger RSS-2.0-/Atom-Parser ohne Abhängigkeiten (regex-basiert, für Nachrichtenfeeds ausreichend).
 * Liefert nur Text – HTML wird entfernt, Entities werden dekodiert.
 */
export interface FeedItem {
  title: string;
  url: string;
  publishedAt: string | null;
  text: string;
  /** Herausgeber bei Aggregatoren (RSS <source>, z. B. Google News). */
  publisher?: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

function unwrap(s: string): string {
  const cdata = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : decodeEntities(s);
}

export function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? unwrap(m[1]).trim() : null;
}

function toIso(s: string | null): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const rss = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const block of rss) {
    const url = tag(block, "link") ?? tag(block, "guid");
    const title = tag(block, "title");
    if (!url || !title) continue;
    const publisher = tag(block, "source");
    items.push({
      title: stripHtml(title),
      url: url.trim(),
      publishedAt: toIso(tag(block, "pubDate") ?? tag(block, "dc:date")),
      // Anrisstext bevorzugt (keine Volltextübernahme); content:encoded nur als Rückfall.
      text: stripHtml(tag(block, "description") || tag(block, "content:encoded") || ""),
      ...(publisher ? { publisher: stripHtml(publisher) } : {}),
    });
  }
  if (items.length) return items;
  const atom = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const block of atom) {
    const href = block.match(/<link[^>]*?href="([^"]+)"[^>]*?(?:rel="alternate")?[^>]*\/?>/i)?.[1];
    const title = tag(block, "title");
    if (!href || !title) continue;
    items.push({
      title: stripHtml(title),
      url: decodeEntities(href),
      publishedAt: toIso(tag(block, "updated") ?? tag(block, "published")),
      text: stripHtml(tag(block, "summary") ?? tag(block, "content") ?? ""),
    });
  }
  return items;
}
