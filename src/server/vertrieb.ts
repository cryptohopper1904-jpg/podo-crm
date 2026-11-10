import "server-only";
import { and, asc, count, desc, eq, gte, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { salesLeads, salesSends, salesSettings, salesSuppressions } from "@/db/schema";
import { formatFrom, isEmail, MailNotConfiguredError, parseFrom, toMailError, type MailPort } from "@/integrations/mail/mail";
import { audit } from "@/lib/audit";
import { DEFAULT_DELAYS, DEFAULT_TEMPLATES, MAX_PER_CLICK, MAX_PER_DAY, SEQUENCE_STEPS, isLeadStatus, type LeadStatus, type Template } from "@/lib/vertrieb/constants";
import { dedupeLeads, nameZipKey, parseLeadCsv, type ImportDecision, type LeadInput } from "@/lib/vertrieb/csv";
import { normalizeEmail, planBatch, type Delays } from "@/lib/vertrieb/eligibility";
import { composeMail, validateTemplate } from "@/lib/vertrieb/template";
import { unsubscribeUrl, verifyUnsubscribeToken } from "@/lib/vertrieb/unsubscribe-token";
import { platformMailPort } from "./mail";

/**
 * Vertrieb des Plattform-Betreibers (kleines CRM für die Ansprache von Praxen per E-Mail-Sequenz).
 * - Kein Mandantenbezug: Tabellen sales_* ohne organization_id/RLS, Zugriff NUR über diese Datei.
 *   Aufrufer (Server Actions/Seiten unter /plattform/vertrieb) prüfen vorher requirePlatformAdmin() (Admin + 2FA).
 * - Versand nur manuell, in kleinen Mengen (MAX_PER_CLICK, MAX_PER_DAY), mit Vorschau, Abmeldelink,
 *   List-Unsubscribe-Kopfzeilen und Sperrliste. Keine Automatik/Cron.
 * - Audit: Import, Versand, Statuswechsel, Einstellungen, Löschen, Abmeldung (ohne Mailinhalte).
 */

export type Lead = typeof salesLeads.$inferSelect;
export type SalesSend = typeof salesSends.$inferSelect;

// ───────────── Einstellungen ─────────────

export type SalesSettings = {
  senderName: string;
  senderEmail: string;
  replyTo: string;
  impressum: string;
  delays: Delays;
  templates: Template[];
  /** true, wenn noch nie gespeichert (Werte = Standard) */
  isDefault: boolean;
};

function envSender(env: Record<string, string | undefined> = process.env) {
  const f = parseFrom(env.SMTP_FROM);
  return { name: f?.name ?? "", address: f?.address ?? "" };
}

const validTemplates = (t: unknown): Template[] | null =>
  Array.isArray(t) && t.length === SEQUENCE_STEPS && t.every((x) => x && typeof x.subject === "string" && typeof x.body === "string")
    ? t.map((x) => ({ subject: x.subject, body: x.body }))
    : null;

export async function getSalesSettings(): Promise<SalesSettings> {
  const [row] = await db.select().from(salesSettings).where(eq(salesSettings.id, 1));
  const env = envSender();
  return {
    senderName: row?.senderName || env.name,
    senderEmail: row?.senderEmail || env.address,
    replyTo: row?.replyTo ?? "",
    impressum: row?.impressum ?? "",
    delays: { delay2Days: row?.delay2Days ?? DEFAULT_DELAYS.delay2Days, delay3Days: row?.delay3Days ?? DEFAULT_DELAYS.delay3Days },
    templates: validTemplates(row?.templates) ?? DEFAULT_TEMPLATES.map((t) => ({ ...t })),
    isDefault: !row,
  };
}

/** Was fehlt noch, damit Vertriebsmails rechtlich sauber gekennzeichnet versendet werden können? */
export function settingsProblems(s: SalesSettings, env: Record<string, string | undefined> = process.env): string[] {
  const p: string[] = [];
  if (!s.senderName.trim()) p.push("Absendername fehlt (Einstellungen).");
  if (!isEmail(s.senderEmail)) p.push("Absender-E-Mail fehlt oder ist ungültig (Einstellungen).");
  if (s.replyTo && !isEmail(s.replyTo)) p.push("Antwortadresse ist ungültig.");
  if (s.impressum.trim().length < 30) p.push("Impressum/Absenderangaben fehlen (Firma, Anschrift, Kontakt).");
  if (env.NODE_ENV === "production" && !/^https:\/\//.test(env.PUBLIC_URL ?? "")) p.push("PUBLIC_URL (https) ist nicht gesetzt – der Abmeldelink wäre ungültig.");
  s.templates.forEach((t, i) => {
    const e = validateTemplate(t);
    if (e) p.push(`Vorlage Mail ${i + 1}: ${e}`);
  });
  return p;
}

export type SettingsInput = { senderName: string; senderEmail: string; replyTo: string; impressum: string; delay2Days: number; delay3Days: number };

export async function saveSalesSettings(adminUserId: string, input: SettingsInput) {
  const v = {
    senderName: input.senderName.replace(/[\r\n"<>]/g, "").trim().slice(0, 80),
    senderEmail: input.senderEmail.trim().slice(0, 254),
    replyTo: input.replyTo.trim().slice(0, 254),
    impressum: input.impressum.replace(/\r\n?/g, "\n").trim().slice(0, 1500),
    delay2Days: input.delay2Days,
    delay3Days: input.delay3Days,
  };
  if (v.senderEmail && !isEmail(v.senderEmail)) throw new Error("Absender-E-Mail ist ungültig.");
  if (v.replyTo && !isEmail(v.replyTo)) throw new Error("Antwortadresse ist ungültig.");
  for (const d of [v.delay2Days, v.delay3Days]) if (!Number.isInteger(d) || d < 1 || d > 60) throw new Error("Abstände: 1 bis 60 Tage.");
  await db
    .insert(salesSettings)
    .values({ id: 1, ...v, updatedBy: adminUserId })
    .onConflictDoUpdate({ target: salesSettings.id, set: { ...v, updatedBy: adminUserId, updatedAt: new Date() } });
  await audit({ userId: adminUserId, action: "vertrieb.settings", entity: "sales_settings", meta: { senderEmail: v.senderEmail, replyTo: v.replyTo || null, delays: [v.delay2Days, v.delay3Days] } });
}

export async function saveSalesTemplates(adminUserId: string, templates: Template[]) {
  if (templates.length !== SEQUENCE_STEPS) throw new Error("Es braucht genau 3 Vorlagen.");
  const clean = templates.map((t) => ({ subject: t.subject.trim(), body: t.body.replace(/\r\n?/g, "\n").trim() }));
  clean.forEach((t, i) => {
    const e = validateTemplate(t);
    if (e) throw new Error(`Mail ${i + 1}: ${e}`);
  });
  await db
    .insert(salesSettings)
    .values({ id: 1, templates: clean, updatedBy: adminUserId })
    .onConflictDoUpdate({ target: salesSettings.id, set: { templates: clean, updatedBy: adminUserId, updatedAt: new Date() } });
  await audit({ userId: adminUserId, action: "vertrieb.templates", entity: "sales_settings", meta: { subjects: clean.map((t) => t.subject) } });
}

export async function resetSalesTemplates(adminUserId: string) {
  await db.update(salesSettings).set({ templates: null, updatedBy: adminUserId, updatedAt: new Date() }).where(eq(salesSettings.id, 1));
  await audit({ userId: adminUserId, action: "vertrieb.templates_reset", entity: "sales_settings" });
}

// ───────────── Leads ─────────────

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export type LeadListItem = Lead & { suppressed: boolean };

export async function listLeads(opts: { status?: string | null; q?: string | null } = {}): Promise<LeadListItem[]> {
  const where: SQL[] = [];
  if (opts.status && isLeadStatus(opts.status)) where.push(eq(salesLeads.status, opts.status));
  const q = opts.q?.trim().slice(0, 100);
  if (q) {
    const pat = `%${escapeLike(q)}%`;
    where.push(or(ilike(salesLeads.name, pat), ilike(salesLeads.email, pat), ilike(salesLeads.city, pat), ilike(salesLeads.zip, pat), ilike(salesLeads.contactPerson, pat))!);
  }
  const rows = await db
    .select({ lead: salesLeads, suppressed: sql<boolean>`exists (select 1 from ${salesSuppressions} s where s.email = lower(${salesLeads.email}))` })
    .from(salesLeads)
    .where(where.length ? and(...where) : undefined)
    .orderBy(sql`${salesLeads.distanceKm} asc nulls last`, asc(salesLeads.name))
    .limit(1000);
  return rows.map((r) => ({ ...r.lead, suppressed: Boolean(r.suppressed) }));
}

export async function statusCounts(): Promise<Record<string, number>> {
  const rows = await db.select({ status: salesLeads.status, n: count() }).from(salesLeads).groupBy(salesLeads.status);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

export async function getLead(id: string): Promise<{ lead: Lead; sends: SalesSend[]; suppressed: boolean } | null> {
  const [lead] = await db.select().from(salesLeads).where(eq(salesLeads.id, id));
  if (!lead) return null;
  const sends = await db.select().from(salesSends).where(eq(salesSends.leadId, id)).orderBy(asc(salesSends.sentAt));
  const suppressed = lead.email ? (await db.select({ e: salesSuppressions.email }).from(salesSuppressions).where(eq(salesSuppressions.email, normalizeEmail(lead.email)))).length > 0 : false;
  return { lead, sends, suppressed };
}

async function assertNoDuplicate(input: LeadInput, exceptId?: string) {
  if (input.email) {
    const dup = await db
      .select({ id: salesLeads.id })
      .from(salesLeads)
      .where(and(sql`lower(${salesLeads.email}) = ${normalizeEmail(input.email)}`, exceptId ? sql`${salesLeads.id} <> ${exceptId}` : undefined));
    if (dup.length) throw new Error("Diese E-Mail-Adresse ist bereits bei einer anderen Praxis eingetragen.");
  }
}

export async function createLead(adminUserId: string, input: LeadInput): Promise<string> {
  await assertNoDuplicate(input);
  const [row] = await db.insert(salesLeads).values({ ...input, email: input.email ? normalizeEmail(input.email) : null }).returning({ id: salesLeads.id });
  await audit({ userId: adminUserId, action: "vertrieb.lead_created", entity: "sales_lead", entityId: row.id });
  return row.id;
}

export async function updateLead(adminUserId: string, id: string, input: LeadInput) {
  await assertNoDuplicate(input, id);
  const r = await db
    .update(salesLeads)
    .set({ ...input, email: input.email ? normalizeEmail(input.email) : null, updatedAt: new Date() })
    .where(eq(salesLeads.id, id))
    .returning({ id: salesLeads.id });
  if (!r.length) throw new Error("Eintrag nicht gefunden.");
  await audit({ userId: adminUserId, action: "vertrieb.lead_updated", entity: "sales_lead", entityId: id });
}

/** Status setzen. „abgemeldet“ trägt die Adresse zusätzlich in die Sperrliste ein. */
export async function setLeadStatus(adminUserId: string, id: string, status: LeadStatus) {
  if (!isLeadStatus(status)) throw new Error("Status ungültig.");
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(salesLeads).where(eq(salesLeads.id, id)).for("update");
    if (!before) throw new Error("Eintrag nicht gefunden.");
    if (status === "abgemeldet" && before.email) {
      await tx.insert(salesSuppressions).values({ email: normalizeEmail(before.email), reason: "manuell" }).onConflictDoNothing();
    }
    await tx.update(salesLeads).set({ status, updatedAt: new Date() }).where(eq(salesLeads.id, id));
    await audit({ userId: adminUserId, action: "vertrieb.status", entity: "sales_lead", entityId: id, meta: { from: before.status, to: status } }, tx);
  });
}

export async function deleteLead(adminUserId: string, id: string) {
  const r = await db.delete(salesLeads).where(eq(salesLeads.id, id)).returning({ id: salesLeads.id, step: salesLeads.step });
  if (!r.length) throw new Error("Eintrag nicht gefunden.");
  await audit({ userId: adminUserId, action: "vertrieb.lead_deleted", entity: "sales_lead", entityId: id, meta: { step: r[0].step } });
}

// ───────────── Sperrliste ─────────────

export async function listSuppressions() {
  return db.select().from(salesSuppressions).orderBy(desc(salesSuppressions.createdAt)).limit(500);
}

export async function addSuppression(adminUserId: string, email: string) {
  const e = normalizeEmail(email);
  if (!isEmail(e)) throw new Error("Bitte eine gültige E-Mail-Adresse angeben.");
  await db.transaction(async (tx) => {
    await tx.insert(salesSuppressions).values({ email: e, reason: "manuell" }).onConflictDoNothing();
    await tx.update(salesLeads).set({ status: "abgemeldet", updatedAt: new Date() }).where(and(sql`lower(${salesLeads.email}) = ${e}`, sql`${salesLeads.status} <> 'kunde'`));
    await audit({ userId: adminUserId, action: "vertrieb.suppression_added", entity: "sales_suppression" }, tx);
  });
}

async function suppressedSet(emails: string[]): Promise<Set<string>> {
  const list = [...new Set(emails.map(normalizeEmail))];
  if (!list.length) return new Set();
  const rows = await db.select({ e: salesSuppressions.email }).from(salesSuppressions).where(inArray(salesSuppressions.email, list));
  return new Set(rows.map((r) => r.e));
}

// ───────────── CSV-Import ─────────────

export type ImportPreview = { decisions: ImportDecision[]; newCount: number; skippedCount: number; error?: string };

export async function previewImport(csv: string): Promise<ImportPreview> {
  const parsed = parseLeadCsv(csv);
  if (parsed.error) return { decisions: [], newCount: 0, skippedCount: 0, error: parsed.error };
  const existing = await db.select({ email: salesLeads.email, name: salesLeads.name, zip: salesLeads.zip }).from(salesLeads);
  const emails = parsed.rows.flatMap((r) => ("lead" in r && r.lead.email ? [r.lead.email] : []));
  const decisions = dedupeLeads(parsed.rows, {
    emails: new Set(existing.flatMap((e) => (e.email ? [normalizeEmail(e.email)] : []))),
    nameZips: new Set(existing.map((e) => nameZipKey(e.name, e.zip))),
    suppressed: await suppressedSet(emails),
  });
  const newCount = decisions.filter((d) => d.action === "neu").length;
  return { decisions, newCount, skippedCount: decisions.length - newCount };
}

export async function importLeads(adminUserId: string, csv: string): Promise<{ imported: number; skipped: number; error?: string }> {
  return db.transaction(async (tx) => {
    // Parallele Importe nacheinander (Dublettenprüfung gegen den Bestand bleibt gültig)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('podo:vertrieb:import'))`);
    const p = await previewImport(csv);
    if (p.error) return { imported: 0, skipped: 0, error: p.error };
    const rows = p.decisions.flatMap((d) => (d.action === "neu" ? [d.lead] : []));
    if (rows.length) await tx.insert(salesLeads).values(rows.map((l) => ({ ...l, source: l.source ?? "CSV-Import" })));
    await audit({ userId: adminUserId, action: "vertrieb.import", entity: "sales_lead", meta: { imported: rows.length, skipped: p.skippedCount } }, tx);
    return { imported: rows.length, skipped: p.skippedCount };
  });
}

// ───────────── Versand ─────────────

export type SendPreview = {
  count: number;
  steps: Record<number, number>;
  skipped: { id: string; name: string; reason: string }[];
  dayLeft: number;
  first: { to: string; from: string; subject: string; text: string; step: number; leadName: string } | null;
  problems: string[];
};

async function sentLast24h(now: Date, tx: Tx | typeof db = db): Promise<number> {
  const [r] = await tx
    .select({ n: count() })
    .from(salesSends)
    .where(and(eq(salesSends.ok, true), gte(salesSends.sentAt, new Date(now.getTime() - 86_400_000))));
  return Number(r?.n ?? 0);
}

function mailFor(lead: Lead, step: number, s: SalesSettings, env: Record<string, string | undefined>) {
  const replyTo = s.replyTo || s.senderEmail;
  return composeMail({
    template: s.templates[step - 1],
    lead,
    senderName: s.senderName,
    impressum: s.impressum,
    unsubscribeUrl: unsubscribeUrl(lead.id, env.PUBLIC_URL),
    unsubscribeMailto: isEmail(replyTo) ? replyTo : null,
  });
}

const uniqueIds = (ids: string[]) => [...new Set(ids)].slice(0, 500);

/** Vorschau: genau das, was ein Klick jetzt senden würde (Anzahl, Gründe fürs Überspringen, erste Mail). */
export async function previewSend(ids: string[], deps: { now?: Date; env?: Record<string, string | undefined> } = {}): Promise<SendPreview> {
  const now = deps.now ?? new Date();
  const env = deps.env ?? process.env;
  const s = await getSalesSettings();
  const leads = ids.length ? await db.select().from(salesLeads).where(inArray(salesLeads.id, uniqueIds(ids))) : [];
  const ordered = uniqueIds(ids).flatMap((id) => leads.filter((l) => l.id === id));
  const plan = planBatch(ordered, { now, delays: s.delays, suppressed: await suppressedSet(ordered.flatMap((l) => (l.email ? [l.email] : []))), sentLast24h: await sentLast24h(now) });
  const problems = settingsProblems(s, env);
  const f = plan.send[0];
  let first: SendPreview["first"] = null;
  if (f && !problems.length) {
    const m = mailFor(f.lead, f.step, s, env);
    first = { to: f.lead.email!, from: formatFrom(s.senderName, s.senderEmail), subject: m.subject, text: m.text, step: f.step, leadName: f.lead.name };
  }
  const steps: Record<number, number> = {};
  for (const x of plan.send) steps[x.step] = (steps[x.step] ?? 0) + 1;
  return { count: plan.send.length, steps, skipped: plan.skipped.map((x) => ({ id: x.lead.id, name: x.lead.name, reason: x.reason })), dayLeft: plan.dayLeft, first, problems };
}

export type SendResult = { sent: number; failed: { name: string; error: string }[]; skipped: number; mock: boolean };

/**
 * Sendet für die ausgewählten Leads die jeweils nächste fällige Mail. Alles wird unter einer Sperre erneut geprüft
 * (Doppelklick/zweiter Tab sendet nicht doppelt, Tageslimit gilt über alle Klicks). Je Mail eine Zeile in sales_sends.
 */
export async function sendNextMails(
  adminUserId: string,
  ids: string[],
  deps: { port?: MailPort; now?: () => Date; env?: Record<string, string | undefined> } = {},
): Promise<SendResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const s = await getSalesSettings();
  const problems = settingsProblems(s, env);
  if (problems.length) throw new Error(problems.join(" "));
  const port = deps.port ?? platformMailPort(env);
  if (port.isMock && env.NODE_ENV === "production") throw new MailNotConfiguredError("Vertriebsmails: in Produktion ist kein echter Versand eingerichtet (SMTP_URL).");
  const from = formatFrom(s.senderName, s.senderEmail);
  const replyTo = s.replyTo || s.senderEmail;

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('podo:vertrieb:send'))`);
    const list = uniqueIds(ids);
    const leads = list.length ? await tx.select().from(salesLeads).where(inArray(salesLeads.id, list)).for("update") : [];
    const ordered = list.flatMap((id) => leads.filter((l) => l.id === id));
    const emails = ordered.flatMap((l) => (l.email ? [normalizeEmail(l.email)] : []));
    const supp = emails.length ? await tx.select({ e: salesSuppressions.email }).from(salesSuppressions).where(inArray(salesSuppressions.email, [...new Set(emails)])) : [];
    const plan = planBatch(ordered, { now: now(), delays: s.delays, suppressed: new Set(supp.map((r) => r.e)), sentLast24h: await sentLast24h(now(), tx) });
    const out: SendResult = { sent: 0, failed: [], skipped: plan.skipped.length, mock: port.isMock };
    for (const { lead, step } of plan.send) {
      const m = mailFor(lead, step, s, env);
      try {
        const r = await port.send({ to: lead.email!, from, replyTo, subject: m.subject, text: m.text, headers: m.headers });
        const at = now();
        await tx.insert(salesSends).values({ leadId: lead.id, step, ok: true, mock: port.isMock, messageId: r.messageId.slice(0, 250), sentBy: adminUserId, sentAt: at });
        await tx
          .update(salesLeads)
          .set({ step, lastSentAt: at, status: lead.status === "neu" ? "in_sequenz" : lead.status, updatedAt: at })
          .where(eq(salesLeads.id, lead.id));
        out.sent++;
      } catch (e) {
        const err = toMailError(e).message.slice(0, 300);
        await tx.insert(salesSends).values({ leadId: lead.id, step, ok: false, mock: port.isMock, error: err, sentBy: adminUserId, sentAt: now() });
        out.failed.push({ name: lead.name, error: err });
      }
    }
    await audit(
      { userId: adminUserId, action: "vertrieb.send", entity: "sales_lead", meta: { sent: out.sent, failed: out.failed.length, skipped: out.skipped, mock: port.isMock, leads: plan.send.map((x) => ({ id: x.lead.id, step: x.step })) } },
      tx,
    );
    return out;
  });
  return result;
}

export async function sendStats(now = new Date()) {
  return { sentLast24h: await sentLast24h(now), maxPerDay: MAX_PER_DAY, maxPerClick: MAX_PER_CLICK };
}

// ───────────── Abmeldung (öffentlich, per signiertem Token) ─────────────

/**
 * Abmeldung über den Link in der Mail. Gibt nur „gültig/ungültig“ zurück – nie Daten des Leads.
 * Gelöschter Lead: gültig, aber nichts mehr zu tun (es wird ohnehin nicht mehr angeschrieben).
 */
export async function unsubscribeByToken(token: string): Promise<boolean> {
  let leadId: string | null = null;
  try {
    leadId = verifyUnsubscribeToken(token);
  } catch {
    leadId = null;
  }
  if (!leadId) return false;
  const id = leadId;
  await db.transaction(async (tx) => {
    const [lead] = await tx.select({ email: salesLeads.email, status: salesLeads.status }).from(salesLeads).where(eq(salesLeads.id, id)).for("update");
    if (!lead) return;
    if (lead.email) await tx.insert(salesSuppressions).values({ email: normalizeEmail(lead.email), reason: "abgemeldet" }).onConflictDoNothing();
    if (lead.status !== "abgemeldet") {
      await tx.update(salesLeads).set({ status: "abgemeldet", updatedAt: new Date() }).where(eq(salesLeads.id, id));
      await audit({ action: "vertrieb.unsubscribe", entity: "sales_lead", entityId: id, meta: { from: lead.status } }, tx);
    }
  });
  return true;
}
