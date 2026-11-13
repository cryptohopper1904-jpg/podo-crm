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
  importLeads,
  previewImport,
  previewSend,
  resetSalesTemplates,
  saveSalesSettings,
  saveSalesTemplates,
  sendNextMails,
  setLeadStatus,
  updateLead,
  type ImportPreview,
  type SendPreview,
  type SendResult,
} from "@/server/vertrieb";

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
  await setLeadStatus(row.user.id, d.data.id, d.data.status);
  revalidatePath(BASE);
  revalidatePath(`${BASE}/${d.data.id}`);
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

export async function importAction(csv: string): Promise<{ imported: number; skipped: number; error?: string }> {
  const row = await requirePlatformAdmin();
  const d = csvSchema.safeParse(csv);
  if (!d.success) return { imported: 0, skipped: 0, error: d.error.issues[0]?.message };
  const r = await importLeads(row.user.id, d.data);
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
    await saveSalesSettings(row.user.id, d.data);
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
