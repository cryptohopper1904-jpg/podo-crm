"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { CSV_MAX_BYTES, type LeadInput } from "@/lib/vertrieb/csv";
import { LEAD_STATUSES, SEQUENCE_STEPS } from "@/lib/vertrieb/constants";
import { isRunning } from "@/lib/vertrieb/lead-search";
import { getLeadSearch, runLeadSearch, saveLeadSearchSettings } from "@/server/lead-search";
import { requirePlatformAdmin } from "@/server/platform";
import {
  addSuppression,
  createLead,
  deleteLead,
  getLead,
  importLeads,
  previewImport,
  previewSend,
  resetSalesTemplates,
  saveSalesSettings,
  saveSalesTemplates,
  sendNextMails,
  recordLeadConsent,
  removeLeadConsent,
  setLeadStatus,
  updateLead,
  type ImportPreview,
  type SendPreview,
  type SendResult,
} from "@/server/vertrieb";
import { addLeadNote, bulkSetStatus, createCampaign, markReplied, saveCampaignTemplates, setLeadsCampaign, updateCampaign } from "@/server/vertrieb-pipeline";
import { createPromoCode, setPromoCodeActive } from "@/server/promo-codes";
import { endOfDayBerlin, PROMO_GRANT_PLANS } from "@/lib/promo-codes";
import { BULK_STATUSES } from "@/lib/vertrieb/pipeline";

/**
 * Vertrieb (Plattform-Konsole). JEDE Action prüft selbst requirePlatformAdmin() (Plattform-Admin + aktive 2FA,
 * sonst 404) – nicht nur die Seite.
 */

type State = { error?: string; ok?: string } | undefined;
const BASE = "/plattform/vertrieb";
const msg = (e: unknown) => (e instanceof Error ? e.message : "Unbekannter Fehler.").slice(0, 400);

const opt = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : null));

const leadSchema = z.object({
  name: z.string().trim().min(1, "Name fehlt.").max(200),
  contactPerson: opt(120),
  email: z
    .string()
    .trim()
    .max(254)
    .optional()
    .transform((v) => (v ? v.toLowerCase() : null))
    .refine((v) => v === null || z.email().safeParse(v).success, "E-Mail-Adresse ist ungültig."),
  phone: opt(60),
  website: opt(300).refine((v) => v === null || /^https?:\/\/\S+$/i.test(v), "Website bitte mit https:// angeben."),
  street: opt(200),
  zip: opt(10),
  city: opt(120),
  distanceKm: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? Number(v.replace(",", ".")) : null))
    .refine((v) => v === null || (Number.isFinite(v) && v >= 0 && v < 10_000), "Entfernung ist keine gültige Zahl."),
  source: opt(120),
  notes: opt(2000),
});

function parseLead(form: FormData): { data: LeadInput } | { error: string } {
  const d = leadSchema.safeParse(Object.fromEntries(form));
  if (!d.success) return { error: d.error.issues[0]?.message ?? "Eingaben ungültig." };
  return { data: d.data };
}

export async function createLeadAction(_s: State, form: FormData): Promise<State> {
  const row = await requirePlatformAdmin();
  const p = parseLead(form);
  if ("error" in p) return { error: p.error };
  let id: string;
  try {
    id = await createLead(row.user.id, p.data);
  } catch (e) {
    return { error: msg(e) };
  }
  revalidatePath(BASE);
  redirect(`${BASE}/${id}`);
}

export async function updateLeadAction(_s: State, form: FormData): Promise<State> {
  const row = await requirePlatformAdmin();
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "Eintrag nicht gefunden." };
  const p = parseLead(form);
  if ("error" in p) return { error: p.error };
  try {
    await updateLead(row.user.id, id.data, p.data);
  } catch (e) {
    return { error: msg(e) };
  }
  revalidatePath(BASE);
  revalidatePath(`${BASE}/${id.data}`);
  return { ok: "Gespeichert." };
}

export async function setStatusAction(form: FormData) {
  const row = await requirePlatformAdmin();
  const d = z.object({ id: z.uuid(), status: z.enum(LEAD_STATUSES) }).safeParse(Object.fromEntries(form));
  if (!d.success) redirect(`${BASE}?fehler=eingabe`);
  const r = await setLeadStatus(row.user.id, d.data.id, d.data.status);
  revalidatePath(BASE, "layout");
  // „abgemeldet“ löscht den Eintrag (nur der Prüfwert bleibt auf der Sperrliste)
  if (r === "deleted") redirect(`${BASE}?hinweis=abgemeldet`);
}

export async function deleteLeadAction(form: FormData) {
  const row = await requirePlatformAdmin();
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success || form.get("confirm") !== "ja") redirect(`${BASE}?fehler=eingabe`);
  await deleteLead(row.user.id, id.data);
  revalidatePath(BASE);
  redirect(BASE);
}

// ───────────── Import ─────────────

const csvSchema = z.string().min(1, "Keine Datei.").max(CSV_MAX_BYTES, "Datei zu groß (max. 1 MB).");

export async function previewImportAction(csv: string): Promise<ImportPreview> {
  await requirePlatformAdmin();
  const d = csvSchema.safeParse(csv);
  if (!d.success) return { decisions: [], newCount: 0, skippedCount: 0, error: d.error.issues[0]?.message };
  return previewImport(d.data);
}

export async function importAction(csv: string, source: string): Promise<{ imported: number; skipped: number; error?: string }> {
  const row = await requirePlatformAdmin();
  const d = csvSchema.safeParse(csv);
  if (!d.success) return { imported: 0, skipped: 0, error: d.error.issues[0]?.message };
  const src = z.string().trim().min(3, "Bitte die Quelle der Daten angeben (z. B. „Messe XY 2026, Kontaktformular“).").max(120).safeParse(source);
  if (!src.success) return { imported: 0, skipped: 0, error: src.error.issues[0]?.message };
  const r = await importLeads(row.user.id, d.data, src.data);
  revalidatePath(BASE);
  return r;
}

// ───────────── Versand ─────────────

const idsSchema = z.array(z.uuid()).min(1, "Bitte mindestens eine Praxis auswählen.").max(500);

export async function previewSendAction(ids: string[]): Promise<SendPreview | { error: string }> {
  await requirePlatformAdmin();
  const d = idsSchema.safeParse(ids);
  if (!d.success) return { error: d.error.issues[0]?.message ?? "Auswahl ungültig." };
  return previewSend(d.data);
}

export async function sendAction(ids: string[]): Promise<SendResult | { error: string }> {
  const row = await requirePlatformAdmin();
  const d = idsSchema.safeParse(ids);
  if (!d.success) return { error: d.error.issues[0]?.message ?? "Auswahl ungültig." };
  try {
    const r = await sendNextMails(row.user.id, d.data);
    revalidatePath(BASE);
    return r;
  } catch (e) {
    return { error: msg(e) };
  }
}

// ───────────── Einstellungen, Vorlagen, Sperrliste ─────────────

export async function saveSettingsAction(_s: State, form: FormData): Promise<State> {
  const row = await requirePlatformAdmin();
  const d = z
    .object({
      senderName: z.string().max(80),
      senderEmail: z.string().max(254),
      replyTo: z.string().max(254),
      impressum: z.string().max(1500),
      delay2Days: z.coerce.number().int().min(1).max(60),
      delay3Days: z.coerce.number().int().min(1).max(60),
    })
    .safeParse(Object.fromEntries(form));
  if (!d.success) return { error: "Eingaben ungültig (Abstände 1 bis 60 Tage, Impressum max. 1500 Zeichen)." };
  try {
    await saveSalesSettings(row.user.id, { ...d.data, mailProcessorConfirmed: form.get("mailProcessorConfirmed") === "on" });
  } catch (e) {
    return { error: msg(e) };
  }
  revalidatePath(BASE, "layout");
  return { ok: "Einstellungen gespeichert." };
}

export async function saveTemplatesAction(_s: State, form: FormData): Promise<State> {
  const row = await requirePlatformAdmin();
  const templates = Array.from({ length: SEQUENCE_STEPS }, (_, i) => ({ subject: String(form.get(`subject${i + 1}`) ?? ""), body: String(form.get(`body${i + 1}`) ?? "") }));
  try {
    await saveSalesTemplates(row.user.id, templates);
  } catch (e) {
    return { error: msg(e) };
  }
  revalidatePath(BASE, "layout");
  return { ok: "Vorlagen gespeichert." };
}

export async function resetTemplatesAction() {
  const row = await requirePlatformAdmin();
  await resetSalesTemplates(row.user.id);
  revalidatePath(BASE, "layout");
}

export async function addSuppressionAction(_s: State, form: FormData): Promise<State> {
  const row = await requirePlatformAdmin();
  try {
    await addSuppression(row.user.id, String(form.get("email") ?? ""));
  } catch (e) {
    return { error: msg(e) };
  }
  revalidatePath(BASE, "layout");
  return { ok: "Adresse gesperrt." };
}

// ───────────── Praxissuche (OpenStreetMap, nachts) ─────────────

export async function saveLeadSearchAction(_s: State, form: FormData): Promise<State> {
  const row = await requirePlatformAdmin();
  const d = z
    .object({
      centerText: z.string().max(200),
      ringKm: z.coerce.number().int(),
      maxKm: z.coerce.number().int(),
    })
    .safeParse(Object.fromEntries(form));
  if (!d.success) return { error: "Eingaben ungültig." };
  try {
    await saveLeadSearchSettings(row.user.id, { ...d.data, enabled: form.get("enabled") === "on", resetProgress: form.get("resetProgress") === "on", allowNamed: form.get("allowNamed") === "on" });
  } catch (e) {
    return { error: msg(e) };
  }
  revalidatePath(BASE, "layout");
  return { ok: "Praxissuche gespeichert." };
}

/** „Jetzt suchen“: startet den nächsten Ring im Hintergrund (after) – auch wenn die nächtliche Suche aus ist. */
export async function runLeadSearchAction(): Promise<State> {
  const row = await requirePlatformAdmin();
  const s = await getLeadSearch();
  if (!s.center) return { error: "Bitte zuerst unter Einstellungen einen Startort für die Praxissuche angeben." };
  if (s.doneKm >= s.maxKm) return { error: `Der Höchstradius (${s.maxKm} km) ist durchsucht. Unter Einstellungen erhöhen oder zurücksetzen.` };
  if (isRunning(s)) return { error: "Es läuft bereits eine Suche." };
  // höchstens alle 10 Minuten (Overpass-Nutzungsregeln)
  if (s.lastRun && Date.now() - Date.parse(s.lastRun.at) < 10 * 60_000) return { error: "Bitte 10 Minuten nach dem letzten Suchlauf warten." };
  const userId = row.user.id;
  after(async () => {
    try {
      await runLeadSearch({ trigger: "manual", adminUserId: userId });
    } catch {
      // Status und Fehler stehen in sales_settings.lead_search (Anzeige auf der Vertriebsseite)
    }
  });
  return { ok: "Suche gestartet. Das dauert einige Minuten – danach die Seite neu laden." };
}

// ───────────── Verlauf, Antwort, Sammelaktionen ─────────────

export async function addNoteAction(_s: State, form: FormData): Promise<State> {
  const row = await requirePlatformAdmin();
  const d = z.object({ id: z.uuid(), text: z.string().trim().min(1, "Notiz ist leer.").max(2000) }).safeParse(Object.fromEntries(form));
  if (!d.success) return { error: d.error.issues[0]?.message ?? "Eingaben ungültig." };
  try {
    await addLeadNote(row.user.id, d.data.id, d.data.text);
  } catch (e) {
    return { error: msg(e) };
  }
  revalidatePath(`${BASE}/${d.data.id}`);
  return { ok: "Notiz gespeichert." };
}

export async function markRepliedAction(form: FormData) {
  const row = await requirePlatformAdmin();
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) redirect(`${BASE}?fehler=eingabe`);
  await markReplied(row.user.id, id.data);
  revalidatePath(BASE);
  revalidatePath(`${BASE}/${id.data}`);
}

export async function setLeadCampaignAction(form: FormData) {
  const row = await requirePlatformAdmin();
  const d = z.object({ id: z.uuid(), campaignId: z.union([z.uuid(), z.literal("")]) }).safeParse(Object.fromEntries(form));
  if (!d.success) redirect(`${BASE}?fehler=eingabe`);
  await setLeadsCampaign(row.user.id, [d.data.id], d.data.campaignId || null);
  revalidatePath(BASE, "layout");
}

export async function consentAction(_s: State, form: FormData): Promise<State> {
  const row = await requirePlatformAdmin();
  const d = z.object({ id: z.uuid(), note: z.string().trim().min(3, "Bitte angeben, wie und wann die Einwilligung erteilt wurde.").max(500) }).safeParse(Object.fromEntries(form));
  if (!d.success) return { error: d.error.issues[0]?.message ?? "Eingaben ungültig." };
  try {
    if (!(await recordLeadConsent(row.user.id, d.data.id, d.data.note))) {
      const lead = await getLead(d.data.id);
      return { error: lead ? "Nur möglich, wenn eine E-Mail-Adresse eingetragen ist." : "Eintrag nicht gefunden (inzwischen gelöscht?)." };
    }
  } catch (e) {
    return { error: msg(e) };
  }
  revalidatePath(BASE, "layout");
  return { ok: "Einwilligung dokumentiert." };
}

export async function removeConsentAction(form: FormData) {
  const row = await requirePlatformAdmin();
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) redirect(`${BASE}?fehler=eingabe`);
  await removeLeadConsent(row.user.id, [id.data]);
  revalidatePath(BASE, "layout");
}

const bulkSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("status"), status: z.enum(BULK_STATUSES as [string, ...string[]]) }),
  z.object({ op: z.literal("kampagne"), campaignId: z.union([z.uuid(), z.literal("")]) }),
  z.object({ op: z.literal("abmelden") }),
  z.object({ op: z.literal("einwilligung_entfernen") }),
]);

/** Sammelaktion für die ausgewählten Leads: Status setzen, Kampagne zuordnen oder abmelden (Sperrliste). */
export async function bulkAction(ids: string[], input: unknown): Promise<{ ok: string } | { error: string }> {
  const row = await requirePlatformAdmin();
  const list = idsSchema.safeParse(ids);
  if (!list.success) return { error: list.error.issues[0]?.message ?? "Auswahl ungültig." };
  const d = bulkSchema.safeParse(input);
  if (!d.success) return { error: "Aktion ungültig." };
  try {
    let text: string;
    if (d.data.op === "status") text = `${await bulkSetStatus(row.user.id, list.data, d.data.status as (typeof LEAD_STATUSES)[number])} Einträge geändert.`;
    else if (d.data.op === "einwilligung_entfernen") text = `Einwilligung bei ${await removeLeadConsent(row.user.id, list.data)} Einträgen entfernt.`;
    else if (d.data.op === "abmelden") text = `${await bulkSetStatus(row.user.id, list.data, "abgemeldet")} Einträge abgemeldet: Adressen gesperrt, Einträge gelöscht.`;
    else text = `${await setLeadsCampaign(row.user.id, list.data, d.data.campaignId || null)} Einträge ${d.data.campaignId ? "der Kampagne zugeordnet" : "aus der Kampagne entfernt"}.`;
    revalidatePath(BASE, "layout");
    return { ok: text };
  } catch (e) {
    return { error: msg(e) };
  }
}

// ───────────── Kampagnen ─────────────

const campaignSchema = z.object({ name: z.string().trim().min(1, "Bitte einen Namen angeben.").max(120), notes: opt(2000) });

export async function createCampaignAction(_s: State, form: FormData): Promise<State> {
  const row = await requirePlatformAdmin();
  const d = campaignSchema.safeParse(Object.fromEntries(form));
  if (!d.success) return { error: d.error.issues[0]?.message ?? "Eingaben ungültig." };
  let id: string;
  try {
    id = await createCampaign(row.user.id, d.data);
  } catch (e) {
    return { error: msg(e) };
  }
  revalidatePath(BASE, "layout");
  redirect(`${BASE}/kampagnen/${id}`);
}

export async function updateCampaignAction(_s: State, form: FormData): Promise<State> {
  const row = await requirePlatformAdmin();
  const id = z.uuid().safeParse(form.get("id"));
  const d = campaignSchema.safeParse(Object.fromEntries(form));
  if (!id.success) return { error: "Kampagne nicht gefunden." };
  if (!d.success) return { error: d.error.issues[0]?.message ?? "Eingaben ungültig." };
  try {
    await updateCampaign(row.user.id, id.data, { ...d.data, active: form.get("active") === "on" });
  } catch (e) {
    return { error: msg(e) };
  }
  revalidatePath(BASE, "layout");
  return { ok: "Kampagne gespeichert." };
}

export async function saveCampaignTemplatesAction(_s: State, form: FormData): Promise<State> {
  const row = await requirePlatformAdmin();
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "Kampagne nicht gefunden." };
  const templates = Array.from({ length: SEQUENCE_STEPS }, (_, i) => ({ subject: String(form.get(`subject${i + 1}`) ?? ""), body: String(form.get(`body${i + 1}`) ?? "") }));
  try {
    await saveCampaignTemplates(row.user.id, id.data, templates);
  } catch (e) {
    return { error: msg(e) };
  }
  revalidatePath(BASE, "layout");
  return { ok: "Vorlagen der Kampagne gespeichert." };
}

export async function resetCampaignTemplatesAction(form: FormData) {
  const row = await requirePlatformAdmin();
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) redirect(`${BASE}/kampagnen`);
  await saveCampaignTemplates(row.user.id, id.data, null);
  revalidatePath(BASE, "layout");
}

// ───────────── Aktionscodes ─────────────

const promoSchema = z.object({
  code: z.string().trim().min(1, "Code fehlt.").max(40),
  label: z.string().trim().min(1, "Bitte eine Bezeichnung angeben.").max(120),
  trialDays: z.coerce.number().int().min(1, "Testphase: mindestens 1 Tag.").max(365, "Testphase: höchstens 365 Tage."),
  grantPlan: z.union([z.enum(PROMO_GRANT_PLANS as [string, ...string[]]), z.literal("")]).optional(),
  maxRedemptions: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? Number(v) : null))
    .refine((v) => v === null || (Number.isInteger(v) && v >= 1 && v <= 100_000), "Höchstzahl Einlösungen: 1 bis 100000 oder leer."),
  validUntil: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : null))
    .refine((v) => v === null || endOfDayBerlin(v) !== null, "Datum ungültig."),
  campaignId: z.union([z.uuid(), z.literal("")]).optional(),
});

export async function createPromoCodeAction(_s: State, form: FormData): Promise<State> {
  const row = await requirePlatformAdmin();
  const d = promoSchema.safeParse(Object.fromEntries(form));
  if (!d.success) return { error: d.error.issues[0]?.message ?? "Eingaben ungültig." };
  try {
    await createPromoCode(row.user.id, {
      code: d.data.code,
      label: d.data.label,
      trialDays: d.data.trialDays,
      grantPlan: (d.data.grantPlan || null) as (typeof PROMO_GRANT_PLANS)[number] | null,
      maxRedemptions: d.data.maxRedemptions,
      // „gültig bis“ einschließlich: 23:59:59 deutscher Zeit (Sommer-/Winterzeit)
      validUntil: d.data.validUntil ? endOfDayBerlin(d.data.validUntil) : null,
      campaignId: d.data.campaignId || null,
    });
  } catch (e) {
    return { error: msg(e) };
  }
  revalidatePath(BASE, "layout");
  return { ok: "Aktionscode angelegt." };
}

export async function setPromoCodeActiveAction(form: FormData) {
  const row = await requirePlatformAdmin();
  const d = z.object({ id: z.uuid(), active: z.enum(["ja", "nein"]) }).safeParse(Object.fromEntries(form));
  if (!d.success) redirect(`${BASE}/aktionscodes`);
  await setPromoCodeActive(row.user.id, d.data.id, d.data.active === "ja");
  revalidatePath(BASE, "layout");
}
