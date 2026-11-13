/**
 * Adress-Vorschläge über Photon (OSM-Geocoder, https://github.com/komoot/photon) – reine Funktionen,
 * ohne Netz: Anfrage prüfen, Photon-URL bauen, GeoJSON-Antwort normalisieren.
 *
 * Datenschutz: An Photon geht ausschließlich der eingegebene Adresstext (bzw. die PLZ) – nie Namen,
 * IDs oder andere Daten der Patient:innen.
 */

export type AddressSuggestion = {
  street: string;
  houseNumber?: string;
  zip: string;
  city: string;
  district?: string;
  label: string;
};

export const QUERY_MIN = 3;
export const QUERY_MAX = 120;
/** Deutschland (minLon, minLat, maxLon, maxLat) */
export const GERMANY_BBOX = "5.87,47.27,15.04,55.06";
export const PHOTON_DEFAULT_URL = "https://photon.komoot.io";
export const USER_AGENT = "PodoHero/1.0 (+https://podo.algoverdict.com)";
const LIMIT = 6;

/** Prüft und vereinheitlicht die Eingabe; null = nicht zulässig (zu kurz/lang, nur Sonderzeichen). */
export function validateQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const q = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (q.length < QUERY_MIN || q.length > QUERY_MAX) return null;
  if (!/[\p{L}\p{N}]/u.test(q)) return null;
  return q;
}

/** Fünfstellige deutsche PLZ, sonst null. */
export function validateZip(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const z = raw.trim();
  return /^\d{5}$/.test(z) ? z : null;
}

/** „Hauptstr. 5“ → „Hauptstraße 5“ (Photon kennt die Abkürzung nicht zuverlässig). */
export function expandAbbreviations(q: string): string {
  return q.replace(/(^|[\s\-\p{L}])(s)tr\.?(?=[\s,\d]|$)/giu, (_m, pre: string, s: string) => `${pre}${s}traße`);
}

/** Vom Nutzer eingetippte Hausnummer („Friedrich-Herder-Str. 12a“ → „12a“); PLZ (5 Ziffern) zählen nicht. */
export function typedHouseNumber(q: string): string | undefined {
  const m = q.match(/(?:^|[\s.])(\d{1,4}(?:\s?[a-zA-Z])?(?:\s?[-/]\s?\d{1,4}(?:\s?[a-zA-Z])?)?)(?=\s|,|$)/);
  return m ? m[1].replace(/\s+/g, "") : undefined;
}

export type PhotonParams = { q: string; lat?: number; lon?: number; layers?: string[]; limit?: number };

export function buildPhotonUrl(baseUrl: string, p: PhotonParams): string {
  const u = new URL("/api/", baseUrl.replace(/\/+$/, "") + "/");
  u.searchParams.set("q", p.q);
  u.searchParams.set("lang", "de");
  u.searchParams.set("limit", String(p.limit ?? LIMIT));
  u.searchParams.set("bbox", GERMANY_BBOX);
  for (const l of p.layers ?? ["house", "street"]) u.searchParams.append("layer", l);
  if (p.lat !== undefined && p.lon !== undefined && Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
    u.searchParams.set("lat", p.lat.toFixed(4));
    u.searchParams.set("lon", p.lon.toFixed(4));
    u.searchParams.set("zoom", "12");
  }
  return u.toString();
}

type PhotonProps = Record<string, unknown>;
type PhotonFeature = { geometry?: { coordinates?: unknown }; properties?: PhotonProps };

const str = (v: unknown, max = 100): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : undefined;
};

function features(json: unknown): PhotonFeature[] {
  const f = (json as { features?: unknown } | null)?.features;
  return Array.isArray(f) ? (f.filter((x) => x && typeof x === "object") as PhotonFeature[]) : [];
}

/** „14467;14469“ → „14467“ */
const zipOf = (v: unknown) => str(v)?.match(/\b\d{5}\b/)?.[0];
const isGerman = (p: PhotonProps) => {
  const cc = str(p.countrycode);
  return !cc || cc.toUpperCase() === "DE";
};
const cityOf = (p: PhotonProps) => str(p.city) ?? str(p.town) ?? str(p.village) ?? str(p.locality) ?? str(p.county);

/** Photon-GeoJSON → einheitliche, deduplizierte Vorschläge (nur DE, nur mit Straße und PLZ/Ort). */
export function normalizePhoton(json: unknown): AddressSuggestion[] {
  const out: AddressSuggestion[] = [];
  const seen = new Set<string>();
  for (const f of features(json)) {
    const p = f.properties ?? {};
    if (!isGerman(p)) continue;
    const type = str(p.type);
    const isStreet = type === "street" || (str(p.osm_key) === "highway" && !str(p.housenumber));
    const street = isStreet ? (str(p.name) ?? str(p.street)) : str(p.street);
    if (!street) continue;
    const houseNumber = isStreet ? undefined : str(p.housenumber, 20);
    const zip = zipOf(p.postcode) ?? "";
    const city = cityOf(p) ?? "";
    if (!zip && !city) continue;
    const districtRaw = str(p.district) ?? (str(p.locality) !== city ? str(p.locality) : undefined);
    const district = districtRaw && districtRaw !== city ? districtRaw : undefined;
    const label = `${street}${houseNumber ? ` ${houseNumber}` : ""}, ${[zip, city].filter(Boolean).join(" ")}`;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ street, ...(houseNumber ? { houseNumber } : {}), zip, city, ...(district ? { district } : {}), label });
  }
  return out;
}

/** Alle Orte zur PLZ (eindeutig, in Reihenfolge des Auftretens). */
export function citiesForZip(json: unknown, zip: string): string[] {
  const out: string[] = [];
  for (const f of features(json)) {
    const p = f.properties ?? {};
    if (!isGerman(p)) continue;
    const pc = str(p.postcode);
    if (!pc || !pc.split(/[;,\s]+/).includes(zip)) continue;
    const t = str(p.type);
    const city = cityOf(p) ?? (t === "city" || t === "district" || t === "locality" ? str(p.name) : undefined);
    if (city && !out.includes(city)) out.push(city);
  }
  return out;
}

/** Erste Koordinate (lat/lon) aus einer Photon-Antwort, z. B. für die Praxisadresse. */
export function firstCoordinate(json: unknown): { lat: number; lon: number } | null {
  for (const f of features(json)) {
    const c = f.geometry?.coordinates;
    if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number" && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
      return { lon: c[0], lat: c[1] };
    }
  }
  return null;
}
