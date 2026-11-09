/**
 * Geometrie für die Tourenplanung (reine Funktionen, ohne Netz):
 * Luftlinie (Haversine), Schätzung der Straßenstrecke (Luftlinie × 1,3), Rundung von Koordinaten.
 */
export type LatLon = { lat: number; lon: number };

/** Umwegfaktor Straße/Luftlinie für die Schätzung, wenn kein Routing-Dienst verfügbar ist */
export const DETOUR_FACTOR = 1.3;
/** angenommene Durchschnittsgeschwindigkeit für die Schätzung (Stadt/Land gemischt) */
export const ESTIMATE_KMH = 40;

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Luftlinie in Metern */
export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type Leg = { distanceM: number; durationSec: number; estimated: boolean; provider: string };

/** Geschätzte Strecke: Luftlinie × 1,3 (als „geschätzt“ gekennzeichnet). */
export function estimateLeg(a: LatLon, b: LatLon): Leg {
  const distanceM = Math.round(haversineM(a, b) * DETOUR_FACTOR);
  return { distanceM, durationSec: Math.round((distanceM / 1000 / ESTIMATE_KMH) * 3600), estimated: true, provider: "estimate" };
}

/** Rundet auf `digits` Nachkommastellen (3 ≈ 100 m, 4 ≈ 10 m). */
export function roundCoord(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function roundPoint(p: LatLon, digits = 3): LatLon {
  return { lat: roundCoord(p.lat, digits), lon: roundCoord(p.lon, digits) };
}

export function isValidPoint(p: Partial<LatLon> | null | undefined): p is LatLon {
  return !!p && typeof p.lat === "number" && typeof p.lon === "number" && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
}

/** km mit einer Nachkommastelle, deutsch: 12,4 km */
export const kmDe = (m: number) => `${(Math.round(m / 100) / 10).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
export const minDe = (sec: number) => {
  const min = Math.max(0, Math.round(sec / 60));
  return min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min` : `${min} min`;
};

/** Adresse einzeilig (für Geokodierung und Navigations-Links) – leer, wenn keine verwertbare Adresse. */
export function addressLine(a: { street?: string | null; zip?: string | null; city?: string | null }): string {
  const street = a.street?.trim() ?? "";
  const place = [a.zip?.trim(), a.city?.trim()].filter(Boolean).join(" ");
  if (!street && !place) return "";
  return [street, place].filter(Boolean).join(", ");
}

/** Normalisierte Adresse als Cache-Schlüssel (Groß/Klein, Leerzeichen, „Str.“/„Straße“). */
export function normalizeAddress(line: string): string {
  return line
    .toLowerCase()
    .normalize("NFC")
    .replace(/stra(ss|ß)e\b/g, "str")
    .replace(/\bstr\./g, "str")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
