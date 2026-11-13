import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { salesLeads, salesSettings, salesSuppressions } from "@/db/schema";
import { OpenAiCompatibleLlm } from "@/integrations/llm/openai-compatible";
import { findWebsiteEmails, PoliteFetcher, queryOverpass, type FetchImpl } from "@/integrations/lead-search/web";
import type { Resolver } from "@/integrations/net-guard";
import { audit } from "@/lib/audit";
import { log } from "@/lib/log";
import { acceptedEmails } from "@/lib/vertrieb/email-filter";
import {
  buildDedupeKeys,
  buildOverpassQuery,
  duplicateBeforeEmail,
  duplicateEmail,
  MAX_KM_LIMITS,
  nextRing,
  normalizeLeadSearch,
  parseCoordinates,
  parseOverpass,
  rememberLead,
  RING_KM_LIMITS,
  websiteHostKey,
  type LastRun,
  type LeadSearch,
} from "@/lib/vertrieb/lead-search";
import { addressProvider, geocodePlace } from "./address-suggest";

/**
 * Nächtliche Praxissuche für den Vertrieb (Plattform-Betreiber).
 * Je Lauf: nächster Ring um den Startort → eine Overpass-Abfrage (OpenStreetMap) → je Praxis ggf. Website
 * (Startseite + eine Impressum-/Kontaktseite) → nur Funktions-E-Mails (Regelfilter, optional LLM-Auswahl)
 * → neue Leads (Status „neu“, Quelle „osm“/„osm+impressum“). Bestehende Leads werden nie verändert.
 * Gespeichert werden nur Praxisname, Funktions-E-Mail, Website, PLZ, Ort, Entfernung, Quelle.
 * Aufrufer: POST /api/cron/lead-search (CRON_SECRET, nur wenn eingeschaltet) und „Jetzt suchen“ (Plattform-Admin).
 */

/** Höchstens so viele Websites je Lauf (≈ 3 Anfragen je Website bei 1/s) */
export const MAX_WEBSITES_PER_RUN = 80;
/** Danach keine Website-Abrufe mehr (Leads werden trotzdem ohne E-Mail angelegt) */
export const RUN_BUDGET_MS = 10 * 60_000;
/** Ein „laufender“ Lauf gilt nach dieser Zeit als abgebrochen */
const STALE_RUN_MS = 30 * 60_000;

export type EmailPicker = { choosePracticeEmail(practiceName: string, candidates: string[]): Promise<{ best: string | null; personal: string[] }> };

export function llmPickerFromEnv(env: Record<string, string | undefined> = process.env): EmailPicker | null {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY || !env.LLM_MODEL) return null;
  try {
    return new OpenAiCompatibleLlm({ baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL, temperature: 0 });
  } catch {
    return null;
  }
}

export async function getLeadSearch(): Promise<LeadSearch> {
  const [row] = await db.select({ ls: salesSettings.leadSearch }).from(salesSettings).where(eq(salesSettings.id, 1));
  return normalizeLeadSearch(row?.ls);
}

async function writeLeadSearch(next: LeadSearch, adminUserId?: string | null) {
  const value = next as unknown as Record<string, unknown>;
  await db
    .insert(salesSettings)
    .values({ id: 1, leadSearch: value, updatedBy: adminUserId ?? null })
    .onConflictDoUpdate({ target: salesSettings.id, set: { leadSearch: value, ...(adminUserId ? { updatedBy: adminUserId, updatedAt: new Date() } : {}) } });
}

export type LeadSearchInput = { enabled: boolean; centerText: string; ringKm: number; maxKm: number; resetProgress: boolean };

/**
 * Einstellungen speichern. Startort: „lat, lon“ oder Adresse/PLZ (wird über Photon geokodiert; es verlässt nur
 * dieser Text den Server). Neuer Startort, andere Ringbreite oder „zurücksetzen“ → Suche beginnt wieder bei 0 km.
 */
export async function saveLeadSearchSettings(adminUserId: string, input: LeadSearchInput, deps: { geocode?: (text: string) => Promise<{ lat: number; lon: number } | null> } = {}) {
  const cur = await getLeadSearch();
  if (!Number.isInteger(input.ringKm) || input.ringKm < RING_KM_LIMITS[0] || input.ringKm > RING_KM_LIMITS[1]) throw new Error(`Ringbreite: ${RING_KM_LIMITS[0]} bis ${RING_KM_LIMITS[1]} km.`);
  if (!Number.isInteger(input.maxKm) || input.maxKm < MAX_KM_LIMITS[0] || input.maxKm > MAX_KM_LIMITS[1]) throw new Error(`Höchstradius: ${MAX_KM_LIMITS[0]} bis ${MAX_KM_LIMITS[1]} km.`);
  const text = input.centerText.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  let center = cur.center;
  if (!text) center = null;
  else if (!center || text !== center.label) {
    const geocode = deps.geocode ?? (addressProvider() === "off" ? async () => null : (t: string) => geocodePlace(t));
    const geo = parseCoordinates(text) ?? (await geocode(text));
    if (!geo) throw new Error("Startort nicht gefunden. Bitte Adresse/PLZ und Ort oder Koordinaten („52.39, 13.06“) angeben.");
    center = { lat: Math.round(geo.lat * 1e5) / 1e5, lon: Math.round(geo.lon * 1e5) / 1e5, label: text };
  }
  if (input.enabled && !center) throw new Error("Zum Einschalten bitte einen Startort angeben.");
  const moved = center?.lat !== cur.center?.lat || center?.lon !== cur.center?.lon;
  const reset = input.resetProgress || moved || input.ringKm !== cur.ringKm;
  const next: LeadSearch = { ...cur, enabled: input.enabled, center, ringKm: input.ringKm, maxKm: input.maxKm, doneKm: reset ? 0 : Math.min(cur.doneKm, input.maxKm) };
  await writeLeadSearch(next, adminUserId);
  await audit({ userId: adminUserId, action: "vertrieb.lead_search_settings", entity: "sales_settings", meta: { enabled: next.enabled, ringKm: next.ringKm, maxKm: next.maxKm, reset } });
}

export type RunDeps = {
  /** Overpass-Abruf (Tests: Mock) */
  overpassFetch?: FetchImpl;
  /** Website-Abruf (Tests: Mock) */
  webFetch?: FetchImpl;
  resolver?: Resolver;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** null = ohne LLM (nur Regelfilter); undefined = aus env (LLM_BASE_URL/LLM_API_KEY/LLM_MODEL) */
  llm?: EmailPicker | null;
  budgetMs?: number;
  maxWebsites?: number;
};

export type RunResult =
  | { status: "disabled" | "no_center" | "finished" | "busy" }
  | { status: "ok" | "error"; run: LastRun };

/** Setzt atomar „läuft“ (verhindert parallele Läufe); null, wenn schon ein frischer Lauf aktiv ist. */
async function claim(now: Date): Promise<LeadSearch | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ ls: salesSettings.leadSearch }).from(salesSettings).where(eq(salesSettings.id, 1)).for("update");
    const s = normalizeLeadSearch(row?.ls);
    if (s.runningSince && now.getTime() - Date.parse(s.runningSince) < STALE_RUN_MS) return null;
    const next = { ...s, runningSince: now.toISOString() };
    await tx.update(salesSettings).set({ leadSearch: next as unknown as Record<string, unknown> }).where(eq(salesSettings.id, 1));
    return s;
  });
}

/** Ein Suchlauf (nächster Ring). `trigger: "cron"` läuft nur, wenn die Suche eingeschaltet ist. */
export async function runLeadSearch(opts: { trigger: "cron" | "manual"; adminUserId?: string | null }, deps: RunDeps = {}): Promise<RunResult> {
  const now = deps.now ?? (() => new Date());
  const pre = await getLeadSearch();
  if (opts.trigger === "cron" && !pre.enabled) return { status: "disabled" };
  if (!pre.center) return { status: "no_center" };
  if (!nextRing(pre)) return { status: "finished" };
  const started = now();
  const s = await claim(started);
  if (!s) return { status: "busy" };
  const center = s.center!;
  const ring = nextRing(s)!;
  const run: LastRun = { at: started.toISOString(), manual: opts.trigger === "manual", innerKm: ring.innerKm, outerKm: ring.outerKm, found: 0, added: 0, withEmail: 0, duplicates: 0, crawled: 0 };
  let completed = false;
  try {
    const json = await queryOverpass(buildOverpassQuery(center, ring.outerKm), { fetchImpl: deps.overpassFetch });
    const practices = parseOverpass(json, center, ring);
    run.found = practices.length;

    const existing = await db.select({ email: salesLeads.email, website: salesLeads.website, name: salesLeads.name, zip: salesLeads.zip }).from(salesLeads);
    const supp = await db.select({ e: salesSuppressions.email }).from(salesSuppressions);
    const keys = buildDedupeKeys(existing, supp.map((r) => r.e));
    const fetcher = new PoliteFetcher({ fetchImpl: deps.webFetch, resolver: deps.resolver, sleep: deps.sleep });
    const llm = deps.llm === undefined ? llmPickerFromEnv() : deps.llm;
    const budgetEnd = started.getTime() + (deps.budgetMs ?? RUN_BUDGET_MS);
    const maxWebsites = deps.maxWebsites ?? MAX_WEBSITES_PER_RUN;

    for (const p of practices) {
      if (duplicateBeforeEmail(keys, p)) {
        run.duplicates++;
        continue;
      }
      const host = websiteHostKey(p.website);
      let candidates = acceptedEmails(p.emails, p.name, host);
      let source = "osm";
      if (!candidates.length && p.website && run.crawled < maxWebsites && now().getTime() < budgetEnd) {
        run.crawled++;
        const r = await findWebsiteEmails(p.website, fetcher, (found) => acceptedEmails(found, p.name, host).length > 0);
        candidates = acceptedEmails(r.emails, p.name, host);
        if (candidates.length) source = "osm+impressum";
      }
      let email = candidates[0] ?? null;
      if (llm && candidates.length) {
        try {
          const pick = await llm.choosePracticeEmail(p.name, candidates);
          const allowed = candidates.filter((c) => !pick.personal.includes(c));
          email = pick.best && allowed.includes(pick.best) ? pick.best : (allowed[0] ?? null);
        } catch (e) {
          log.warn("vertrieb.lead_search.llm_failed", { error: e instanceof Error ? e.name : "unknown" });
        }
      }
      if (duplicateEmail(keys, email)) {
        run.duplicates++;
        continue;
      }
      const lead = { name: p.name, email, website: p.website, zip: p.zip, city: p.city };
      const ins = await db
        .insert(salesLeads)
        .values({ ...lead, distanceKm: p.distanceKm, source, status: "neu", notes: `Automatisch gefunden (OpenStreetMap ${p.osmId}, © OpenStreetMap-Mitwirkende, ODbL)` })
        .onConflictDoNothing()
        .returning({ id: salesLeads.id });
      rememberLead(keys, lead);
      if (!ins.length) {
        run.duplicates++;
        continue;
      }
      run.added++;
      if (email) run.withEmail++;
    }
    completed = true;
  } catch (e) {
    run.error = (e instanceof Error ? e.message : "Unbekannter Fehler").slice(0, 300);
    log.warn("vertrieb.lead_search.failed", { error: e instanceof Error ? e.name : "unknown" });
  } finally {
    const latest = await getLeadSearch();
    // Fortschritt nur zählen, wenn der Ring vollständig verarbeitet wurde und die Einstellungen sich nicht geändert haben
    const sameSetup = latest.center?.lat === center.lat && latest.center?.lon === center.lon && latest.ringKm === s.ringKm;
    const doneKm = completed && sameSetup && latest.doneKm === s.doneKm ? ring.outerKm : latest.doneKm;
    await writeLeadSearch({ ...latest, doneKm, runningSince: null, lastRun: run });
  }
  await audit({ userId: opts.adminUserId ?? null, action: "vertrieb.lead_search", entity: "sales_lead", meta: { ...run } });
  return { status: completed ? "ok" : "error", run };
}
