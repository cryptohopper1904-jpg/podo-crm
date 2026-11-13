/**
 * Routing- und Geokodierungs-Dienste (serverseitig). An die Dienste gehen NUR Koordinaten (Routing) bzw. die
 * Adresse ohne Namen (Geokodierung) – nie Namen, Patientennummern oder Termindaten.
 *
 * ROUTING_PROVIDER = osrm | ors | off
 *  - osrm: OSRM_URL (eigener Server). Ohne OSRM_URL nur in der Entwicklung der öffentliche Demo-Server
 *          router.project-osrm.org (Nutzungsbedingungen: kein Produktivbetrieb).
 *  - ors:  openrouteservice (HeiGIT, Heidelberg), ORS_API_KEY; optional ORS_URL (eigene Instanz).
 *  - off / nicht konfiguriert: Schätzung Luftlinie × 1,3 („geschätzt“).
 * Alle Ziele laufen über den SSRF-Schutz (net-guard: nur https, nur öffentliche Hosts), mit Zeitlimit.
 */
import { guardedFetch } from "@/integrations/net-guard";
import { type LatLon, type Leg } from "./geo";

export const USER_AGENT = "PodoHero/1.0 (+https://podo.algoverdict.com)";
export const ROUTING_TIMEOUT_MS = 5000;
export const GEOCODE_TIMEOUT_MS = 3000;
export const OSRM_DEMO_URL = "https://router.project-osrm.org";
export const ORS_DEFAULT_URL = "https://api.openrouteservice.org";
export const PHOTON_DEFAULT_URL = "https://photon.komoot.io";

type Env = Record<string, string | undefined>;
export type RoutingConfig =
  | { provider: "osrm" | "ors"; baseUrl: string; apiKey?: string; demo: boolean; minIntervalMs: number }
  | { provider: "off"; reason: string };

export function routingConfig(env: Env = process.env): RoutingConfig {
  const prod = env.NODE_ENV === "production";
  const wanted = (env.ROUTING_PROVIDER ?? "").trim().toLowerCase() || (env.ORS_API_KEY ? "ors" : "osrm");
  if (wanted === "off") return { provider: "off", reason: "Routing ist abgeschaltet (ROUTING_PROVIDER=off)." };
  if (wanted === "ors") {
    if (!env.ORS_API_KEY) return { provider: "off", reason: "openrouteservice gewählt, aber ORS_API_KEY fehlt." };
    return { provider: "ors", baseUrl: (env.ORS_URL || ORS_DEFAULT_URL).replace(/\/+$/, ""), apiKey: env.ORS_API_KEY, demo: false, minIntervalMs: 300 };
  }
  if (wanted === "osrm") {
    if (env.OSRM_URL) return { provider: "osrm", baseUrl: env.OSRM_URL.replace(/\/+$/, ""), demo: false, minIntervalMs: 100 };
    if (prod) return { provider: "off", reason: "Im Produktivbetrieb ist ein eigener OSRM-Server (OSRM_URL) oder ein openrouteservice-Schlüssel (ORS_API_KEY) nötig." };
    return { provider: "osrm", baseUrl: OSRM_DEMO_URL, demo: true, minIntervalMs: 1100 };
  }
  return { provider: "off", reason: `Unbekannter ROUTING_PROVIDER „${wanted}“ (erlaubt: osrm, ors, off).` };
}

export function photonUrl(env: Env = process.env): string {
  return (env.PHOTON_URL || PHOTON_DEFAULT_URL).replace(/\/+$/, "");
}

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: FetchImpl = guardedFetch();

const c5 = (v: number) => Math.round(v * 1e5) / 1e5;

/** Mindestabstand zwischen Anfragen je Anbieter (pro Prozess) – schont öffentliche Dienste */
const lastCall = new Map<string, number>();
async function pace(key: string, minMs: number) {
  const now = Date.now();
  const wait = (lastCall.get(key) ?? 0) + minMs - now;
  lastCall.set(key, Math.max(now, (lastCall.get(key) ?? 0) + minMs));
  if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 3000)));
}

export class RoutingError extends Error {}

/** Route über alle Punkte; Ergebnis: eine Etappe je aufeinanderfolgendem Punktpaar. */
export async function fetchRouteLegs(cfg: RoutingConfig, points: LatLon[], fetchImpl: FetchImpl = defaultFetch): Promise<Leg[]> {
  if (cfg.provider === "off") throw new RoutingError(cfg.reason);
  if (points.length < 2) return [];
  if (points.length > 25) throw new RoutingError("Zu viele Wegpunkte (max. 25).");
  await pace(cfg.baseUrl, cfg.minIntervalMs);
  const signal = AbortSignal.timeout(ROUTING_TIMEOUT_MS);
  if (cfg.provider === "osrm") {
    const coords = points.map((p) => `${c5(p.lon)},${c5(p.lat)}`).join(";");
    const res = await fetchImpl(`${cfg.baseUrl}/route/v1/driving/${coords}?overview=false&steps=false`, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal });
    if (!res.ok) throw new RoutingError(`Routing-Dienst antwortet mit ${res.status}.`);
    const j = (await res.json()) as { code?: string; routes?: { legs?: { distance: number; duration: number }[] }[] };
    const legs = j.routes?.[0]?.legs;
    if (j.code !== "Ok" || !legs || legs.length !== points.length - 1) throw new RoutingError("Keine Route gefunden.");
    return legs.map((l) => ({ distanceM: Math.round(l.distance), durationSec: Math.round(l.duration), estimated: false, provider: "osrm" }));
  }
  const res = await fetchImpl(`${cfg.baseUrl}/v2/directions/driving-car`, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Content-Type": "application/json", Authorization: cfg.apiKey ?? "" },
    body: JSON.stringify({ coordinates: points.map((p) => [c5(p.lon), c5(p.lat)]), instructions: false }),
    signal,
  });
  if (!res.ok) throw new RoutingError(`Routing-Dienst antwortet mit ${res.status}.`);
  const j = (await res.json()) as { routes?: { segments?: { distance: number; duration: number }[] }[] };
  const segs = j.routes?.[0]?.segments;
  if (!segs || segs.length !== points.length - 1) throw new RoutingError("Keine Route gefunden.");
  return segs.map((s) => ({ distanceM: Math.round(s.distance), durationSec: Math.round(s.duration), estimated: false, provider: "ors" }));
}

/** Adresse → Koordinaten über Photon (OSM). Nur die Adresse wird gesendet. null = nicht gefunden. */
export async function photonGeocode(address: string, opts: { baseUrl?: string; fetchImpl?: FetchImpl } = {}): Promise<LatLon | null> {
  const q = address.trim().slice(0, 200);
  if (q.length < 3) return null;
  const base = opts.baseUrl ?? photonUrl();
  const res = await (opts.fetchImpl ?? defaultFetch)(`${base}/api/?q=${encodeURIComponent(q)}&limit=1&lang=de`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
  });
  if (!res.ok) throw new RoutingError(`Geokodierung antwortet mit ${res.status}.`);
  const j = (await res.json()) as { features?: { geometry?: { coordinates?: [number, number] } }[] };
  const c = j.features?.[0]?.geometry?.coordinates;
  if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
  return { lat: c[1], lon: c[0] };
}
