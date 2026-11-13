import "server-only";
import { and, asc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { salesLeads, salesSettings } from "@/db/schema";
import { OpenAiCompatibleLlm } from "@/integrations/llm/openai-compatible";
import { findWebsiteEmails, PoliteFetcher, queryOverpass, type FetchImpl } from "@/integrations/lead-search/web";
import type { Resolver } from "@/integrations/net-guard";
import { audit } from "@/lib/audit";
import { log } from "@/lib/log";
import { acceptedEmails, type AcceptedEmail, type EmailKind } from "@/lib/vertrieb/email-filter";
import {
  buildDedupeKeys,
  buildOverpassQuery,
  crawlableWebsite,
  duplicateBeforeEmail,
  duplicateEmail,
  isRunning,
  MAX_KM_LIMITS,
  nextRing,
  normalizeLeadSearch,
  parseCoordinates,
  parseOverpass,
  rememberLead,
  RING_KM_LIMITS,
  type DedupeKeys,
  type LastRun,
  type LeadSearch,
} from "@/lib/vertrieb/lead-search";
import { addressProvider, geocodePlace } from "./address-suggest";
import { blocklistMatcher } from "./blocklist";

/**
 * Nächtliche Praxissuche für den Vertrieb (Plattform-Betreiber).
 * Je Lauf: nächster Ring um den Startort → eine Overpass-Abfrage (OpenStreetMap) → je Praxis ggf. Website
 * (Startseite + eine Impressum-/Kontaktseite) → E-Mail-Filter (Funktionspostfächer; Geschäftsadressen mit Namen nur
 * von der eigenen Website mit deren Domain, abschaltbar) → optional LLM-Auswahl → neue Leads (Status „neu“, Quelle
 * „osm“/„osm+impressum“). Danach werden bis zu ENRICH_PER_RUN ältere OSM-Leads ohne E-Mail erneut geprüft
 * (E-Mail nur ergänzt, wenn leer und der Lead nie bearbeitet wurde). Bestehende Angaben werden nie überschrieben.
 * Gespeichert werden Praxisname, E-Mail, Website, PLZ, Ort, Entfernung, Quelle – keine Ansprechpartner/Telefon.
 * Praxisnamen von Einzelpraxen enthalten oft den Namen der Inhaberin/des Inhabers (personenbezogen, B2B).
 * Aufrufer: POST /api/cron/lead-search (CRON_SECRET, nur wenn eingeschaltet) und „Jetzt suchen“ (Plattform-Admin).
 */

/** Höchstens so viele Websites je Lauf (≈ 3 Anfragen je Website bei 1/s) */
export const MAX_WEBSITES_PER_RUN = 80;
/** Danach keine Website-Abrufe/LLM-Aufrufe mehr (Leads werden trotzdem ohne E-Mail angelegt) */
export const RUN_BUDGET_MS = 10 * 60_000;
/** Höchstens so viele LLM-Aufrufe je Lauf, je Aufruf höchstens LLM_TIMEOUT_MS */
export const MAX_LLM_CALLS_PER_RUN = 40;
const LLM_TIMEOUT_MS = 20_000;
/** Nachträgliche Anreicherung: höchstens so viele Leads je Lauf, je Lead höchstens 3 Versuche im Abstand von 7 Tagen */
export const ENRICH_PER_RUN = 20;
const ENRICH_MAX_ATTEMPTS = 3;
const ENRICH_RETRY_MS = 7 * 86_400_000;
const ENRICH_MAP_MAX = 1000;
/** Kennzeichnung in den Notizen: Geschäftsadresse mit Namensbezug (Konsole zeigt ein Badge) */
export const NAMED_NOTE = "Adresse mit Namensbezug";
const OSM_SOURCES = ["osm", "osm+impressum"];

export type EmailPicker = { choosePracticeEmail(practiceName: string, candidates: string[]): Promise<{ best: string | null; personal: string[] }> };

/**
 * LLM nur mit ausdrücklicher Freigabe LEAD_SEARCH_LLM_APPROVED=true UND eigener Konfiguration
 * LEAD_LLM_BASE_URL/LEAD_LLM_API_KEY/LEAD_LLM_MODEL – getrennt von LLM_* (Patientendaten-Funktionen), damit ein
 * kostenloser Anbieter für die Praxissuche nie für Gesundheitsdaten verwendet wird.
 * Gesendet werden Praxisname (kann den Namen der Inhaberin/des Inhabers enthalten) und Kandidaten-Adressen.
 * Zeitlimit je Anfrage 20 s (AbortSignal), keine Wiederholungen.
 */
export function llmPickerFromEnv(env: Record<string, string | undefined> = process.env): EmailPicker | null {
  if (env.LEAD_SEARCH_LLM_APPROVED !== "true") return null;
  if (!env.LEAD_LLM_BASE_URL || !env.LEAD_LLM_API_KEY || !env.LEAD_LLM_MODEL) return null;
  try {
    return new OpenAiCompatibleLlm({
      baseUrl: env.LEAD_LLM_BASE_URL,
      apiKey: env.LEAD_LLM_API_KEY,
      model: env.LEAD_LLM_MODEL,
      temperature: 0,
      fetch: (u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(LLM_TIMEOUT_MS) }),
    });
  } catch {
    return null;
  }
}

const toJson = (s: LeadSearch) => s as unknown as Record<string, unknown>;

export async function getLeadSearch(): Promise<LeadSearch> {
  const [row] = await db.select({ ls: salesSettings.leadSearch }).from(salesSettings).where(eq(salesSettings.id, 1));
  return normalizeLeadSearch(row?.ls);
}

/** Liest und schreibt lead_search unter Zeilensperre (kein Überschreiben paralleler Änderungen). */
async function updateLeadSearch(fn: (cur: LeadSearch) => LeadSearch | null, adminUserId?: string | null): Promise<{ before: LeadSearch; after: LeadSearch | null }> {
  return db.transaction(async (tx: Tx) => {
    await tx.insert(salesSettings).values({ id: 1 }).onConflictDoNothing();
    const [row] = await tx.select({ ls: salesSettings.leadSearch }).from(salesSettings).where(eq(salesSettings.id, 1)).for("update");
    const before = normalizeLeadSearch(row?.ls);
    const after = fn(before);
    if (after) {
      await tx
        .update(salesSettings)
        .set({ leadSearch: toJson(after), ...(adminUserId ? { updatedBy: adminUserId, updatedAt: new Date() } : {}) })
        .where(eq(salesSettings.id, 1));
    }
    return { before, after };
  });
}

export type LeadSearchInput = { enabled: boolean; centerText: string; ringKm: number; maxKm: number; resetProgress: boolean; allowNamed: boolean };

/**
 * Einstellungen speichern. Startort: „lat, lon“ oder Adresse/PLZ (wird über Photon geokodiert; es verlässt nur
 * dieser Text den Server). Neuer Startort, andere Ringbreite oder „zurücksetzen“ → Suche beginnt wieder bei 0 km.
 */
export async function saveLeadSearchSettings(adminUserId: string, input: LeadSearchInput, deps: { geocode?: (text: string) => Promise<{ lat: number; lon: number } | null> } = {}) {
  if (!Number.isInteger(input.ringKm) || input.ringKm < RING_KM_LIMITS[0] || input.ringKm > RING_KM_LIMITS[1]) throw new Error(`Ringbreite: ${RING_KM_LIMITS[0]} bis ${RING_KM_LIMITS[1]} km.`);
  if (!Number.isInteger(input.maxKm) || input.maxKm < MAX_KM_LIMITS[0] || input.maxKm > MAX_KM_LIMITS[1]) throw new Error(`Höchstradius: ${MAX_KM_LIMITS[0]} bis ${MAX_KM_LIMITS[1]} km.`);
  const text = input.centerText.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  const cur0 = await getLeadSearch();
  let center = cur0.center;
  if (!text) center = null;
  else if (!center || text !== center.label) {
    const geocode = deps.geocode ?? (addressProvider() === "off" ? async () => null : (t: string) => geocodePlace(t));
    const geo = parseCoordinates(text) ?? (await geocode(text));
    if (!geo) throw new Error("Startort nicht gefunden. Bitte Adresse/PLZ und Ort oder Koordinaten („52.39, 13.06“) angeben.");
    center = { lat: Math.round(geo.lat * 1e5) / 1e5, lon: Math.round(geo.lon * 1e5) / 1e5, label: text };
  }
  if (input.enabled && !center) throw new Error("Zum Einschalten bitte einen Startort angeben.");
  let reset = false;
  await updateLeadSearch((cur) => {
    const moved = center?.lat !== cur.center?.lat || center?.lon !== cur.center?.lon;
    reset = input.resetProgress || moved || input.ringKm !== cur.ringKm;
    return {
      ...cur,
      enabled: input.enabled,
      center,
      ringKm: input.ringKm,
      maxKm: input.maxKm,
      allowNamed: input.allowNamed,
      doneKm: reset ? 0 : Math.min(cur.doneKm, input.maxKm),
      ringFailures: reset ? 0 : cur.ringFailures,
    };
  }, adminUserId);
  await audit({ userId: adminUserId, action: "vertrieb.lead_search_settings", entity: "sales_settings", meta: { enabled: input.enabled, ringKm: input.ringKm, maxKm: input.maxKm, allowNamed: input.allowNamed, reset } });
}

export type RunDeps = {
  /** Overpass-Abruf (Tests: Mock) */
  overpassFetch?: FetchImpl;
  /** Website-Abruf (Tests: Mock) */
  webFetch?: FetchImpl;
  resolver?: Resolver;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** null = ohne LLM (nur Regelfilter); undefined = aus env (LEAD_SEARCH_LLM_APPROVED + LLM_*) */
  llm?: EmailPicker | null;
  budgetMs?: number;
  maxWebsites?: number;
  maxLlmCalls?: number;
};

export type RunResult = { status: "disabled" | "no_center" | "finished" | "busy" } | { status: "ok" | "error"; run: LastRun };

/** Laufzeit-Kontext eines Laufs (Budget, Zähler, Abrufer) */
type RunCtx = {
  s: LeadSearch;
  run: LastRun;
  keys: DedupeKeys;
  fetcher: PoliteFetcher;
  llm: EmailPicker | null;
  now: () => Date;
  budgetEnd: number;
  maxWebsites: number;
  maxLlmCalls: number;
  llmCalls: number;
};

const inBudget = (c: RunCtx) => c.now().getTime() < c.budgetEnd;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error("LLM-Zeitüberschreitung")), ms)))]).finally(() => clearTimeout(t));
}

type Found = { email: string | null; kind: EmailKind | null; fromWebsite: boolean };

/** Ermittelt die E-Mail einer Praxis: OSM-Tags (nur Funktionspostfächer), sonst Website (eigene Domain/Freemail). */
async function findEmail(c: RunCtx, p: { name: string; city: string | null; website: string | null; osmEmails: string[] }): Promise<Found> {
  const host = p.website ? new URL(p.website).hostname : null;
  const base = { practiceName: p.name, city: p.city, websiteHost: host, allowNamed: c.s.allowNamed };
  let candidates: AcceptedEmail[] = acceptedEmails(p.osmEmails, { ...base, crawled: false });
  let fromWebsite = false;
  if (!candidates.length && crawlableWebsite(p.website) && c.run.crawled < c.maxWebsites && inBudget(c)) {
    c.run.crawled++;
    const r = await findWebsiteEmails(p.website, c.fetcher, (found) => acceptedEmails(found, { ...base, crawled: true }).length > 0);
    candidates = acceptedEmails(r.emails, { ...base, crawled: true });
    fromWebsite = candidates.length > 0;
  }
  let pick: AcceptedEmail | null = candidates[0] ?? null;
  if (c.llm && candidates.length && c.llmCalls < c.maxLlmCalls && inBudget(c)) {
    c.llmCalls++;
    try {
      const remaining = Math.max(1000, Math.min(LLM_TIMEOUT_MS, c.budgetEnd - c.now().getTime()));
      const r = await withTimeout(
        c.llm.choosePracticeEmail(
          p.name,
          candidates.map((x) => x.email),
        ),
        remaining,
      );
      const allowed = candidates.filter((x) => !r.personal.includes(x.email));
      pick = allowed.find((x) => x.email === r.best) ?? allowed[0] ?? null;
    } catch (e) {
      log.warn("vertrieb.lead_search.llm_failed", { error: e instanceof Error ? e.name : "unknown" });
    }
  }
  return { email: pick?.email ?? null, kind: pick?.kind ?? null, fromWebsite };
}

const notesFor = (osmId: string | null, kind: EmailKind | null, prev?: string | null) => {
  const base = prev ?? `Automatisch gefunden (OpenStreetMap ${osmId}, © OpenStreetMap-Mitwirkende, ODbL)`;
  return kind === "named" && !base.startsWith(NAMED_NOTE) ? `${NAMED_NOTE} (von der Praxis-Website) · ${base}` : base;
};

/** Ältere OSM-Leads ohne E-Mail (z. B. wegen Budget/robots 5xx) erneut prüfen. Nur leere E-Mail wird ergänzt. */
async function enrichExisting(c: RunCtx, enrich: LeadSearch["enrich"], startedAt: Date) {
  const candidates = await db
    .select({ id: salesLeads.id, name: salesLeads.name, website: salesLeads.website, city: salesLeads.city, notes: salesLeads.notes, createdAt: salesLeads.createdAt })
    .from(salesLeads)
    .where(
      and(
        inArray(salesLeads.source, OSM_SOURCES),
        isNull(salesLeads.email),
        isNotNull(salesLeads.website),
        eq(salesLeads.status, "neu"),
        // nur Leads aus früheren Läufen
        lt(salesLeads.createdAt, startedAt),
        // nie bearbeitete Einträge (sonst gilt die leere E-Mail als bewusste Entscheidung)
        sql`${salesLeads.updatedAt} <= ${salesLeads.createdAt} + interval '1 minute'`,
      ),
    )
    .orderBy(asc(salesLeads.createdAt))
    .limit(200);
  let done = 0;
  for (const l of candidates) {
    if (done >= ENRICH_PER_RUN || c.run.crawled >= c.maxWebsites || !inBudget(c)) break;
    const e = enrich[l.id];
    if (e && (e.n >= ENRICH_MAX_ATTEMPTS || c.now().getTime() - Date.parse(e.at) < ENRICH_RETRY_MS)) continue;
    if (!crawlableWebsite(l.website)) continue;
    done++;
    enrich[l.id] = { n: (e?.n ?? 0) + 1, at: c.now().toISOString() };
    const f = await findEmail(c, { name: l.name, city: l.city, website: l.website, osmEmails: [] });
    if (!f.email || duplicateEmail(c.keys, f.email)) continue;
    try {
      const upd = await db
        .update(salesLeads)
        .set({ email: f.email, source: "osm+impressum", notes: notesFor(null, f.kind, l.notes) })
        .where(and(eq(salesLeads.id, l.id), isNull(salesLeads.email), sql`${salesLeads.updatedAt} <= ${salesLeads.createdAt} + interval '1 minute'`))
        .returning({ id: salesLeads.id });
      if (upd.length) {
        c.keys.emails.add(f.email);
        c.run.enriched = (c.run.enriched ?? 0) + 1;
        if (f.kind === "named") c.run.named = (c.run.named ?? 0) + 1;
        delete enrich[l.id];
      }
    } catch (err) {
      log.warn("vertrieb.lead_search.enrich_failed", { error: err instanceof Error ? err.name : "unknown" });
    }
  }
}

/** Ein Suchlauf (nächster Ring + Nachprüfung). `trigger: "cron"` läuft nur, wenn die Suche eingeschaltet ist. */
export async function runLeadSearch(opts: { trigger: "cron" | "manual"; adminUserId?: string | null }, deps: RunDeps = {}): Promise<RunResult> {
  const now = deps.now ?? (() => new Date());
  const started = now();
  // atomar prüfen und „läuft“ setzen (Startort/Ring/Schalter werden unter der Sperre geprüft)
  let status: RunResult["status"] | null = null;
  const { before: s } = await updateLeadSearch((cur) => {
    if (opts.trigger === "cron" && !cur.enabled) status = "disabled";
    else if (!cur.center) status = "no_center";
    else if (!nextRing(cur)) status = "finished";
    else if (isRunning(cur, started.getTime())) status = "busy";
    else return { ...cur, runningSince: started.toISOString() };
    return null;
  });
  if (status) return { status } as RunResult;
  const center = s.center!;
  const ring = nextRing(s)!;
  const run: LastRun = { at: started.toISOString(), manual: opts.trigger === "manual", innerKm: ring.innerKm, outerKm: ring.outerKm, found: 0, added: 0, withEmail: 0, duplicates: 0, crawled: 0, enriched: 0, named: 0 };
  const enrich = { ...s.enrich };
  let completed = false;
  try {
    const existing = await db.select({ email: salesLeads.email, website: salesLeads.website, name: salesLeads.name, zip: salesLeads.zip, city: salesLeads.city, notes: salesLeads.notes }).from(salesLeads);
    const blocked = await blocklistMatcher();
    const c: RunCtx = {
      s,
      run,
      keys: buildDedupeKeys(existing, blocked),
      fetcher: new PoliteFetcher({ fetchImpl: deps.webFetch, resolver: deps.resolver, sleep: deps.sleep }),
      llm: deps.llm === undefined ? llmPickerFromEnv() : deps.llm,
      now,
      budgetEnd: started.getTime() + (deps.budgetMs ?? RUN_BUDGET_MS),
      maxWebsites: deps.maxWebsites ?? MAX_WEBSITES_PER_RUN,
      maxLlmCalls: deps.maxLlmCalls ?? MAX_LLM_CALLS_PER_RUN,
      llmCalls: 0,
    };
    try {
      const json = await queryOverpass(buildOverpassQuery(center, ring), { fetchImpl: deps.overpassFetch });
      const practices = parseOverpass(json, center, ring);
      run.found = practices.length;
      for (const p of practices) {
        if (duplicateBeforeEmail(c.keys, p)) {
          run.duplicates++;
          continue;
        }
        const f = await findEmail(c, { name: p.name, city: p.city, website: p.website, osmEmails: p.emails });
        if (duplicateEmail(c.keys, f.email)) {
          run.duplicates++;
          continue;
        }
        const lead = { name: p.name, email: f.email, website: p.website, zip: p.zip, city: p.city };
        const ins = await db
          .insert(salesLeads)
          .values({ ...lead, distanceKm: p.distanceKm, source: f.fromWebsite ? "osm+impressum" : "osm", status: "neu", notes: notesFor(p.osmId, f.kind) })
          .onConflictDoNothing()
          .returning({ id: salesLeads.id });
        rememberLead(c.keys, { ...lead, lat: p.lat, lon: p.lon, osmId: p.osmId });
        if (!ins.length) {
          run.duplicates++;
          continue;
        }
        run.added++;
        if (f.email) run.withEmail++;
        if (f.kind === "named") run.named = (run.named ?? 0) + 1;
      }
      completed = true;
    } catch (e) {
      run.error = (e instanceof Error ? e.message : "Unbekannter Fehler").slice(0, 300);
      log.warn("vertrieb.lead_search.failed", { error: e instanceof Error ? e.name : "unknown" });
    }
    // Nachprüfung älterer Leads ohne E-Mail (auch wenn der Ring fehlschlug)
    await enrichExisting(c, enrich, started);
  } catch (e) {
    run.error ??= (e instanceof Error ? e.message : "Unbekannter Fehler").slice(0, 300);
    log.warn("vertrieb.lead_search.failed", { error: e instanceof Error ? e.name : "unknown" });
  } finally {
    await updateLeadSearch((latest) => {
      // Fortschritt nur zählen, wenn der Ring vollständig verarbeitet wurde und die Einstellungen sich nicht geändert haben
      const sameSetup = latest.center?.lat === center.lat && latest.center?.lon === center.lon && latest.ringKm === s.ringKm && latest.doneKm === s.doneKm;
      const entries = Object.entries(enrich).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, ENRICH_MAP_MAX);
      return {
        ...latest,
        doneKm: completed && sameSetup ? ring.outerKm : latest.doneKm,
        ringFailures: !sameSetup ? latest.ringFailures : completed ? 0 : latest.ringFailures + 1,
        runningSince: null,
        lastRun: run,
        enrich: Object.fromEntries(entries),
      };
    });
  }
  await audit({ userId: opts.adminUserId ?? null, action: "vertrieb.lead_search", entity: "sales_lead", meta: { ...run } });
  return { status: completed ? "ok" : "error", run };
}
