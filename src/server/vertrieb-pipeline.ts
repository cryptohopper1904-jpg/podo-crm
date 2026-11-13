import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { memberships, organizations, promoCodes, promoRedemptions, salesCampaigns, salesLeadEvents, salesLeads, salesSends, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { SEQUENCE_STEPS, isLeadStatus, type LeadStatus, type Template } from "@/lib/vertrieb/constants";
import { normalizeEmail } from "@/lib/vertrieb/eligibility";
import { deriveStage, emailDomain, isFreemail, matchLeadsToOrgs, STAGES, websiteDomain, type MatchedOrg, type Stage } from "@/lib/vertrieb/pipeline";
import { validateTemplate } from "@/lib/vertrieb/template";
import { blockedEmails, isBlocked } from "./blocklist";
import { NAMED_NOTE } from "./lead-search";
import { listRedemptions } from "./promo-codes";
import { setLeadStatus, validTemplates, type Lead } from "./vertrieb";

/**
 * Vertrieb: Pipeline (Stufen), Kampagnen, Verlauf je Lead und Sammelaktionen. Plattformweit wie src/server/vertrieb.ts –
 * Aufrufer prüfen vorher requirePlatformAdmin() (Admin + 2FA). Von registrierten Praxen werden nur Name, Tarif, Abo-Status,
 * Testphasen-Ende und die E-Mail der Inhaber:in (nur zum Zuordnen, nicht angezeigt) gelesen – keine Patientendaten.
 * Es wird hier nichts versendet.
 */

const MAX_LEADS = 5000;

export type PipelineItem = Lead & {
  suppressed: boolean;
  stage: Stage;
  org: MatchedOrg | null;
  named: boolean;
  campaignName: string | null;
  sendsOk: number;
  sendsFailed: number;
};

export type Campaign = typeof salesCampaigns.$inferSelect;

/** Alle Leads mit Stufe, zugeordneter Praxis (falls registriert), Kampagne und Versandzählern. */
export async function loadPipeline(): Promise<PipelineItem[]> {
  const rows = await db
    .select({ lead: salesLeads, campaignName: salesCampaigns.name })
    .from(salesLeads)
    .leftJoin(salesCampaigns, eq(salesCampaigns.id, salesLeads.campaignId))
    .orderBy(sql`${salesLeads.distanceKm} asc nulls last`, asc(salesLeads.name))
    .limit(MAX_LEADS);
  const sends = await db
    .select({ leadId: salesSends.leadId, ok: salesSends.ok, mock: salesSends.mock, n: sql<number>`count(*)::int` })
    .from(salesSends)
    .where(isNotNull(salesSends.leadId))
    .groupBy(salesSends.leadId, salesSends.ok, salesSends.mock);
  const sendMap = new Map<string, { ok: number; failed: number }>();
  for (const s of sends) {
    const m = sendMap.get(s.leadId!) ?? { ok: 0, failed: 0 };
    if (s.ok) m.ok += Number(s.n);
    else m.failed += Number(s.n);
    sendMap.set(s.leadId!, m);
  }
  const blocked = await blockedEmails(rows.flatMap((r) => (r.lead.email ? [r.lead.email] : [])));
  const isSup = (l: Lead) => !!l.email && blocked.has(normalizeEmail(l.email));
  const matches = await matchOrgs(rows.map((r) => ({ ...r.lead, suppressed: isSup(r.lead) })));
  return rows.map(({ lead, campaignName }) => {
    const org = matches.get(lead.id) ?? null;
    const sup = isSup(lead);
    return {
      ...lead,
      suppressed: sup,
      org,
      stage: deriveStage({ ...lead, suppressed: sup }, org),
      named: !!lead.notes?.startsWith(NAMED_NOTE),
      campaignName,
      sendsOk: sendMap.get(lead.id)?.ok ?? 0,
      sendsFailed: sendMap.get(lead.id)?.failed ?? 0,
    };
  });
}

/**
 * Kandidaten gezielt laden (nicht alle Praxen): Inhaber:innen mit gleicher E-Mail oder gleicher Domain wie ein Lead
 * (E-Mail- oder Website-Domain, ohne Freemail) sowie Praxen, die einen persönlichen Code eines Leads eingelöst haben.
 */
async function matchOrgs(leads: (Lead & { suppressed: boolean })[]) {
  const emails = [...new Set(leads.flatMap((l) => (l.email ? [l.email.trim().toLowerCase()] : [])))];
  const domains = [...new Set(leads.flatMap((l) => [emailDomain(l.email), websiteDomain(l.website)]).filter((d): d is string => !!d && !isFreemail(d)))];
  const codeRed = await db
    .select({ leadId: promoCodes.leadId, organizationId: promoRedemptions.organizationId })
    .from(promoRedemptions)
    .innerJoin(promoCodes, eq(promoCodes.id, promoRedemptions.codeId))
    .where(isNotNull(promoCodes.leadId));
  const owners =
    emails.length || domains.length || codeRed.length
      ? await db
          .select({ org: memberships.organizationId, email: users.email })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.active, true),
              eq(memberships.role, "owner"),
              or(
                emails.length ? inArray(sql`lower(${users.email})`, emails) : undefined,
                domains.length ? inArray(sql`lower(split_part(${users.email}, '@', 2))`, domains) : undefined,
                codeRed.length ? inArray(memberships.organizationId, codeRed.map((r) => r.organizationId)) : undefined,
              ),
            ),
          )
      : [];
  const orgIds = [...new Set([...owners.map((o) => o.org), ...codeRed.map((r) => r.organizationId)])];
  const orgs = orgIds.length
    ? await db
        .select({ id: organizations.id, name: organizations.name, plan: organizations.plan, subscriptionStatus: organizations.subscriptionStatus, trialEndsAt: organizations.trialEndsAt, createdAt: organizations.createdAt })
        .from(organizations)
        .where(inArray(organizations.id, orgIds))
    : [];
  return matchLeadsToOrgs(
    leads,
    orgs.map((o) => ({ ...o, ownerEmails: owners.filter((x) => x.org === o.id).map((x) => x.email) })),
    codeRed.map((r) => ({ leadId: r.leadId!, organizationId: r.organizationId })),
  );
}

// ───────────── Filter und Kennzahlen (in der Konsole) ─────────────

export type PipelineFilter = {
  stage?: Stage | null;
  status?: LeadStatus | null;
  q?: string | null;
  source?: string | null;
  email?: "mit" | "ohne" | null;
  named?: boolean;
  /** dokumentierte Einwilligung vorhanden? */
  consent?: "mit" | "ohne" | null;
  maxKm?: number | null;
  /** Kampagnen-ID oder „ohne“ */
  campaign?: string | null;
};

export function filterPipeline(items: PipelineItem[], f: PipelineFilter): PipelineItem[] {
  const q = f.q?.trim().toLowerCase().slice(0, 100);
  return items.filter((l) => {
    if (f.stage && l.stage !== f.stage) return false;
    if (f.status && l.status !== f.status) return false;
    if (f.source && (l.source ?? "") !== f.source) return false;
    if (f.email === "mit" && !l.email) return false;
    if (f.email === "ohne" && l.email) return false;
    if (f.named && !l.named) return false;
    if (f.consent === "mit" && !l.consentAt) return false;
    if (f.consent === "ohne" && l.consentAt) return false;
    if (f.maxKm != null && (l.distanceKm == null || l.distanceKm > f.maxKm)) return false;
    if (f.campaign === "ohne" ? l.campaignId : f.campaign && l.campaignId !== f.campaign) return false;
    if (q && ![l.name, l.email, l.city, l.zip, l.contactPerson].some((v) => v?.toLowerCase().includes(q))) return false;
    return true;
  });
}

export function stageCounts(items: PipelineItem[]): Record<Stage, number> {
  const c = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const l of items) c[l.stage]++;
  return c;
}

export const isReplied = (l: Pick<PipelineItem, "status" | "repliedAt">) => !!l.repliedAt || l.status === "geantwortet" || l.status === "interessiert";

export type Dashboard = {
  leads: number;
  newThisWeek: number;
  newFromSearch: number;
  withEmail: number;
  withConsent: number;
  mailsSent: number;
  mailsMock: number;
  mailsFailed: number;
  contacted: number;
  replied: number;
  tests: number;
  customers: number;
  redemptions: number;
};

export async function salesDashboard(items: PipelineItem[], now = new Date()): Promise<Dashboard> {
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const fresh = items.filter((l) => l.createdAt.getTime() >= weekAgo);
  const [s] = await db
    .select({
      ok: sql<number>`count(*) filter (where ${salesSends.ok} and not ${salesSends.mock})::int`,
      mock: sql<number>`count(*) filter (where ${salesSends.ok} and ${salesSends.mock})::int`,
      failed: sql<number>`count(*) filter (where not ${salesSends.ok})::int`,
    })
    .from(salesSends);
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(promoRedemptions);
  return {
    leads: items.length,
    newThisWeek: fresh.length,
    newFromSearch: fresh.filter((l) => (l.source ?? "").startsWith("osm")).length,
    withEmail: items.filter((l) => l.email).length,
    withConsent: items.filter((l) => l.consentAt).length,
    mailsSent: Number(s?.ok ?? 0),
    mailsMock: Number(s?.mock ?? 0),
    mailsFailed: Number(s?.failed ?? 0),
    contacted: items.filter((l) => l.step > 0).length,
    replied: items.filter((l) => l.step > 0 && isReplied(l)).length,
    tests: items.filter((l) => l.stage === "test").length,
    customers: items.filter((l) => l.stage === "kunde").length,
    redemptions: Number(r?.n ?? 0),
  };
}

/** Quellen der Leads (für den Filter) */
export const leadSources = (items: PipelineItem[]) => [...new Set(items.map((l) => l.source ?? "").filter(Boolean))].sort();

// ───────────── Lead: Verlauf, Notiz, Antwort ─────────────

export type TimelineEntry =
  | { at: Date; kind: "send"; step: number; ok: boolean; mock: boolean; error: string | null }
  | { at: Date; kind: "note" | "status" | "reply" | "campaign" | "consent"; text: string | null; meta: Record<string, unknown> | null }
  | { at: Date; kind: "created" };

export async function leadTimeline(lead: Lead): Promise<TimelineEntry[]> {
  const [sends, events] = await Promise.all([
    db.select().from(salesSends).where(eq(salesSends.leadId, lead.id)),
    db.select().from(salesLeadEvents).where(eq(salesLeadEvents.leadId, lead.id)).orderBy(desc(salesLeadEvents.createdAt)).limit(300),
  ]);
  const out: TimelineEntry[] = [
    { at: lead.createdAt, kind: "created" },
    ...sends.map((s) => ({ at: s.sentAt, kind: "send" as const, step: s.step, ok: s.ok, mock: s.mock, error: s.error })),
    ...events.map((e) => ({ at: e.createdAt, kind: e.kind as "note" | "status" | "reply" | "campaign" | "consent", text: e.text, meta: e.meta })),
  ];
  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** Zugeordnete Praxis eines Leads (falls registriert) */
export async function leadOrg(lead: Lead): Promise<MatchedOrg | null> {
  const suppressed = lead.email ? await isBlocked(lead.email) : false;
  return (await matchOrgs([{ ...lead, suppressed }])).get(lead.id) ?? null;
}

export async function addLeadNote(adminUserId: string, leadId: string, text: string) {
  const t = text.replace(/\r\n?/g, "\n").trim().slice(0, 2000);
  if (!t) throw new Error("Notiz ist leer.");
  const [l] = await db.select({ id: salesLeads.id }).from(salesLeads).where(eq(salesLeads.id, leadId));
  if (!l) throw new Error("Eintrag nicht gefunden.");
  await db.insert(salesLeadEvents).values({ leadId, kind: "note", text: t, createdBy: adminUserId });
  await audit({ userId: adminUserId, action: "vertrieb.note", entity: "sales_lead", entityId: leadId });
}

/** „Antwort erhalten“: Zeitpunkt merken, Sequenz beenden (Status „Geantwortet“, außer er ist schon weiter). */
export async function markReplied(adminUserId: string, leadId: string, now = new Date()) {
  await db.transaction(async (tx) => {
    const [l] = await tx.select().from(salesLeads).where(eq(salesLeads.id, leadId)).for("update");
    if (!l) throw new Error("Eintrag nicht gefunden.");
    const status: string = l.status === "neu" || l.status === "in_sequenz" ? "geantwortet" : l.status;
    await tx.update(salesLeads).set({ repliedAt: now, status, updatedAt: now }).where(eq(salesLeads.id, leadId));
    await tx.insert(salesLeadEvents).values({ leadId, kind: "reply", meta: status !== l.status ? { from: l.status, to: status } : null, createdBy: adminUserId, createdAt: now });
    await audit({ userId: adminUserId, action: "vertrieb.reply", entity: "sales_lead", entityId: leadId, meta: { from: l.status, to: status } }, tx);
  });
}

// ───────────── Sammelaktionen ─────────────

const ids500 = (ids: string[]) => [...new Set(ids)].slice(0, 500);

/** Status für mehrere Leads (je Lead wie einzeln: Sperrliste bei „abgemeldet“, Verlauf, Audit). */
export async function bulkSetStatus(adminUserId: string, ids: string[], status: LeadStatus): Promise<number> {
  if (!isLeadStatus(status)) throw new Error("Status ungültig.");
  let n = 0;
  for (const id of ids500(ids)) {
    try {
      await setLeadStatus(adminUserId, id, status);
      n++;
    } catch {
      // gelöscht o. Ä. – überspringen
    }
  }
  return n;
}

/** Leads einer Kampagne zuordnen (null = aus Kampagne entfernen). */
export async function setLeadsCampaign(adminUserId: string, ids: string[], campaignId: string | null): Promise<number> {
  const list = ids500(ids);
  if (!list.length) return 0;
  return db.transaction(async (tx) => {
    let name: string | null = null;
    if (campaignId) {
      const [c] = await tx.select({ name: salesCampaigns.name }).from(salesCampaigns).where(eq(salesCampaigns.id, campaignId));
      if (!c) throw new Error("Kampagne nicht gefunden.");
      name = c.name;
    }
    const changed = await tx
      .update(salesLeads)
      .set({ campaignId, updatedAt: new Date() })
      .where(and(inArray(salesLeads.id, list), campaignId ? sql`${salesLeads.campaignId} is distinct from ${campaignId}` : isNotNull(salesLeads.campaignId)))
      .returning({ id: salesLeads.id });
    if (changed.length) {
      await tx.insert(salesLeadEvents).values(changed.map((c) => ({ leadId: c.id, kind: "campaign", text: name, meta: { campaignId }, createdBy: adminUserId })));
    }
    await audit({ userId: adminUserId, action: "vertrieb.campaign_assigned", entity: "sales_campaign", entityId: campaignId ?? undefined, meta: { leads: changed.length } }, tx);
    return changed.length;
  });
}

// ───────────── Kampagnen ─────────────

export type CampaignStats = {
  leads: number;
  contacted: number;
  sent: number;
  failed: number;
  replied: number;
  tests: number;
  converted: number;
  codes: { id: string; code: string; active: boolean; trialDays: number }[];
};

export async function listCampaigns(): Promise<Campaign[]> {
  return db.select().from(salesCampaigns).orderBy(desc(salesCampaigns.active), desc(salesCampaigns.createdAt)).limit(200);
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  const [c] = await db.select().from(salesCampaigns).where(eq(salesCampaigns.id, id));
  return c ?? null;
}

/** Kennzahlen je Kampagne: aus den aktuellen Leads der Kampagne und den Einlösungen ihrer Codes. */
export async function campaignStats(items: PipelineItem[], campaignIds: string[]): Promise<Map<string, CampaignStats>> {
  const out = new Map<string, CampaignStats>();
  if (!campaignIds.length) return out;
  const codes = await db
    .select({ id: promoCodes.id, code: promoCodes.code, active: promoCodes.active, trialDays: promoCodes.trialDays, campaignId: promoCodes.campaignId })
    .from(promoCodes)
    .where(inArray(promoCodes.campaignId, campaignIds))
    .orderBy(desc(promoCodes.createdAt));
  const reds = await listRedemptions(codes.map((c) => c.id));
  for (const id of campaignIds) {
    const mine = items.filter((l) => l.campaignId === id);
    const myCodes = codes.filter((c) => c.campaignId === id);
    const myReds = reds.filter((r) => myCodes.some((c) => c.id === r.codeId));
    out.set(id, {
      leads: mine.length,
      contacted: mine.filter((l) => l.step > 0).length,
      sent: mine.reduce((a, l) => a + l.sendsOk, 0),
      failed: mine.reduce((a, l) => a + l.sendsFailed, 0),
      replied: mine.filter((l) => l.step > 0 && isReplied(l)).length,
      tests: myReds.length,
      converted: myReds.filter((r) => r.converted).length,
      codes: myCodes.map(({ id: cid, code, active, trialDays }) => ({ id: cid, code, active, trialDays })),
    });
  }
  return out;
}

const cleanName = (s: string) => s.replace(/[\r\n]+/g, " ").trim().slice(0, 120);

export async function createCampaign(adminUserId: string, input: { name: string; notes: string | null }): Promise<string> {
  const name = cleanName(input.name);
  if (!name) throw new Error("Bitte einen Namen angeben.");
  const [row] = await db.insert(salesCampaigns).values({ name, notes: input.notes?.trim().slice(0, 2000) || null, createdBy: adminUserId }).returning({ id: salesCampaigns.id });
  await audit({ userId: adminUserId, action: "vertrieb.campaign_created", entity: "sales_campaign", entityId: row.id, meta: { name } });
  return row.id;
}

export async function updateCampaign(adminUserId: string, id: string, input: { name: string; notes: string | null; active: boolean }) {
  const name = cleanName(input.name);
  if (!name) throw new Error("Bitte einen Namen angeben.");
  const r = await db
    .update(salesCampaigns)
    .set({ name, notes: input.notes?.trim().slice(0, 2000) || null, active: input.active, updatedAt: new Date() })
    .where(eq(salesCampaigns.id, id))
    .returning({ id: salesCampaigns.id });
  if (!r.length) throw new Error("Kampagne nicht gefunden.");
  await audit({ userId: adminUserId, action: "vertrieb.campaign_updated", entity: "sales_campaign", entityId: id, meta: { name, active: input.active } });
}

/** Eigene Vorlagen-Variante der Kampagne speichern (null = wieder Standardvorlagen verwenden). */
export async function saveCampaignTemplates(adminUserId: string, id: string, templates: Template[] | null) {
  let clean: Template[] | null = null;
  if (templates) {
    if (templates.length !== SEQUENCE_STEPS) throw new Error("Es braucht genau 3 Vorlagen.");
    clean = templates.map((t) => ({ subject: t.subject.trim(), body: t.body.replace(/\r\n?/g, "\n").trim() }));
    clean.forEach((t, i) => {
      const e = validateTemplate(t);
      if (e) throw new Error(`Mail ${i + 1}: ${e}`);
    });
  }
  const r = await db.update(salesCampaigns).set({ templates: clean, updatedAt: new Date() }).where(eq(salesCampaigns.id, id)).returning({ id: salesCampaigns.id });
  if (!r.length) throw new Error("Kampagne nicht gefunden.");
  await audit({ userId: adminUserId, action: clean ? "vertrieb.campaign_templates" : "vertrieb.campaign_templates_reset", entity: "sales_campaign", entityId: id, meta: clean ? { subjects: clean.map((t) => t.subject) } : undefined });
}

export const campaignTemplates = (c: Campaign) => validTemplates(c.templates);
