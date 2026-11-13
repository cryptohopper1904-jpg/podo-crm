/**
 * Nächtliche Praxissuche (Vertrieb des Plattform-Betreibers) – reine Funktionen ohne Netz/DB:
 *  - Einstellungen/Fortschritt (sales_settings.lead_search) prüfen und mit Standardwerten füllen
 *  - Ring-Logik: jede Nacht der nächste Ring um den Startort (0–10 km, 10–20 km, … bis max. km)
 *  - Overpass-Abfrage (OpenStreetMap) bauen und Antwort in Praxis-Kandidaten übersetzen
 *  - robots.txt auswerten, Impressum-/Kontakt-Link finden, Dubletten-Schlüssel
 * Gespeichert werden nur Praxisname, E-Mail (Funktionspostfach bzw. Geschäftsadresse der eigenen Website), Website,
 * PLZ, Ort, Entfernung, Quelle – keine Ansprechpartner/Telefon. Hinweis: Bei Einzelpraxen enthält der Praxisname oft
 * den Namen der Inhaberin/des Inhabers und ist damit ein personenbezogenes Datum (Art. 6 Abs. 1 lit. f DSGVO, B2B).
 */
import { nameZipKey } from "./csv";
import { anchors, wildcardMatch } from "./html-scan";

export const RING_KM_DEFAULT = 10;
export const MAX_KM_DEFAULT = 150;
export const RING_KM_LIMITS = [2, 50] as const;
export const MAX_KM_LIMITS = [5, 300] as const;
export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
/** Allgemeiner Kennzeichner ohne Daten des Betreibers (Overpass-Nutzungsregeln verlangen einen aussagekräftigen User-Agent). */
export const LEAD_SEARCH_USER_AGENT = "PodoHero-Praxissuche/1.0 (+https://podo.algoverdict.com)";
/** Produktkennung für robots.txt-Gruppen („User-agent: PodoHero-Praxissuche“) */
export const ROBOTS_AGENT = "podohero-praxissuche";

export type Center = { lat: number; lon: number; label: string };

export type LastRun = {
  at: string;
  manual: boolean;
  innerKm: number;
  outerKm: number;
  /** Treffer in OSM im Ring (nach Fachfilter) */
  found: number;
  added: number;
  withEmail: number;
  duplicates: number;
  /** Websites, die geprüft wurden */
  crawled: number;
  /** bestehende OSM-Leads ohne E-Mail, die nachträglich eine E-Mail bekommen haben */
  enriched?: number;
  /** Leads mit Geschäftsadresse mit Namensbezug */
  named?: number;
  error?: string;
};

export type LeadSearch = {
  enabled: boolean;
  center: Center | null;
  ringKm: number;
  maxKm: number;
  /** Außenradius des zuletzt vollständig durchsuchten Rings (0 = noch nichts) */
  doneKm: number;
  /** gesetzt, solange ein Lauf aktiv ist (Schutz gegen parallele Läufe) */
  runningSince: string | null;
  lastRun: LastRun | null;
  /** „Auch Geschäftsadressen mit Namen übernehmen (nur eigene Praxis-Website/Impressum)“ – Standard an */
  allowNamed: boolean;
  /** aufeinanderfolgende Fehlschläge desselben Rings (ab 3 wird der Ring halbiert) */
  ringFailures: number;
  /** Nachträgliche Anreicherung: Lead-ID → { n: Versuche, at: letzter Versuch ISO } (begrenzt) */
  enrich: Record<string, { n: number; at: string }>;
};

export const DEFAULT_LEAD_SEARCH: LeadSearch = {
  enabled: false,
  center: null,
  ringKm: RING_KM_DEFAULT,
  maxKm: MAX_KM_DEFAULT,
  doneKm: 0,
  runningSince: null,
  lastRun: null,
  allowNamed: true,
  ringFailures: 0,
  enrich: {},
};
/** Ein „laufender“ Lauf gilt nach dieser Zeit als abgebrochen */
export const STALE_RUN_MS = 30 * 60_000;
export const isRunning = (s: Pick<LeadSearch, "runningSince">, now = Date.now()) => !!s.runningSince && now - Date.parse(s.runningSince) < STALE_RUN_MS;

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : d);

export const validLat = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= -90 && v <= 90;
export const validLon = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= -180 && v <= 180;

/** Liest den gespeicherten jsonb-Wert robust (fehlende/ungültige Felder → Standard). */
export function normalizeLeadSearch(raw: unknown): LeadSearch {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const c = r.center as Record<string, unknown> | null | undefined;
  const center = c && validLat(c.lat) && validLon(c.lon) ? { lat: c.lat, lon: c.lon, label: typeof c.label === "string" ? c.label.slice(0, 200) : "" } : null;
  const maxKm = num(r.maxKm, MAX_KM_LIMITS[0], MAX_KM_LIMITS[1], MAX_KM_DEFAULT);
  const lr = r.lastRun as LastRun | null | undefined;
  return {
    enabled: r.enabled === true,
    center,
    ringKm: num(r.ringKm, RING_KM_LIMITS[0], RING_KM_LIMITS[1], RING_KM_DEFAULT),
    maxKm,
    doneKm: num(r.doneKm, 0, MAX_KM_LIMITS[1], 0),
    runningSince: typeof r.runningSince === "string" ? r.runningSince : null,
    lastRun: lr && typeof lr === "object" && typeof lr.at === "string" ? lr : null,
    allowNamed: r.allowNamed !== false,
    ringFailures: num(r.ringFailures, 0, 1000, 0),
    enrich: normalizeEnrich(r.enrich),
  };
}

const UUID_RE = /^[0-9a-f-]{36}$/i;
function normalizeEnrich(v: unknown): LeadSearch["enrich"] {
  if (!v || typeof v !== "object") return {};
  const out: LeadSearch["enrich"] = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const e = x as { n?: unknown; at?: unknown };
    if (UUID_RE.test(k) && typeof e?.n === "number" && typeof e.at === "string") out[k] = { n: e.n, at: e.at };
  }
  return out;
}

export type Ring = { innerKm: number; outerKm: number };

/**
 * Nächster Ring oder null, wenn der Höchstradius erreicht ist. Nach je 3 Fehlschlägen desselben Rings
 * (z. B. Overpass-Zeitüberschreitung, zu viele Treffer) wird die Breite halbiert (mind. 1 km), damit die Suche
 * nicht dauerhaft hängen bleibt.
 */
export function nextRing(s: Pick<LeadSearch, "doneKm" | "ringKm" | "maxKm"> & { ringFailures?: number }): Ring | null {
  if (s.doneKm >= s.maxKm) return null;
  const innerKm = Math.max(0, s.doneKm);
  const width = Math.max(1, s.ringKm / 2 ** Math.floor((s.ringFailures ?? 0) / 3));
  return { innerKm, outerKm: Math.min(Math.round((innerKm + width) * 10) / 10, s.maxKm) };
}

/** Luftlinie in km (Haversine). */
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371.0088;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Liegt die Entfernung im Ring? Innenrand gehört zum vorigen Ring (außer beim ersten), Außenrand zu diesem. */
export const inRing = (d: number, r: Ring) => (r.innerKm === 0 ? d >= 0 : d > r.innerKm) && d <= r.outerKm;

/** „52.3906, 13.0645“ → Koordinate; sonst null (dann wird der Text geokodiert). */
export function parseCoordinates(text: string): { lat: number; lon: number } | null {
  const m = text.trim().match(/^(-?\d{1,2}(?:[.]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.]\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return validLat(lat) && validLon(lon) ? { lat, lon } : null;
}

const NAME_PATTERN = "podolog|fu(ß|ss)pflege";
const NAME_RE = new RegExp(NAME_PATTERN, "i");

/** Höchstzahl Elemente je Abfrage; wird sie erreicht, ist das Ergebnis evtl. abgeschnitten → Ring gilt als fehlgeschlagen. */
export const OVERPASS_MAX_ELEMENTS = 2000;
/** Sicherheitsabstand: Der innere Kreis wird um so viel kleiner abgezogen (Wege, deren Mittelpunkt knapp im Ring liegt). */
const INNER_MARGIN_KM = 1;

/**
 * Overpass-QL: Knoten/Wege/Relationen mit podologischen Tags oder passendem Namen – nur der Ring
 * (Außenkreis minus Innenkreis, Innenkreis mit 1 km Sicherheitsabstand). Die genaue Ringgrenze prüft danach
 * parseOverpass anhand der Entfernung.
 */
export function buildOverpassQuery(center: { lat: number; lon: number }, ring: Ring | number, timeoutSec = 120): string {
  const r = typeof ring === "number" ? { innerKm: 0, outerKm: ring } : ring;
  const around = (km: number) => `(around:${Math.round(km * 1000)},${center.lat.toFixed(5)},${center.lon.toFixed(5)})`;
  const set = (km: number, name: string) => [
    "(",
    `  nwr["healthcare"="podiatrist"]${around(km)};`,
    `  nwr["healthcare:speciality"~"podiatry|chiropody"]${around(km)};`,
    `  nwr["shop"="chiropodist"]${around(km)};`,
    `  nwr["name"~"${NAME_PATTERN}",i]${around(km)};`,
    `)->.${name};`,
  ];
  const inner = r.innerKm - INNER_MARGIN_KM;
  return [
    `[out:json][timeout:${timeoutSec}];`,
    ...set(r.outerKm, "aussen"),
    ...(inner > 0 ? [...set(inner, "innen"), "(.aussen; - .innen;)->.ring;"] : ["(.aussen;)->.ring;"]),
    `.ring out tags center ${OVERPASS_MAX_ELEMENTS};`,
  ].join("\n");
}

type OsmElement = { type?: string; id?: number; lat?: number; lon?: number; center?: { lat?: number; lon?: number }; tags?: Record<string, string> };

/** Gehört das OSM-Objekt fachlich zur Podologie/medizinischen Fußpflege? Nagelstudios (beauty=nails) nicht. */
export function isPodiatry(tags: Record<string, string>): boolean {
  if (tags.healthcare === "podiatrist" || tags.shop === "chiropodist") return true;
  if (/podiatry|chiropody/.test(tags["healthcare:speciality"] ?? "")) return true;
  // Kosmetik-/Nagelstudios nur, wenn der Name eindeutig podologisch ist
  if (tags.shop === "beauty") return /podolog|medizinische\s+fu(ß|ss)pflege/i.test(tags.name ?? "");
  if (tags.disused || tags["disused:shop"] || tags["was:shop"] || tags.abandoned) return false;
  return NAME_RE.test(tags.name ?? "");
}

export type OsmPractice = {
  osmId: string;
  name: string;
  emails: string[];
  website: string | null;
  zip: string | null;
  city: string | null;
  distanceKm: number;
  lat: number;
  lon: number;
};

const clean = (v: string | undefined, max: number) => {
  const s = v?.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

/** Overpass-JSON → Praxen im Ring, nach Entfernung sortiert, je OSM-Objekt einmal. */
export function parseOverpass(json: unknown, center: { lat: number; lon: number }, ring: Ring): OsmPractice[] {
  const els = ((json as { elements?: unknown })?.elements ?? []) as OsmElement[];
  if (!Array.isArray(els)) return [];
  const seen = new Set<string>();
  const out: OsmPractice[] = [];
  for (const el of els) {
    const tags = el?.tags;
    if (!tags || typeof tags !== "object") continue;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!validLat(lat) || !validLon(lon)) continue;
    const name = clean(tags.name, 200);
    if (!name || !isPodiatry(tags)) continue;
    const osmId = `${el.type ?? "node"}/${el.id ?? "?"}`;
    if (seen.has(osmId)) continue;
    seen.add(osmId);
    const d = haversineKm(center, { lat, lon });
    if (!inRing(d, ring)) continue;
    const emails = [tags.email, tags["contact:email"]]
      .flatMap((e) => (e ? e.split(/[;,\s]+/) : []))
      .map((e) => e.trim())
      .filter(Boolean);
    const zip = clean(tags["addr:postcode"], 10);
    out.push({
      osmId,
      name,
      emails,
      website: normalizeWebsite(tags.website ?? tags["contact:website"] ?? tags.url),
      zip: zip && /^\d{4,5}$/.test(zip) ? zip : null,
      city: clean(tags["addr:city"], 120),
      distanceKm: Math.round(d * 10) / 10,
      lat,
      lon,
    });
  }
  return out.sort((a, b) => a.distanceKm - b.distanceKm || a.name.localeCompare(b.name));
}

/** OSM-Website → https-URL (ohne Fragment/Zugangsdaten/Port) oder null. „www.praxis.de“ wird zu https://www.praxis.de/. */
export function normalizeWebsite(raw: string | null | undefined): string | null {
  const first = raw?.split(/[;\s]+/).find(Boolean)?.trim();
  if (!first || first.length > 300) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(first) ? first : `https://${first}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,24}$/i.test(u.hostname)) return null;
  u.hash = "";
  return u.toString();
}

/** Plattformen/Verzeichnisse: viele Praxen teilen sich den Host → kein Website-Dubletten-Schlüssel, kein Abruf. */
const PLATFORM_HOSTS = [
  "facebook.com",
  "fb.com",
  "fb.me",
  "instagram.com",
  "doctolib.de",
  "jameda.de",
  "goo.gl",
  "g.page",
  "g.co",
  "linktr.ee",
  "youtube.com",
  "xing.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "yelp.de",
  "yelp.com",
  "gelbeseiten.de",
  "dasoertliche.de",
  "dastelefonbuch.de",
  "11880.com",
  "meinestadt.de",
  "treatwell.de",
  "booksy.com",
  "wa.me",
  "whatsapp.com",
  "t.me",
];
/** Gemeinsame Hosts, auf denen die Seite über den Pfad unterschieden wird → Schlüssel = Host + erste Pfadteile. */
const PATH_HOSTS: Record<string, number> = { "sites.google.com": 2, "wixsite.com": 1, "jimdo.com": 1, "jimdofree.com": 1, "business.site": 1 };

const bareHost = (url: string) => {
  try {
    return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return null;
  }
};

/** Gehört der Host zu einer Plattform (Facebook, Instagram, Doctolib, Google …)? */
export function isPlatformHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  if (h in PATH_HOSTS) return false;
  if (/^(?:[a-z0-9-]+\.)*google\.[a-z.]{2,6}$/.test(h)) return true;
  return PLATFORM_HOSTS.some((p) => h === p || h.endsWith(`.${p}`));
}

/** Darf die Website abgerufen werden (keine Plattform)? */
export const crawlableWebsite = (url: string | null | undefined): url is string => {
  const u = url ? bareHost(url) : null;
  return !!u && !isPlatformHost(u.hostname);
};

/**
 * Dubletten-Schlüssel der Website: Host ohne „www.“, klein. Plattformen → kein Schlüssel; gemeinsame Hosts mit
 * Pfad-Unterscheidung (sites.google.com/view/x, www.wixsite.com/x) → Host + Pfadteile.
 */
export function websiteHostKey(url: string | null | undefined): string | null {
  if (!url) return null;
  const u = bareHost(url);
  if (!u) return null;
  const h = u.hostname.toLowerCase().replace(/^www\./, "");
  if (!h || isPlatformHost(h)) return null;
  const segs = PATH_HOSTS[h];
  if (segs) {
    const parts = u.pathname.split("/").filter(Boolean).slice(0, segs);
    return parts.length === segs ? `${h}/${parts.join("/").toLowerCase()}` : null;
  }
  return h;
}

// ───────────── Dubletten ─────────────

export type DedupeKeys = { emails: Set<string>; hosts: Set<string>; nameLocs: Set<string>; suppressed: Set<string> };
type LeadKeyInput = {
  email: string | null;
  website: string | null;
  name: string;
  zip: string | null;
  city?: string | null;
  lat?: number | null;
  lon?: number | null;
  /** OSM-Objekt („node/123“) – bei bestehenden Leads aus den Notizen gelesen */
  osmId?: string | null;
  notes?: string | null;
};

/** OSM-Kennung aus den Notizen eines automatisch angelegten Leads („… OpenStreetMap node/123 …“). */
export const osmIdFromNotes = (notes: string | null | undefined) => notes?.match(/OpenStreetMap ((?:node|way|relation)\/\d+)/)?.[1] ?? null;

export const emailKey = (e: string) => e.trim().toLowerCase();
const normName = (n: string) => n.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Name + Ort-Schlüssel: Name+PLZ (wie CSV-Import), zusätzlich Name+Ort und Name+gerundete Koordinate (~100 m).
 * Ohne PLZ/Ort/Koordinate gibt es keinen Schlüssel (nicht nur über den Namen zusammenführen).
 */
export function nameLocationKeys(l: LeadKeyInput): string[] {
  const keys: string[] = [];
  if (l.zip?.trim()) keys.push(nameZipKey(l.name, l.zip));
  if (l.city?.trim()) keys.push(`${normName(l.name)}|ort:${normName(l.city)}`);
  if (typeof l.lat === "number" && typeof l.lon === "number") keys.push(`${normName(l.name)}|geo:${l.lat.toFixed(3)},${l.lon.toFixed(3)}`);
  const osm = l.osmId ?? osmIdFromNotes(l.notes);
  if (osm) keys.push(`osm:${osm}`);
  return keys;
}

export function buildDedupeKeys(existing: LeadKeyInput[], suppressed: Iterable<string>): DedupeKeys {
  const k: DedupeKeys = { emails: new Set(), hosts: new Set(), nameLocs: new Set(), suppressed: new Set([...suppressed].map(emailKey)) };
  for (const l of existing) rememberLead(k, l);
  return k;
}

export function rememberLead(k: DedupeKeys, l: LeadKeyInput) {
  if (l.email) k.emails.add(emailKey(l.email));
  const h = websiteHostKey(l.website);
  if (h) k.hosts.add(h);
  for (const key of nameLocationKeys(l)) k.nameLocs.add(key);
}

/** Grund, warum die Praxis schon bekannt ist (Website-Host, Name+PLZ/Ort/Lage) – vor dem Website-Abruf prüfbar. */
export function duplicateBeforeEmail(k: DedupeKeys, p: Omit<LeadKeyInput, "email">): string | null {
  const h = websiteHostKey(p.website);
  if (h && k.hosts.has(h)) return "Website bereits vorhanden";
  if (nameLocationKeys({ ...p, email: null }).some((key) => k.nameLocs.has(key))) return "Name und PLZ/Ort bzw. OSM-Objekt bereits vorhanden";
  return null;
}

export function duplicateEmail(k: DedupeKeys, email: string | null): string | null {
  if (!email) return null;
  if (k.suppressed.has(emailKey(email))) return "Auf der Sperrliste";
  if (k.emails.has(emailKey(email))) return "E-Mail bereits vorhanden";
  return null;
}

// ───────────── robots.txt ─────────────

type RobotsRule = { allow: boolean; pattern: string };

const ruleMatches = (pattern: string, path: string) => wildcardMatch(pattern, path);

/**
 * robots.txt nach RFC 9309: passende Gruppe (unsere Kennung, sonst „*“), längste passende Regel gewinnt,
 * bei Gleichstand Allow. Ohne passende Regel erlaubt.
 */
export function robotsAllows(robots: string, path: string, agent = ROBOTS_AGENT): boolean {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let cur: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of robots.slice(0, 500_000).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      lastWasAgent = false;
      if (cur) cur.rules.push({ allow: key === "allow", pattern: val });
    } else {
      lastWasAgent = false;
    }
  }
  const a = agent.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((x) => x !== "*" && (a.includes(x) || x.includes(a))));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  let best: RobotsRule | null = null;
  for (const r of chosen.flatMap((g) => g.rules)) {
    if (!r.pattern || !ruleMatches(r.pattern, path)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

// ───────────── Impressum/Kontakt finden ─────────────

const sameHost = (a: string, b: string) => a.toLowerCase().replace(/^www\./, "") === b.toLowerCase().replace(/^www\./, "");

/** Erster Link auf derselben Website, dessen Ziel oder Text „impressum“ (bevorzugt) oder „kontakt“ enthält. */
export function findContactLink(html: string, pageUrl: string): string | null {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return null;
  }
  let best: { url: string; score: number } | null = null;
  for (const a of anchors(html)) {
    const href = a.href;
    const text = a.text.toLowerCase();
    const h = href.toLowerCase();
    const score = /impressum|imprint/.test(h) || /impressum|imprint/.test(text) ? 2 : /kontakt|contact/.test(h) || /kontakt|contact/.test(text) ? 1 : 0;
    if (!score || /^(mailto|tel|javascript|data):/i.test(href)) continue;
    let u: URL;
    try {
      u = new URL(href.replace(/&amp;/g, "&"), base);
    } catch {
      continue;
    }
    if (!sameHost(u.hostname, base.hostname)) continue;
    if (u.protocol === "http:") u.protocol = "https:";
    if (u.protocol !== "https:" || u.port || u.username) continue;
    u.hash = "";
    if (u.toString() === base.toString()) continue;
    if (!best || score > best.score) best = { url: u.toString(), score };
    if (score === 2) break;
  }
  return best?.url ?? null;
}

/** Bot-Abwehr/Challenge erkannt (Cloudflare & Co.)? Dann wird die Seite übersprungen – nie umgangen. */
export function looksLikeChallenge(status: number, headers: { get(name: string): string | null }, body: string): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  if (headers.get("cf-mitigated")) return true;
  return /challenge-platform|cf-chl-|cf_chl_|<title>\s*(just a moment|attention required|ddos-guard)/i.test(body.slice(0, 20_000));
}
