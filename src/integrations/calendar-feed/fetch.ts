/**
 * Abruf einer privaten iCal-Adresse (Kalender-Abo, z. B. Google Kalender „Privatadresse im iCal-Format“).
 * - nur https (webcal:// wird als https:// gelesen), Port 443, keine Zugangsdaten in der URL
 * - SSRF-Schutz über net-guard: jedes Ziel (auch Weiterleitungen, max. 3) muss öffentlich auflösen
 * - Zeitlimit 10 s, höchstens 5 MB, bedingte Abfrage per ETag / If-Modified-Since
 * Fehlermeldungen enthalten NIE die URL (sie ist ein Geheimnis).
 */
import { assertPublicUrl, assertSafeUrlSyntax, UnsafeTargetError, type Resolver } from "../net-guard";

export const ICS_FETCH_TIMEOUT_MS = 10_000;
export const ICS_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export class CalendarFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarFeedError";
  }
}

export type IcsFetchResult =
  | { status: "not_modified" }
  | { status: "ok"; body: string; etag: string | null; lastModified: string | null };

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/** Normalisiert die eingegebene Adresse (webcal → https) und prüft sie formal (ohne DNS). */
export function normalizeFeedUrl(raw: string): string {
  const t = raw.trim().replace(/^webcals?:\/\//i, "https://");
  const u = assertSafeUrlSyntax(t);
  u.hash = "";
  return u.toString();
}

/** Kurzer, nicht geheimer Hinweis zur Anzeige: Host + letzter Pfadteil gekürzt, z. B. „calendar.google.com/…/basic.ics“. */
export function feedUrlHint(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).at(-1) ?? "";
    const tail = last && last.length <= 24 && !/[0-9a-f]{16,}/i.test(last) ? `/…/${last}` : "/…";
    return `${u.hostname}${tail}`;
  } catch {
    return "–";
  }
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > maxBytes) throw new CalendarFeedError("Kalenderdatei ist größer als 5 MB.");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new CalendarFeedError("Kalenderdatei ist größer als 5 MB.");
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

export async function fetchIcs(
  url: string,
  opts: { etag?: string | null; lastModified?: string | null; fetchImpl?: FetchImpl; resolver?: Resolver; timeoutMs?: number; maxBytes?: number } = {},
): Promise<IcsFetchResult> {
  const fetchImpl = opts.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const maxBytes = opts.maxBytes ?? ICS_MAX_BYTES;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? ICS_FETCH_TIMEOUT_MS);
  try {
    let target = normalizeFeedUrl(url);
    for (let hop = 0; ; hop++) {
      await assertPublicUrl(target, opts.resolver);
      const headers: Record<string, string> = { Accept: "text/calendar, text/plain;q=0.8, */*;q=0.1", "User-Agent": "PodoHero-Kalender-Abo/1.0" };
      if (hop === 0 && opts.etag) headers["If-None-Match"] = opts.etag;
      if (hop === 0 && opts.lastModified) headers["If-Modified-Since"] = opts.lastModified;
      let res: Response;
      try {
        res = await fetchImpl(target, { method: "GET", headers, redirect: "manual", signal: ctrl.signal, cache: "no-store" });
      } catch (e) {
        if (ctrl.signal.aborted) throw new CalendarFeedError("Zeitüberschreitung beim Abruf (10 s).");
        throw new CalendarFeedError(`Kalender nicht erreichbar (${e instanceof Error && "code" in e ? String((e as { code?: unknown }).code) : "Netzwerkfehler"}).`);
      }
      if (res.status === 304) return { status: "not_modified" };
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc || hop >= MAX_REDIRECTS) throw new CalendarFeedError("Zu viele oder ungültige Weiterleitungen.");
        target = normalizeFeedUrl(new URL(loc, target).toString());
        continue;
      }
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        throw new CalendarFeedError(`Kalender-Adresse ungültig oder zurückgesetzt (HTTP ${res.status}). Bitte neue Privatadresse hinterlegen.`);
      }
      if (!res.ok) throw new CalendarFeedError(`Kalender antwortet mit HTTP ${res.status}.`);
      const body = await readLimited(res, maxBytes);
      if (!/^﻿?\s*BEGIN:VCALENDAR/i.test(body)) throw new CalendarFeedError("Die Adresse liefert keine iCal-Datei (BEGIN:VCALENDAR fehlt).");
      return { status: "ok", body, etag: res.headers.get("etag")?.slice(0, 300) ?? null, lastModified: res.headers.get("last-modified")?.slice(0, 100) ?? null };
    }
  } catch (e) {
    if (e instanceof CalendarFeedError) throw e;
    if (e instanceof UnsafeTargetError) throw new CalendarFeedError(`Adresse nicht erlaubt: ${e.message}`);
    if (ctrl.signal.aborted) throw new CalendarFeedError("Zeitüberschreitung beim Abruf (10 s).");
    throw new CalendarFeedError("Abruf fehlgeschlagen.");
  } finally {
    clearTimeout(timer);
  }
}
