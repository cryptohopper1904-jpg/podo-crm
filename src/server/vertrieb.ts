import "server-only";
import { and, asc, count, eq, gte, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { promoCodes, salesCampaigns, salesLeadEvents, salesLeads, salesSends, salesSettings } from "@/db/schema";
import { formatFrom, isEmail, MailNotConfiguredError, parseFrom, toMailError, type MailPort } from "@/integrations/mail/mail";
import { audit } from "@/lib/audit";
import { dateDe } from "@/lib/format";
import { DEFAULT_DELAYS, DEFAULT_TEMPLATES, MAX_PER_CLICK, MAX_PER_DAY, SEQUENCE_STEPS, isLeadStatus, type LeadStatus, type Template } from "@/lib/vertrieb/constants";
import { dedupeLeads, nameZipKey, parseLeadCsv, type ImportDecision, type LeadInput } from "@/lib/vertrieb/csv";
import { CHANNEL_LABEL, checkRetrievedDate, CONSENT_KIND_LABEL, CONSENT_RETENTION_MONTHS, DELETE_MONTHS, deleteAfterFor, deleteMonthsOf, isConsentChannel, isConsentKind, DELETE_MIN_LEAD_DAYS, isDeleteMonths, isExistingCustomerForRetention, REACTION_RETENTION_MONTHS, type ConsentChannel, type ConsentKind } from "@/lib/vertrieb/dsgvo";
import { normalizeEmail, planBatch, type Delays } from "@/lib/vertrieb/eligibility";
import { deriveStage } from "@/lib/vertrieb/pipeline";
import { composeMail, templateUsesPromo, validateTemplate, type PromoValues } from "@/lib/vertrieb/template";
import { promoLandingUrl } from "@/lib/promo-codes";
import { usableCodesFor } from "./promo-codes";
import { websiteHostKey } from "@/lib/vertrieb/lead-search";
import { addLeadToBlocklist, addToBlocklist, assertBlocklistKey, blockedEmails, blocklistKeyProblem, blocklistMatcher, blocklistOverview, isBlocked } from "./blocklist";
import { unsubscribeUrl, verifyUnsubscribeToken } from "@/lib/vertrieb/unsubscribe-token";
import { platformMailPort } from "./mail";

/**
 * Vertrieb des Plattform-Betreibers (kleines CRM für die Ansprache von Praxen per E-Mail-Sequenz).
 * - Kein Mandantenbezug: Tabellen sales_* ohne organization_id/RLS, Zugriff NUR über diese Datei.
 *   Aufrufer (Server Actions/Seiten unter /plattform/vertrieb) prüfen vorher requirePlatformAdmin() (Admin + 2FA).
 * - § 7 Abs. 2 Nr. 2 UWG: gesendet wird NUR an Leads mit gültiger E-Mail-Einwilligung (consent_at + Vermerk, nicht
 *   widerrufen), geprüft in eligibility() unter der Versandsperre. Die Einwilligung gilt für die Adresse: ändert sich die
 *   E-Mail, wird sie entfernt. Telefon-Einwilligung getrennt (§ 7 Abs. 2 Nr. 1 UWG): nur sie gibt die Telefonnummer frei.
 * - Versand nur manuell, in kleinen Mengen (MAX_PER_CLICK, MAX_PER_DAY), mit Vorschau, Abmeldelink,
 *   List-Unsubscribe-Kopfzeilen und Sperrliste. Keine Automatik/Cron (nur die Praxissuche läuft nachts, ohne Versand).
 * - Kampagnen (sales_campaigns): eigene Vorlagen-Variante und Aktionscode für {{code}}/{{link}}; ohne gültigen Code
 *   wird ein Lead mit solcher Vorlage übersprungen (nie eine Mail mit leerem Code).
 * - Abmeldung/Widerspruch (Link, Status „abgemeldet“, Sperrliste): Lead samt Verlauf wird GELÖSCHT, nur der Prüfwert
 *   der Adresse bleibt auf der Sperrliste (src/server/blocklist.ts); Versandzeilen bleiben ohne Bezug und ohne Mailangaben
 *   (Tageslimit).
 * - Audit: Import, Versand, Statuswechsel, Einstellungen, Löschen, Abmeldung (ohne Mailinhalte).
 * - Rechtsprüfung (src/lib/vertrieb/dsgvo.ts): Quelle + Abrufdatum Pflicht beim Anlegen und Import; Löschfrist
 *   delete_after (6–12 Monate ab Erhebung, Standard 12), abgelaufene Einträge ohne gültige Einwilligung löscht
 *   purgeStaleLeads(), außer bei Bestandskunden (isExistingCustomerForRetention); Einwilligung je Kanal mit Datum, Erteilungsweg,
 *   Wortlaut/Nachweis und Widerruf.
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
  /** Betreiber hat bestätigt: Versanddienstleister mit AVV ist eingetragen (Unterauftragnehmer) – sonst kein Versand */
  mailProcessorConfirmed: boolean;
  /** true, wenn noch nie gespeichert (Werte = Standard) */
  isDefault: boolean;
};

function envSender(env: Record<string, string | undefined> = process.env) {
  const f = parseFrom(env.SMTP_FROM);
  return { name: f?.name ?? "", address: f?.address ?? "" };
}

export const validTemplates = (t: unknown): Template[] | null =>
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
    mailProcessorConfirmed: row?.mailProcessorConfirmed ?? false,
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
  if (!s.mailProcessorConfirmed) p.push("Versanddienstleister mit AVV ist nicht bestätigt (Unterauftragnehmer eintragen, dann in den Einstellungen bestätigen).");
  if (env.NODE_ENV === "production" && !/^https:\/\//.test(env.PUBLIC_URL ?? "")) p.push("PUBLIC_URL (https) ist nicht gesetzt – der Abmeldelink wäre ungültig.");
  s.templates.forEach((t, i) => {
    const e = validateTemplate(t);
    if (e) p.push(`Vorlage Mail ${i + 1}: ${e}`);
  });
  return p;
}

export type SettingsInput = { senderName: string; senderEmail: string; replyTo: string; impressum: string; delay2Days: number; delay3Days: number; mailProcessorConfirmed: boolean };

export async function saveSalesSettings(adminUserId: string, input: SettingsInput) {
  const v = {
    senderName: input.senderName.replace(/[\r\n"<>]/g, "").trim().slice(0, 80),
    senderEmail: input.senderEmail.trim().slice(0, 254),
    replyTo: input.replyTo.trim().slice(0, 254),
    impressum: input.impressum.replace(/\r\n?/g, "\n").trim().slice(0, 1500),
    delay2Days: input.delay2Days,
    delay3Days: input.delay3Days,
    mailProcessorConfirmed: input.mailProcessorConfirmed === true,
  };
  if (v.senderEmail && !isEmail(v.senderEmail)) throw new Error("Absender-E-Mail ist ungültig.");
  if (v.replyTo && !isEmail(v.replyTo)) throw new Error("Antwortadresse ist ungültig.");
  for (const d of [v.delay2Days, v.delay3Days]) if (!Number.isInteger(d) || d < 1 || d > 60) throw new Error("Abstände: 1 bis 60 Tage.");
  await db
    .insert(salesSettings)
    .values({ id: 1, ...v, updatedBy: adminUserId })
    .onConflictDoUpdate({ target: salesSettings.id, set: { ...v, updatedBy: adminUserId, updatedAt: new Date() } });
  await audit({ userId: adminUserId, action: "vertrieb.settings", entity: "sales_settings", meta: { senderEmail: v.senderEmail, replyTo: v.replyTo || null, delays: [v.delay2Days, v.delay3Days], mailProcessorConfirmed: v.mailProcessorConfirmed } });
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
    .select()
    .from(salesLeads)
    .where(where.length ? and(...where) : undefined)
    .orderBy(sql`${salesLeads.distanceKm} asc nulls last`, asc(salesLeads.name))
    .limit(1000);
  const blocked = await blockedEmails(rows.flatMap((r) => (r.email ? [r.email] : [])));
  return rows.map((r) => ({ ...r, suppressed: !!r.email && blocked.has(normalizeEmail(r.email)) }));
}

export async function statusCounts(): Promise<Record<string, number>> {
  const rows = await db.select({ status: salesLeads.status, n: count() }).from(salesLeads).groupBy(salesLeads.status);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

export async function getLead(id: string): Promise<{ lead: Lead; sends: SalesSend[]; suppressed: boolean } | null> {
  const [lead] = await db.select().from(salesLeads).where(eq(salesLeads.id, id));
  if (!lead) return null;
  const sends = await db.select().from(salesSends).where(eq(salesSends.leadId, id)).orderBy(asc(salesSends.sentAt));
  const suppressed = lead.email ? await isBlocked(lead.email) : false;
  return { lead, sends, suppressed };
}

/**
 * Dubletten und Sperrliste (Adresse, Website-Host, Name+PLZ; fail-closed bei falschem Sperrlisten-Schlüssel).
 * `previous`: beim Bearbeiten – unveränderte Angaben (z. B. eines Kunden mit gesperrter Adresse) bleiben erlaubt.
 */
async function assertNoDuplicate(input: LeadInput, exceptId?: string, previous?: { email: string | null; website: string | null; name: string; zip: string | null }) {
  await assertBlocklistKey();
  const blocked = await blocklistMatcher();
  const sameHost = previous && websiteHostKey(previous.website) === websiteHostKey(input.website);
  if (!sameHost && blocked.hasHost(input.website)) throw new Error("Diese Website gehört zu einer Praxis auf der Sperrliste (Abmeldung/Widerspruch) und kann nicht eingetragen werden.");
  const sameNameZip = previous && nameZipKey(previous.name, previous.zip) === nameZipKey(input.name, input.zip);
  if (!sameNameZip && blocked.hasNameZip(input.name, input.zip)) throw new Error("Diese Praxis (Name und PLZ) steht auf der Sperrliste (Abmeldung/Widerspruch) und kann nicht eingetragen werden.");
  const previousEmail = previous?.email;
  if (input.email) {
    const unchanged = previousEmail != null && normalizeEmail(previousEmail) === normalizeEmail(input.email);
    if (!unchanged && (await isBlocked(input.email))) throw new Error("Diese Adresse steht auf der Sperrliste (Abmeldung/Widerspruch) und kann nicht eingetragen werden.");
    const dup = await db
      .select({ id: salesLeads.id })
      .from(salesLeads)
      .where(and(sql`lower(${salesLeads.email}) = ${normalizeEmail(input.email)}`, exceptId ? sql`${salesLeads.id} <> ${exceptId}` : undefined));
    if (dup.length) throw new Error("Diese E-Mail-Adresse ist bereits bei einer anderen Praxis eingetragen.");
  }
}

/**
 * Herkunft ist Pflicht (Art. 14 DSGVO): Quelle (mind. 3 Zeichen) und Abrufdatum (nicht in der Zukunft).
 * `allowMissingDate`: beim Bearbeiten eines Eintrags ohne gespeichertes Abrufdatum darf es leer bleiben (kein erfundenes Datum).
 */
function assertOrigin(input: LeadInput, now: Date, allowMissingDate = false): LeadInput {
  const source = input.source?.replace(/[\r\n]+/g, " ").trim().slice(0, 200) ?? "";
  if (source.length < 3) throw new Error("Bitte die Quelle der Daten angeben (z. B. „OpenStreetMap“ oder „Impressum praxis-muster.example“).");
  if (allowMissingDate && !input.sourceRetrievedAt?.trim()) return { ...input, source, sourceRetrievedAt: null };
  const d = checkRetrievedDate(input.sourceRetrievedAt ?? "", now);
  if (!d.ok) throw new Error(d.error);
  return { ...input, source, sourceRetrievedAt: d.date };
}

export type LeadOptions = {
  /** Löschfrist in Monaten ab Erhebung (6–12); fehlt = Standard 12 bzw. beim Bearbeiten unverändert */
  deleteMonths?: number | null;
  /** Telefonnummer war im Formular ausgeblendet (keine Einwilligung): leeres Feld = Nummer behalten */
  phoneHidden?: boolean;
  /** ausgeblendete Telefonnummer ausdrücklich löschen */
  clearPhone?: boolean;
};

function checkMonths(m: number | null | undefined): number | null {
  if (m === null || m === undefined) return null;
  if (!isDeleteMonths(m)) throw new Error(`Löschfrist: ${DELETE_MONTHS.min} bis ${DELETE_MONTHS.max} Monate.`);
  return m;
}

/**
 * Neue Löschfrist beim Bearbeiten: nicht in der Vergangenheit (mindestens heute + 7 Tage) und beim Altbestand nie vor dem
 * bisherigen Löschdatum (Schonfrist). Sonst Fehler mit Hinweis auf „Löschen“.
 */
function checkNewDeleteAfter(next: Date, before: { deleteAfter: Date; legacy: boolean }, now: Date): Date {
  if (before.legacy && next.getTime() < before.deleteAfter.getTime()) {
    throw new Error("Altbestand: Die Löschung kann nicht vorgezogen werden. Zum früheren Löschen bitte „Löschen“ verwenden.");
  }
  if (next.getTime() < now.getTime() + DELETE_MIN_LEAD_DAYS * 86_400_000) {
    throw new Error(`Die neue Löschfrist läge vor dem ${dateDe(new Date(now.getTime() + DELETE_MIN_LEAD_DAYS * 86_400_000))}. Bitte eine längere Frist wählen – zum früheren Löschen „Löschen“ verwenden.`);
  }
  return next;
}

export async function createLead(adminUserId: string, input: LeadInput, opts: LeadOptions = {}, now = new Date()): Promise<string> {
  const clean = assertOrigin(input, now);
  const months = checkMonths(opts.deleteMonths) ?? DELETE_MONTHS.default;
  await assertNoDuplicate(clean);
  const [row] = await db
    .insert(salesLeads)
    .values({ ...clean, email: clean.email ? normalizeEmail(clean.email) : null, createdAt: now, updatedAt: now, deleteAfter: deleteAfterFor(now, months) })
    .returning({ id: salesLeads.id });
  await audit({ userId: adminUserId, action: "vertrieb.lead_created", entity: "sales_lead", entityId: row.id, meta: { deleteMonths: months } });
  return row.id;
}

export async function updateLead(adminUserId: string, id: string, rawInput: LeadInput, opts: LeadOptions = {}, now = new Date()) {
  const months = checkMonths(opts.deleteMonths);
  const [prev] = await db
    .select({ email: salesLeads.email, website: salesLeads.website, name: salesLeads.name, zip: salesLeads.zip, sourceRetrievedAt: salesLeads.sourceRetrievedAt })
    .from(salesLeads)
    .where(eq(salesLeads.id, id));
  if (!prev) throw new Error("Eintrag nicht gefunden.");
  const input = assertOrigin(rawInput, now, prev.sourceRetrievedAt === null);
  await assertNoDuplicate(input, id, prev);
  const email = input.email ? normalizeEmail(input.email) : null;
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ email: salesLeads.email, consentAt: salesLeads.consentEmailAt, createdAt: salesLeads.createdAt, deleteAfter: salesLeads.deleteAfter, legacy: salesLeads.deleteAfterLegacy })
      .from(salesLeads)
      .where(eq(salesLeads.id, id))
      .for("update");
    if (!before) throw new Error("Eintrag nicht gefunden.");
    // unveränderte Frist (Formular schickt die aktuelle Auswahl mit) → nichts prüfen, nichts ändern
    const unchanged = !!months && !before.legacy && deleteMonthsOf(before.createdAt, before.deleteAfter) === months;
    const newDeleteAfter = months && !unchanged ? checkNewDeleteAfter(deleteAfterFor(before.createdAt, months), before, now) : null;
    // E-Mail-Einwilligung gilt für die bisherige Adresse – bei neuer Adresse entfernen
    const consentLost = !!before.consentAt && (before.email ? normalizeEmail(before.email) : null) !== email;
    // ausgeblendete Telefonnummer (ohne Einwilligung) bleibt erhalten, wenn das Feld leer ankommt
    const { phone, ...rest } = input;
    const keepPhone = opts.phoneHidden && !phone && !opts.clearPhone;
    await tx
      .update(salesLeads)
      .set({
        ...rest,
        ...(keepPhone ? {} : { phone }),
        email,
        ...(consentLost ? { consentEmailAt: null, consentEmailNote: null, consentEmailKind: null, consentEmailRevokedAt: null } : {}),
        ...(newDeleteAfter ? { deleteAfter: newDeleteAfter, deleteAfterLegacy: false } : {}),
        updatedAt: now,
      })
      .where(eq(salesLeads.id, id));
    if (consentLost) await tx.insert(salesLeadEvents).values({ leadId: id, kind: "consent", text: null, meta: { removed: true, channel: "email", reason: "E-Mail geändert" }, createdBy: adminUserId });
    const meta = { ...(consentLost ? { consentRemoved: true } : {}), ...(newDeleteAfter ? { deleteMonths: months } : {}) };
    await audit({ userId: adminUserId, action: "vertrieb.lead_updated", entity: "sales_lead", entityId: id, meta: Object.keys(meta).length ? meta : undefined }, tx);
  });
}

export type ConsentInput = {
  /** Kanal, für den die Einwilligung gilt (E-Mail oder Telefon) */
  channel: ConsentChannel;
  /** Wortlaut bzw. Nachweis (Pflicht, 3–500 Zeichen) */
  note: string;
  /** Erteilungsweg (CONSENT_KINDS) */
  kind: ConsentKind;
  /** Datum der Einwilligung YYYY-MM-DD (nicht in der Zukunft) */
  date: string;
};

/**
 * Einwilligung für GENAU EINEN Lead und EINEN Kanal dokumentieren: Datum, Erteilungsweg und Wortlaut/Nachweis sind Pflicht.
 * Bewusst keine Sammelaktion: jede Einwilligung wird einzeln mit ihrem Nachweis erfasst. E-Mail nur mit E-Mail-Adresse.
 * Ein früherer Widerruf desselben Kanals wird durch die neue Einwilligung ersetzt.
 */
export async function recordLeadConsent(adminUserId: string, id: string, input: ConsentInput, now = new Date()): Promise<boolean> {
  if (!isConsentChannel(input.channel)) throw new Error("Bitte den Kanal der Einwilligung angeben.");
  const note = input.note.replace(/[\r\n]+/g, " ").trim().slice(0, 500);
  if (note.length < 3) throw new Error("Bitte Wortlaut bzw. Nachweis der Einwilligung angeben.");
  if (!isConsentKind(input.kind)) throw new Error("Bitte die Art der Einwilligung auswählen.");
  const d = checkRetrievedDate(input.date, now);
  if (!d.ok) throw new Error(d.error.replace("Abrufdatum der Quelle", "Datum der Einwilligung").replace("Abrufdatum", "Datum der Einwilligung"));
  const at = consentTime(d.date, now);
  const email = input.channel === "email";
  return db.transaction(async (tx) => {
    const changed = await tx
      .update(salesLeads)
      .set(
        email
          ? { consentEmailAt: at, consentEmailNote: note, consentEmailKind: input.kind, consentEmailRevokedAt: null, updatedAt: now }
          : { consentPhoneAt: at, consentPhoneNote: note, consentPhoneKind: input.kind, consentPhoneRevokedAt: null, updatedAt: now },
      )
      .where(and(eq(salesLeads.id, id), email ? sql`${salesLeads.email} is not null` : undefined))
      .returning({ id: salesLeads.id });
    if (!changed.length) return false;
    await tx.insert(salesLeadEvents).values({
      leadId: id,
      kind: "consent",
      text: note,
      meta: { channel: input.channel, channelLabel: CHANNEL_LABEL[input.channel], kind: input.kind, kindLabel: CONSENT_KIND_LABEL[input.kind], date: at.toISOString() },
      createdBy: adminUserId,
      createdAt: now,
    });
    await audit({ userId: adminUserId, action: "vertrieb.consent_recorded", entity: "sales_lead", meta: { leads: [id], channel: input.channel, kind: input.kind } }, tx);
    return true;
  });
}

/**
 * Einwilligung widerrufen (auch für mehrere Leads): setzt das Widerrufsdatum, der Nachweis der Erteilung bleibt erhalten.
 * `channel` „alle“ = E-Mail und Telefon. Gibt die Anzahl betroffener Leads zurück.
 */
export async function removeLeadConsent(adminUserId: string, ids: string[], now = new Date(), channel: ConsentChannel | "alle" = "alle"): Promise<number> {
  const list = [...new Set(ids)].slice(0, 500);
  if (!list.length) return 0;
  const channels: ConsentChannel[] = channel === "alle" ? ["email", "phone"] : [channel];
  return db.transaction(async (tx) => {
    const affected = new Set<string>();
    const events: (typeof salesLeadEvents.$inferInsert)[] = [];
    for (const ch of channels) {
      const rows =
        ch === "email"
          ? await tx
              .update(salesLeads)
              .set({ consentEmailRevokedAt: now, updatedAt: now })
              .where(and(inArray(salesLeads.id, list), sql`${salesLeads.consentEmailAt} is not null and ${salesLeads.consentEmailRevokedAt} is null`))
              .returning({ id: salesLeads.id })
          : await tx
              .update(salesLeads)
              .set({ consentPhoneRevokedAt: now, updatedAt: now })
              .where(and(inArray(salesLeads.id, list), sql`${salesLeads.consentPhoneAt} is not null and ${salesLeads.consentPhoneRevokedAt} is null`))
              .returning({ id: salesLeads.id });
      for (const r of rows) {
        affected.add(r.id);
        events.push({ leadId: r.id, kind: "consent", text: null, meta: { removed: true, channel: ch, channelLabel: CHANNEL_LABEL[ch], revokedAt: now.toISOString() }, createdBy: adminUserId, createdAt: now });
      }
    }
    if (events.length) await tx.insert(salesLeadEvents).values(events);
    await audit({ userId: adminUserId, action: "vertrieb.consent_removed", entity: "sales_lead", meta: { leads: [...affected], channels } }, tx);
    return affected.size;
  });
}

/** Zeitpunkt der Einwilligung aus dem Datum: 12:00 UTC des Tages, höchstens jetzt (heute erteilt). */
const consentTime = (date: string, now: Date) => new Date(Math.min(Date.parse(`${date}T12:00:00Z`), now.getTime()));

/**
 * Erstbrief mit Datenschutzhinweis (Art. 14 DSGVO) als versendet vermerken (Datum YYYY-MM-DD, nicht in der Zukunft).
 * Kein Kontakt im Sinne der Löschregel (dort zählt nur eine Reaktion der Praxis).
 */
export async function recordArt14Notice(adminUserId: string, id: string, date: string, now = new Date()): Promise<boolean> {
  const d = checkRetrievedDate(date, now);
  if (!d.ok) throw new Error(d.error.replace("Abrufdatum der Quelle", "Versanddatum").replace("Abrufdatum", "Versanddatum"));
  return db.transaction(async (tx) => {
    const [row] = await tx.update(salesLeads).set({ art14NoticeAt: d.date }).where(eq(salesLeads.id, id)).returning({ id: salesLeads.id });
    if (!row) return false;
    await tx.insert(salesLeadEvents).values({ leadId: id, kind: "letter", text: null, meta: { date: d.date }, createdBy: adminUserId, createdAt: now });
    await audit({ userId: adminUserId, action: "vertrieb.art14_notice", entity: "sales_lead", entityId: id }, tx);
    return true;
  });
}

/**
 * Lead nach Abmeldung/Widerspruch löschen (Verlauf/Notizen per Kaskade). Versandzeilen bleiben für das Tageslimit,
 * aber ohne Bezug, Message-ID und Fehlertext. Die Adresse muss vorher auf die Sperrliste.
 */
async function deleteLeadsForOptOut(tx: Tx, ids: string[]) {
  if (!ids.length) return;
  await tx.update(salesSends).set({ messageId: null, error: null }).where(inArray(salesSends.leadId, ids));
  await anonymizeLeadCodes(tx, ids);
  await tx.delete(salesLeads).where(inArray(salesLeads.id, ids));
}

/**
 * Status setzen. „abgemeldet“: Adresse, Website und Name+PLZ als Prüfwerte auf die Sperrliste, Lead löschen („deleted“).
 */
export async function setLeadStatus(adminUserId: string, id: string, status: LeadStatus): Promise<"updated" | "deleted"> {
  if (!isLeadStatus(status)) throw new Error("Status ungültig.");
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(salesLeads).where(eq(salesLeads.id, id)).for("update");
    if (!before) throw new Error("Eintrag nicht gefunden.");
    if (status === "abgemeldet") {
      await addLeadToBlocklist(tx, before, "manuell");
      await deleteLeadsForOptOut(tx, [id]);
      await audit({ userId: adminUserId, action: "vertrieb.opt_out", entity: "sales_lead", entityId: id, meta: { from: before.status, via: "status", blocked: !!before.email } }, tx);
      return "deleted" as const;
    }
    await tx.update(salesLeads).set({ status, updatedAt: new Date() }).where(eq(salesLeads.id, id));
    if (before.status !== status) await tx.insert(salesLeadEvents).values({ leadId: id, kind: "status", meta: { from: before.status, to: status }, createdBy: adminUserId });
    await audit({ userId: adminUserId, action: "vertrieb.status", entity: "sales_lead", entityId: id, meta: { from: before.status, to: status } }, tx);
    return "updated" as const;
  });
}

/** Persönliche Aktionscodes gelöschter Leads: Bezeichnung kann den Praxisnamen enthalten → „(gelöscht)“ */
async function anonymizeLeadCodes(tx: Tx, ids: string[]) {
  if (ids.length) await tx.update(promoCodes).set({ label: "(gelöscht)" }).where(inArray(promoCodes.leadId, ids));
}

export async function deleteLead(adminUserId: string, id: string) {
  const r = await db.transaction(async (tx) => {
    await anonymizeLeadCodes(tx, [id]);
    return tx.delete(salesLeads).where(eq(salesLeads.id, id)).returning({ id: salesLeads.id, step: salesLeads.step });
  });
  if (!r.length) throw new Error("Eintrag nicht gefunden.");
  await audit({ userId: adminUserId, action: "vertrieb.lead_deleted", entity: "sales_lead", entityId: id, meta: { step: r[0].step } });
}

// ───────────── Sperrliste ─────────────

/** Sperrliste für die Konsole: nur Anzahl, Grund und Datum (Adressen sind nicht gespeichert). */
export const listSuppressions = blocklistOverview;

/** Adresse manuell sperren (Widerspruch per Mail/Telefon): Prüfwert speichern, passende Leads (außer Kunden) löschen. */
export async function addSuppression(adminUserId: string, email: string) {
  const e = normalizeEmail(email);
  if (!isEmail(e)) throw new Error("Bitte eine gültige E-Mail-Adresse angeben.");
  await db.transaction(async (tx) => {
    await addToBlocklist(tx, e, "widerspruch");
    const leads = await tx.select().from(salesLeads).where(and(sql`lower(${salesLeads.email}) = ${e}`, sql`${salesLeads.status} <> 'kunde'`)).for("update");
    for (const l of leads) await addLeadToBlocklist(tx, l, "widerspruch");
    await deleteLeadsForOptOut(tx, leads.map((l) => l.id));
    await audit({ userId: adminUserId, action: "vertrieb.suppression_added", entity: "sales_suppression", meta: { leadsDeleted: leads.length } }, tx);
  });
}

const suppressedSet = (emails: string[]) => blockedEmails(emails);

// ───────────── CSV-Import ─────────────

export type ImportPreview = { decisions: ImportDecision[]; newCount: number; skippedCount: number; error?: string };

export async function previewImport(csv: string, exec: Tx | typeof db = db): Promise<ImportPreview> {
  const keyProblem = await blocklistKeyProblem();
  if (keyProblem) return { decisions: [], newCount: 0, skippedCount: 0, error: keyProblem };
  const parsed = parseLeadCsv(csv);
  if (parsed.error) return { decisions: [], newCount: 0, skippedCount: 0, error: parsed.error };
  const existing = await db.select({ email: salesLeads.email, name: salesLeads.name, zip: salesLeads.zip }).from(salesLeads);
  const emails = parsed.rows.flatMap((r) => ("lead" in r && r.lead.email ? [r.lead.email] : []));
  const decisions = dedupeLeads(parsed.rows, {
    emails: new Set(existing.flatMap((e) => (e.email ? [normalizeEmail(e.email)] : []))),
    nameZips: new Set(existing.map((e) => nameZipKey(e.name, e.zip))),
    suppressed: await blockedEmails(emails, exec),
    blocked: await blocklistMatcher(exec),
  });
  const newCount = decisions.filter((d) => d.action === "neu").length;
  return { decisions, newCount, skippedCount: decisions.length - newCount };
}

/**
 * Import mit Pflichtangaben „Quelle der Daten“ (z. B. „OpenStreetMap“, „Impressum der Praxis-Websites“ – Art. 14 DSGVO)
 * und „Abrufdatum“; beides wird an jedem importierten Lead gespeichert (Quelle vor einer evtl. Quellen-Spalte der Datei,
 * Abrufdatum nur, wenn die Zeile kein eigenes retrieved_at hat). Löschfrist: Standard (Anlage + 12 Monate).
 */
export async function importLeads(adminUserId: string, csv: string, source: string, retrievedAt: string, now = new Date()): Promise<{ imported: number; skipped: number; error?: string }> {
  const src = source.replace(/[\r\n]+/g, " ").trim().slice(0, 120);
  if (src.length < 3) return { imported: 0, skipped: 0, error: "Bitte die Quelle der Daten angeben." };
  const retrieved = checkRetrievedDate(retrievedAt, now);
  if (!retrieved.ok) return { imported: 0, skipped: 0, error: retrieved.error };
  const keyProblem = await blocklistKeyProblem();
  if (keyProblem) return { imported: 0, skipped: 0, error: keyProblem };
  return db.transaction(async (tx) => {
    // Parallele Importe nacheinander (Dublettenprüfung gegen den Bestand bleibt gültig)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('podo:vertrieb:import'))`);
    await assertBlocklistKey(tx);
    const p = await previewImport(csv, tx);
    if (p.error) return { imported: 0, skipped: 0, error: p.error };
    const rows = p.decisions.flatMap((d) => (d.action === "neu" ? [d.lead] : []));
    if (rows.length) {
      await tx.insert(salesLeads).values(
        rows.map((l) => ({
          ...l,
          source: (l.source ? `${src} – ${l.source}` : src).slice(0, 200),
          sourceRetrievedAt: l.sourceRetrievedAt ?? retrieved.date,
          createdAt: now,
          updatedAt: now,
          deleteAfter: deleteAfterFor(now, DELETE_MONTHS.default),
        })),
      );
    }
    await audit({ userId: adminUserId, action: "vertrieb.import", entity: "sales_lead", meta: { imported: rows.length, skipped: p.skippedCount, source: src, retrievedAt: retrieved.date } }, tx);
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

/** Je Lead: Vorlagen (Kampagnen-Variante oder Standard) und Aktionscode (persönlich vor Kampagne). */
type MailContext = (lead: Lead) => { templates: Template[]; promo: PromoValues | null };

async function mailContext(leads: Lead[], s: SalesSettings, env: Record<string, string | undefined>, tx: Tx | typeof db = db, now = new Date()): Promise<MailContext> {
  const campaignIds = [...new Set(leads.flatMap((l) => (l.campaignId ? [l.campaignId] : [])))];
  const camps = campaignIds.length ? await tx.select({ id: salesCampaigns.id, templates: salesCampaigns.templates }).from(salesCampaigns).where(inArray(salesCampaigns.id, campaignIds)) : [];
  const tpl = new Map(camps.map((c) => [c.id, validTemplates(c.templates)]));
  const codes = await usableCodesFor({ campaignIds, leadIds: leads.map((l) => l.id) }, now);
  return (lead) => {
    const code = codes.byLead.get(lead.id) ?? (lead.campaignId ? codes.byCampaign.get(lead.campaignId) : undefined);
    return {
      templates: (lead.campaignId ? tpl.get(lead.campaignId) : null) ?? s.templates,
      promo: code ? { code, link: promoLandingUrl(env.PUBLIC_URL, code) } : null,
    };
  };
}

const PROMO_MISSING = "Vorlage nutzt {{code}}/{{link}}, aber es gibt keinen gültigen Aktionscode (Kampagne/Lead)";

function mailFor(lead: Lead, step: number, s: SalesSettings, env: Record<string, string | undefined>, ctx: MailContext) {
  const replyTo = s.replyTo || s.senderEmail;
  const c = ctx(lead);
  const template = c.templates[step - 1];
  if (templateUsesPromo(template) && !c.promo) return null;
  return composeMail({
    template,
    lead,
    senderName: s.senderName,
    impressum: s.impressum,
    unsubscribeUrl: unsubscribeUrl(lead.id, env.PUBLIC_URL),
    unsubscribeMailto: isEmail(replyTo) ? replyTo : null,
    promo: c.promo,
    privacyUrl: `${(env.PUBLIC_URL ?? "").replace(/\/+$/, "")}/datenschutz#vertrieb`,
    source: lead.source,
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
  const keyProblem = await blocklistKeyProblem();
  const problems = [...settingsProblems(s, env), ...(keyProblem ? [keyProblem] : [])];
  const ctx = await mailContext(ordered, s, env, db, now);
  const skipped = plan.skipped.map((x) => ({ id: x.lead.id, name: x.lead.name, reason: x.reason }));
  const send: { lead: Lead; step: number; mail: NonNullable<ReturnType<typeof mailFor>> }[] = [];
  for (const x of plan.send) {
    const mail = mailFor(x.lead, x.step, s, env, ctx);
    if (mail) send.push({ ...x, mail });
    else skipped.push({ id: x.lead.id, name: x.lead.name, reason: PROMO_MISSING });
  }
  const f = send[0];
  const first: SendPreview["first"] =
    f && !problems.length ? { to: f.lead.email!, from: formatFrom(s.senderName, s.senderEmail), subject: f.mail.subject, text: f.mail.text, step: f.step, leadName: f.lead.name } : null;
  const steps: Record<number, number> = {};
  for (const x of send) steps[x.step] = (steps[x.step] ?? 0) + 1;
  return { count: send.length, steps, skipped, dayLeft: plan.dayLeft, first, problems };
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
  // fail-closed: Sperrliste nur mit passendem Schlüssel wirksam
  await assertBlocklistKey();
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
    const supp = await blockedEmails(emails, tx);
    const plan = planBatch(ordered, { now: now(), delays: s.delays, suppressed: supp, sentLast24h: await sentLast24h(now(), tx) });
    const out: SendResult = { sent: 0, failed: [], skipped: plan.skipped.length, mock: port.isMock };
    const ctx = await mailContext(ordered, s, env, tx, now());
    const sentLeads: { id: string; step: number }[] = [];
    for (const { lead, step } of plan.send) {
      const m = mailFor(lead, step, s, env, ctx);
      if (!m) {
        out.skipped++;
        continue;
      }
      sentLeads.push({ id: lead.id, step });
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
      { userId: adminUserId, action: "vertrieb.send", entity: "sales_lead", meta: { sent: out.sent, failed: out.failed.length, skipped: out.skipped, mock: port.isMock, leads: sentLeads } },
      tx,
    );
    return out;
  });
  return result;
}

export async function sendStats(now = new Date()) {
  return { sentLast24h: await sentLast24h(now), maxPerDay: MAX_PER_DAY, maxPerClick: MAX_PER_CLICK };
}

// ───────────── Speicherdauer ─────────────

/** Speicherdauer (Datenschutzerklärung § 6a): ohne Einwilligung höchstens 12 Monate, mit Einwilligung 24 Monate nach der letzten Reaktion */
export const LEAD_RETENTION_MONTHS = { withoutConsent: REACTION_RETENTION_MONTHS, withConsent: CONSENT_RETENTION_MONTHS } as const;

/**
 * Nächtlicher Löschlauf (Cron /api/cron/lead-search). Bestandskunden (isExistingCustomerForRetention: Status „Kunde“ oder eine
 * zugeordnete registrierte Praxis in Stufe „Test“/„Kunde“) bleiben immer, die Sperrliste bleibt.
 * Ohne gültige Einwilligung: gelöscht AM Löschdatum (deutscher Kalendertag von delete_after = Erhebung + 6–12 Monate).
 *   Schreiben und Antworten verlängern die Frist nicht. (Die Regel „früherer Zeitpunkt aus Erhebung + Frist und letzter
 *   Antwort + 12 Monate“ ergibt wegen der Höchstfrist von 12 Monaten immer delete_after.) Altbestand mit Schonfrist
 *   (delete_after_legacy, Migration 0070: frühestens 30 Tage nach der Migration): nur delete_after zählt.
 * Mit gültiger Einwilligung (E-Mail oder Telefon, nicht widerrufen): 24 Monate nach der letzten Reaktion der Praxis,
 *   beim Altbestand frühestens am Löschdatum (Schonfrist).
 * „Reaktion“ = Antwort (replied_at, Verlauf „Antwort erhalten“) oder erteilte Einwilligung – NICHT unser eigenes Schreiben.
 * Audit nur mit Anzahlen, ohne Personendaten. Gibt die Anzahl gelöschter Einträge zurück.
 */
export async function purgeStaleLeads(now = new Date()): Promise<number> {
  const before = (months: number) => {
    const d = new Date(now);
    d.setMonth(d.getMonth() - months);
    return d;
  };
  const emailOk = sql`(${salesLeads.consentEmailAt} is not null and ${salesLeads.consentEmailRevokedAt} is null)`;
  const phoneOk = sql`(${salesLeads.consentPhoneAt} is not null and ${salesLeads.consentPhoneRevokedAt} is null)`;
  const lastReaction = sql`greatest(${salesLeads.createdAt}, coalesce(${salesLeads.repliedAt}, ${salesLeads.createdAt}),
    coalesce(${salesLeads.consentEmailAt}, ${salesLeads.createdAt}), coalesce(${salesLeads.consentPhoneAt}, ${salesLeads.createdAt}),
    coalesce((select max(e.created_at) from ${salesLeadEvents} e where e.lead_id = ${salesLeads.id} and e.kind = 'reply'), ${salesLeads.createdAt}))`;
  // Löschdatum erreicht = deutscher Kalendertag von delete_after ist heute oder vorbei (so steht es im Art.-14-Brief:
  // „Wir löschen Ihre Daten automatisch am {{Löschdatum}}“)
  const due = sql`(${salesLeads.deleteAfter} at time zone 'Europe/Berlin')::date <= (${now}::timestamptz at time zone 'Europe/Berlin')::date`;
  const expired = and(sql`not ${emailOk}`, sql`not ${phoneOk}`, due);
  // Schonfrist des Altbestands (0070) gilt auch mit Einwilligung: vor delete_after wird ein Altbestand-Eintrag nie gelöscht
  const stale = and(sql`(${emailOk} or ${phoneOk})`, sql`${lastReaction} < ${before(LEAD_RETENTION_MONTHS.withConsent)}::timestamptz`, sql`(not ${salesLeads.deleteAfterLegacy} or ${due})`);
  const { matchOrgs } = await import("./vertrieb-pipeline");
  const r = await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: salesLeads.id,
        status: salesLeads.status,
        step: salesLeads.step,
        repliedAt: salesLeads.repliedAt,
        email: salesLeads.email,
        website: salesLeads.website,
        expired: sql<boolean>`coalesce(${expired}, false)`,
      })
      .from(salesLeads)
      .where(and(sql`${salesLeads.status} <> 'kunde'`, or(expired, stale)))
      .for("update");
    if (!rows.length) return { count: 0, expired: 0, kept: 0 };
    // Bestandskunden (registrierte Praxis zugeordnet) nie löschen – gleiche Definition wie bei der Telefon-Anzeige
    const orgs = await matchOrgs(rows.map((x) => ({ ...x, suppressed: false })));
    const del = rows.filter((x) => !isExistingCustomerForRetention({ status: x.status, stage: deriveStage(x, orgs.get(x.id)) }));
    if (!del.length) return { count: 0, expired: 0, kept: rows.length };
    const ids = del.map((x) => x.id);
    await anonymizeLeadCodes(tx, ids);
    const gone = await tx.delete(salesLeads).where(inArray(salesLeads.id, ids)).returning({ id: salesLeads.id });
    return { count: gone.length, expired: del.filter((x) => x.expired).length, kept: rows.length - del.length };
  });
  if (r.count) {
    await audit({ action: "vertrieb.leads_purged", entity: "sales_lead", meta: { count: r.count, expired: r.expired, inactive: r.count - r.expired, keptCustomers: r.kept, months: { ...LEAD_RETENTION_MONTHS } } });
  }
  return r.count;
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
    const [lead] = await tx.select().from(salesLeads).where(eq(salesLeads.id, id)).for("update");
    if (!lead) return;
    // Abmeldung = Widerspruch: Prüfwerte (Adresse, Website, Name+PLZ) auf die Sperrliste, Lead samt Verlauf löschen
    await addLeadToBlocklist(tx, lead, "abgemeldet");
    await deleteLeadsForOptOut(tx, [id]);
    await audit({ action: "vertrieb.unsubscribe", entity: "sales_lead", entityId: id, meta: { from: lead.status } }, tx);
  });
  return true;
}
