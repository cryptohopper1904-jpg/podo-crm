/**
 * Praxissuche – Netzzugriffe (Overpass/OpenStreetMap und öffentliche Praxis-Websites).
 *
 * Höflich und sparsam:
 *  - Overpass: genau eine Abfrage je Lauf, Zeitlimit, allgemeiner User-Agent ohne Daten des Betreibers.
 *  - Websites: höchstens Startseite + EINE Impressum-/Kontaktseite derselben Website, vorher robots.txt
 *    (Disallow → überspringen), 1 Anfrage/Sekunde, 10 s Zeitlimit, max. 200 KB je Seite, keine Cookies, kein JS.
 *    403/429/503 oder Bot-Challenge (Cloudflare & Co.) → überspringen, nie umgehen.
 *  - SSRF-Schutz über net-guard: jedes Ziel (auch Weiterleitungen, max. 3) muss https und öffentlich sein.
 */
import { assertPublicUrl, type Resolver } from "../net-guard";
import { extractEmails } from "@/lib/vertrieb/email-filter";
import { findContactLink, LEAD_SEARCH_USER_AGENT, looksLikeChallenge, OVERPASS_MAX_ELEMENTS, OVERPASS_URL, robotsAllows } from "@/lib/vertrieb/lead-search";

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export const PAGE_TIMEOUT_MS = 10_000;
export const PAGE_MAX_BYTES = 200 * 1024;
export const MIN_INTERVAL_MS = 1_000;
const MAX_REDIRECTS = 3;

export class OverpassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverpassError";
  }
}

/** Eine Overpass-Abfrage (POST, Formular-Kodierung). Fehler → OverpassError (Ring wird dann nicht weitergezählt). */
export async function queryOverpass(query: string, opts: { fetchImpl?: FetchImpl; timeoutMs?: number; url?: string } = {}): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 180_000);
  try {
    const res = await fetchImpl(opts.url ?? OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": LEAD_SEARCH_USER_AGENT },
      body: new URLSearchParams({ data: query }).toString(),
      signal: ctrl.signal,
      cache: "no-store",
      redirect: "error",
    });
    if (!res.ok) throw new OverpassError(res.status === 429 || res.status === 504 ? `Overpass ausgelastet (HTTP ${res.status}) – nächster Versuch beim nächsten Lauf.` : `Overpass antwortet mit HTTP ${res.status}.`);
    const json = (await res.json()) as { remark?: string };
    if (typeof json?.remark === "string" && /runtime error|timed out|out of memory/i.test(json.remark)) throw new OverpassError("Overpass-Abfrage abgebrochen (Zeit/Speicher) – nächster Versuch beim nächsten Lauf.");
    if (Array.isArray((json as { elements?: unknown[] }).elements) && (json as { elements: unknown[] }).elements.length >= OVERPASS_MAX_ELEMENTS) {
      throw new OverpassError(`Overpass: ${OVERPASS_MAX_ELEMENTS} oder mehr Treffer (evtl. abgeschnitten) – der Ring wird verkleinert.`);
    }
    return json;
  } catch (e) {
    if (e instanceof OverpassError) throw e;
    throw new OverpassError(ctrl.signal.aborted ? "Overpass: Zeitüberschreitung." : "Overpass nicht erreichbar.");
  } finally {
    clearTimeout(timer);
  }
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.byteLength, maxBytes - total);
    chunks.push(value.subarray(0, take));
    total += take;
    if (total >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

export type Page = { status: number; url: string; body: string; headers: Headers };

/**
 * Abrufer für öffentliche Websites: serialisiert alle Anfragen mit Mindestabstand (1/s), prüft jedes Ziel
 * (net-guard), folgt höchstens 3 Weiterleitungen, liest höchstens 200 KB, sendet keine Cookies.
 */
export class PoliteFetcher {
  private last = -Infinity;
  private readonly robotsCache = new Map<string, string | null>();
  requests = 0;

  constructor(
    private readonly opts: {
      fetchImpl?: FetchImpl;
      resolver?: Resolver;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
      minIntervalMs?: number;
      timeoutMs?: number;
      maxBytes?: number;
    } = {},
  ) {}

  private async throttle() {
    const now = this.opts.now ?? Date.now;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const wait = this.last + (this.opts.minIntervalMs ?? MIN_INTERVAL_MS) - now();
    if (wait > 0) await sleep(wait);
    this.last = now();
  }

  /**
   * GET mit Prüfung jedes Ziels; null bei Netzfehler, unsicherem Ziel oder Zeitüberschreitung.
   * `checkRobots`: führt eine Weiterleitung auf einen anderen Host, gilt auch dessen robots.txt.
   */
  async get(url: string, accept = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1", checkRobots = true): Promise<Page | null> {
    const fetchImpl = this.opts.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        await assertPublicUrl(target, this.opts.resolver);
      } catch {
        return null;
      }
      await this.throttle();
      this.requests++;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? PAGE_TIMEOUT_MS);
      try {
        const res = await fetchImpl(target, {
          method: "GET",
          headers: { Accept: accept, "Accept-Language": "de", "User-Agent": LEAD_SEARCH_USER_AGENT },
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          await res.body?.cancel().catch(() => undefined);
          if (!loc) return null;
          const next = new URL(loc, target);
          if (next.protocol === "http:") next.protocol = "https:";
          const prevHost = new URL(target).host.toLowerCase();
          target = next.toString();
          if (checkRobots && next.host.toLowerCase() !== prevHost && !(await this.allowed(target))) return null;
          continue;
        }
        const ct = res.headers.get("content-type") ?? "";
        const textual = !ct || /text\/|html|xml/i.test(ct);
        const body = textual ? await readLimited(res, this.opts.maxBytes ?? PAGE_MAX_BYTES) : (await res.body?.cancel().catch(() => undefined), "");
        return { status: res.status, url: target, body, headers: res.headers };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  /**
   * Darf der Pfad laut robots.txt abgerufen werden? (RFC 9309: 4xx → keine Regeln; 5xx/nicht erreichbar → nein)
   */
  async allowed(pageUrl: string): Promise<boolean> {
    const u = new URL(pageUrl);
    const key = u.host.toLowerCase();
    if (!this.robotsCache.has(key)) {
      const r = await this.get(`https://${u.host}/robots.txt`, "text/plain,*/*;q=0.1", false);
      this.robotsCache.set(key, !r || r.status >= 500 || r.status === 429 ? null : r.status >= 400 ? "" : r.body);
    }
    const txt = this.robotsCache.get(key);
    if (txt === null || txt === undefined) return false;
    return robotsAllows(txt, u.pathname + u.search);
  }
}

export type WebsiteResult = { emails: string[]; pages: number; skipped?: string };

/**
 * Sucht E-Mail-Adressen auf der Startseite und – falls dort keine passende steht – auf genau einer
 * Impressum-/Kontaktseite derselben Website. `accept` entscheidet, ob eine Adresse genügt (Funktionspostfach).
 */
export async function findWebsiteEmails(website: string, fetcher: PoliteFetcher, accept: (emails: string[]) => boolean): Promise<WebsiteResult> {
  if (!(await fetcher.allowed(website))) return { emails: [], pages: 0, skipped: "robots.txt verbietet den Abruf oder ist nicht erreichbar" };
  const home = await fetcher.get(website);
  if (!home) return { emails: [], pages: 0, skipped: "Website nicht erreichbar" };
  if (looksLikeChallenge(home.status, home.headers, home.body)) return { emails: [], pages: 1, skipped: "Zugriffsschutz (übersprungen)" };
  if (!home.status || home.status >= 400) return { emails: [], pages: 1, skipped: `HTTP ${home.status}` };
  const emails = extractEmails(home.body);
  if (accept(emails)) return { emails, pages: 1 };
  const link = findContactLink(home.body, home.url);
  if (!link || !(await fetcher.allowed(link))) return { emails, pages: 1 };
  const sub = await fetcher.get(link);
  if (!sub || looksLikeChallenge(sub.status, sub.headers, sub.body) || sub.status >= 400) return { emails, pages: 2 };
  return { emails: [...new Set([...emails, ...extractEmails(sub.body)])], pages: 2 };
}
