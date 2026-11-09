import "server-only";
import { createHash } from "node:crypto";
import { and, eq, gt, inArray } from "drizzle-orm";
import { withOrg } from "@/db";
import { geocodeCache, routeCache } from "@/db/schema";
import { createRateLimiter } from "@/lib/rate-limit";
import { estimateLeg, normalizeAddress, roundCoord, type LatLon, type Leg } from "@/lib/routing/geo";
import { fetchRouteLegs, photonGeocode, routingConfig, type FetchImpl, type RoutingConfig } from "@/lib/routing/provider";
import { log } from "@/lib/log";

const ROUTE_TTL_MS = 30 * 86400_000;
const GEOCODE_TTL_MS = 90 * 86400_000;
/** Anfragen an Routing-/Geokodierungsdienst je Praxis und Minute (darüber: Schätzung bzw. „nicht gefunden“) */
const providerLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Status für die Einstellungen (Hinweis, wenn nicht konfiguriert) */
export function routingStatus(): { provider: string; ok: boolean; demo: boolean; message: string } {
  const cfg = routingConfig();
  if (cfg.provider === "off") return { provider: "off", ok: false, demo: false, message: cfg.reason };
  const name = cfg.provider === "ors" ? "openrouteservice" : "OSRM";
  return {
    provider: cfg.provider,
    ok: true,
    demo: cfg.demo,
    message: cfg.demo
      ? `${name}: öffentlicher Demo-Server (nur Entwicklung, kein Produktivbetrieb). Bitte OSRM_URL oder ORS_API_KEY setzen.`
      : `${name} (${new URL(cfg.baseUrl).hostname}) – es werden nur Koordinaten übermittelt.`,
  };
}

/** Adresse → Koordinaten (Cache je Praxis, 90 Tage). null = nicht gefunden / Dienst nicht erreichbar. */
export async function geocodeAddress(org: string, address: string, deps: { fetchImpl?: FetchImpl } = {}): Promise<LatLon | null> {
  const norm = normalizeAddress(address);
  if (norm.length < 3) return null;
  const key = sha(`v1|${norm}`);
  const [hit] = await withOrg(org, (tx) =>
    tx
      .select({ lat: geocodeCache.lat, lon: geocodeCache.lon })
      .from(geocodeCache)
      .where(and(eq(geocodeCache.organizationId, org), eq(geocodeCache.addressHash, key), gt(geocodeCache.createdAt, new Date(Date.now() - GEOCODE_TTL_MS)))),
  );
  if (hit) return hit.lat !== null && hit.lon !== null ? { lat: hit.lat, lon: hit.lon } : null;
  if (providerLimiter.limited(`geo:${org}`)) return null;
  let found: LatLon | null;
  try {
    found = await photonGeocode(address, { fetchImpl: deps.fetchImpl });
  } catch (e) {
    log.warn("geocode.failed", { error: e instanceof Error ? e.message : String(e) });
    return null; // nicht cachen – nächster Versuch später
  }
  const values = { lat: found ? roundCoord(found.lat, 4) : null, lon: found ? roundCoord(found.lon, 4) : null };
  await withOrg(org, (tx) =>
    tx
      .insert(geocodeCache)
      .values({ organizationId: org, addressHash: key, ...values })
      .onConflictDoUpdate({ target: [geocodeCache.organizationId, geocodeCache.addressHash], set: { ...values, createdAt: new Date() } }),
  );
  return values.lat !== null && values.lon !== null ? { lat: values.lat, lon: values.lon } : null;
}

const pairKey = (provider: string, a: LatLon, b: LatLon) =>
  sha(`v1|${provider}|${roundCoord(a.lat, 4)},${roundCoord(a.lon, 4)}|${roundCoord(b.lat, 4)},${roundCoord(b.lon, 4)}`);

export type RoutePoint = { point: LatLon | null; /** false: z. B. aktueller Standort – nie im Cache speichern */ cacheable?: boolean };

/**
 * Etappen zwischen aufeinanderfolgenden Punkten. Punkte ohne Koordinaten unterbrechen die Kette (Etappe = null).
 * Reihenfolge: Cache (30 Tage) → Routing-Dienst (eine Anfrage je zusammenhängendem Abschnitt) → Schätzung.
 */
export async function routeLegs(org: string, stops: RoutePoint[], deps: { fetchImpl?: FetchImpl; config?: RoutingConfig } = {}): Promise<(Leg | null)[]> {
  const cfg = deps.config ?? routingConfig();
  const out: (Leg | null)[] = new Array(Math.max(0, stops.length - 1)).fill(null);
  const provider = cfg.provider;
  // 1) Cache
  const keys = out.map((_, i) => {
    const a = stops[i].point;
    const b = stops[i + 1].point;
    return a && b && stops[i].cacheable !== false && stops[i + 1].cacheable !== false && provider !== "off" ? pairKey(provider, a, b) : null;
  });
  const wanted = keys.filter((k): k is string => !!k);
  if (wanted.length) {
    const rows = await withOrg(org, (tx) =>
      tx
        .select()
        .from(routeCache)
        .where(and(eq(routeCache.organizationId, org), inArray(routeCache.keyHash, wanted), gt(routeCache.createdAt, new Date(Date.now() - ROUTE_TTL_MS)))),
    );
    const byKey = new Map(rows.map((r) => [r.keyHash, r]));
    keys.forEach((k, i) => {
      const r = k ? byKey.get(k) : undefined;
      if (r) out[i] = { distanceM: r.distanceM, durationSec: r.durationSec, estimated: false, provider: r.provider };
    });
  }
  // 2) zusammenhängende Abschnitte mit fehlenden Etappen beim Dienst anfragen
  const runs: { from: number; to: number }[] = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i] || !stops[i].point || !stops[i + 1].point) continue;
    const last = runs[runs.length - 1];
    if (last && last.to === i) last.to = i + 1;
    else runs.push({ from: i, to: i + 1 });
  }
  const fresh: { key: string; leg: Leg }[] = [];
  for (const run of runs) {
    const pts = stops.slice(run.from, run.to + 1).map((s) => s.point as LatLon);
    let legs: Leg[] | null = null;
    if (provider !== "off" && !providerLimiter.limited(`route:${org}`)) {
      try {
        legs = await fetchRouteLegs(cfg, pts, deps.fetchImpl);
      } catch (e) {
        log.warn("routing.failed", { provider, error: e instanceof Error ? e.message : String(e) });
      }
    }
    for (let i = run.from; i < run.to; i++) {
      if (out[i]) continue;
      const leg = legs?.[i - run.from] ?? estimateLeg(stops[i].point as LatLon, stops[i + 1].point as LatLon);
      out[i] = leg;
      if (!leg.estimated && keys[i]) fresh.push({ key: keys[i]!, leg });
    }
  }
  // 3) neue Ergebnisse speichern (nur Schlüssel-Hash + Strecke/Dauer)
  if (fresh.length) {
    await withOrg(org, async (tx) => {
      for (const f of fresh) {
        const v = { provider: f.leg.provider, distanceM: f.leg.distanceM, durationSec: f.leg.durationSec };
        await tx
          .insert(routeCache)
          .values({ organizationId: org, keyHash: f.key, ...v })
          .onConflictDoUpdate({ target: [routeCache.organizationId, routeCache.keyHash], set: { ...v, createdAt: new Date() } });
      }
    });
  }
  return out;
}
