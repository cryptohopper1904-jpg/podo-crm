/**
 * Adress-Vorschläge (Patientenanlage, Praxisdaten, Pflegeheime) über Photon.
 *  - ADDRESS_PROVIDER=photon (Standard) | off
 *  - PHOTON_URL: eigene Photon-Instanz (Standard: öffentliche Instanz von Komoot, https://photon.komoot.io)
 * Es verlässt nur der eingetippte Adresstext den Server – keine Namen/IDs, keine Client-IP.
 * Ziel wird per net-guard geprüft (https, öffentliche Adresse, keine Weiterleitungen), Zeitlimit 3 s.
 * Gleiche Anfragen werden 10 min im Prozessspeicher gehalten.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { guardedFetch } from "@/integrations/net-guard";
import {
  buildPhotonUrl,
  citiesForZip,
  expandAbbreviations,
  firstCoordinate,
  normalizePhoton,
  PHOTON_DEFAULT_URL,
  USER_AGENT,
  type AddressSuggestion,
} from "@/lib/address/photon";
import { log } from "@/lib/log";
import { createRateLimiter } from "@/lib/rate-limit";

export const TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 1_000;
/** Fehlgeschlagene Geokodierung der Praxis erst nach einem Tag erneut versuchen */
const GEO_RETRY_MS = 24 * 3600_000;

/** 60 Anfragen je Benutzer:in und Minute (Tippen mit 250 ms Entprellung bleibt deutlich darunter). */
export const addressLimiter = createRateLimiter({ windowMs: 60_000, max: 60, maxKeys: 5_000 });

export type AddressProvider = "photon" | "off";

export function addressProvider(env: Record<string, string | undefined> = process.env): AddressProvider {
  return (env.ADDRESS_PROVIDER ?? "photon").trim().toLowerCase() === "off" ? "off" : "photon";
}

export function photonBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.PHOTON_URL?.trim() || PHOTON_DEFAULT_URL;
}

// ───────── Cache (LRU nach Einfügereihenfolge, TTL) ─────────
const cache = new Map<string, { at: number; value: unknown }>();

function cacheGet<T>(key: string, now: number): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (now - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}
function cacheSet(key: string, value: unknown, now: number) {
  cache.delete(key);
  cache.set(key, { at: now, value });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}
export function clearAddressCache() {
  cache.clear();
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchFn = guardedFetch();
/** nur für Tests */
export function setAddressFetch(f: FetchFn | null) {
  fetchImpl = f ?? guardedFetch();
}

/** Ruft Photon auf; null bei Fehler/Zeitüberschreitung (keine Fehlermeldung an die Oberfläche). */
async function photon(url: string): Promise<unknown | null> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve(null);
    }, TIMEOUT_MS);
  });
  const run = (async () => {
    try {
      // bewusst nur feste Kopfzeilen: kein X-Forwarded-For, keine Cookies, kein Referer
      const res = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: ctrl.signal, cache: "no-store" });
      if (!res.ok) {
        log.warn("address.photon_status", { status: res.status });
        return null;
      }
      return (await res.json()) as unknown;
    } catch (e) {
      if (!ctrl.signal.aborted) log.warn("address.photon_error", { error: e instanceof Error ? e.name : "unknown" });
      return null;
    }
  })();
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type Bias = { lat: number; lon: number };

async function cachedPhoton(kind: string, url: string, now: number): Promise<unknown | null> {
  const key = `${kind}|${url}`;
  const hit = cacheGet<unknown>(key, now);
  if (hit !== undefined) return hit;
  const json = await photon(url);
  if (json !== null) cacheSet(key, json, now);
  return json;
}

export async function suggestAddresses(q: string, bias: Bias | null, now = Date.now()): Promise<AddressSuggestion[]> {
  if (addressProvider() === "off") return [];
  const url = buildPhotonUrl(photonBaseUrl(), { q: expandAbbreviations(q), lat: bias?.lat, lon: bias?.lon });
  const json = await cachedPhoton("q", url, now);
  return json === null ? [] : normalizePhoton(json);
}

export async function citiesByZip(zip: string, now = Date.now()): Promise<string[]> {
  if (addressProvider() === "off") return [];
  const url = buildPhotonUrl(photonBaseUrl(), { q: zip, layers: ["city", "district", "locality", "street"], limit: 15 });
  const json = await cachedPhoton("zip", url, now);
  return json === null ? [] : citiesForZip(json, zip);
}

/** Koordinate zu einem freien Ortstext (z. B. „14467 Potsdam“) – für die Ortsgewichtung. */
export async function geocodePlace(text: string, now = Date.now()): Promise<Bias | null> {
  const url = buildPhotonUrl(photonBaseUrl(), { q: text, layers: ["house", "street", "city", "district", "locality"], limit: 1 });
  const json = await cachedPhoton("geo", url, now);
  return json === null ? null : firstCoordinate(json);
}

type GeoSetting = { key: string; lat?: number; lon?: number; failedAt?: number };

/**
 * Ortsgewichtung über die Praxisadresse: einmal geokodiert und in organizations.settings.geo gespeichert
 * (Schlüssel = Adresse, ändert sich die Adresse, wird neu bestimmt). Fallback: `near` (PLZ/Ort) aus der Anfrage.
 */
export async function practiceBias(orgId: string, near: string | null, now = Date.now()): Promise<Bias | null> {
  if (addressProvider() === "off") return null;
  try {
    const [o] = await db
      .select({ street: organizations.street, zip: organizations.zip, city: organizations.city, settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    const place = [o?.zip, o?.city].map((x) => x?.trim()).filter(Boolean).join(" ");
    if (o && place) {
      const text = [o.street?.trim(), place].filter(Boolean).join(", ");
      const key = text.toLowerCase();
      const geo = (o.settings as { geo?: GeoSetting }).geo;
      if (geo?.key === key && typeof geo.lat === "number" && typeof geo.lon === "number") return { lat: geo.lat, lon: geo.lon };
      if (geo?.key === key && geo.failedAt && now - geo.failedAt < GEO_RETRY_MS) return near ? geocodePlace(near, now) : null;
      const found = (await geocodePlace(text, now)) ?? (await geocodePlace(place, now));
      const next: GeoSetting = found ? { key, lat: found.lat, lon: found.lon } : { key, failedAt: now };
      await db
        .update(organizations)
        .set({ settings: sql`${organizations.settings} || ${JSON.stringify({ geo: next })}::jsonb` })
        .where(eq(organizations.id, orgId));
      if (found) return found;
    }
  } catch (e) {
    log.warn("address.practice_geo_failed", { error: e instanceof Error ? e.name : "unknown" });
  }
  return near ? geocodePlace(near, now) : null;
}
