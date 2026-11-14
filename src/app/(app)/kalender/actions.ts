"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db";
import { services } from "@/db/schema";
import { audit } from "@/lib/audit";
import { hasOwnCalendar } from "@/lib/auth/permissions";
import { requireAuth } from "@/lib/auth/session";
import { berlinToUtc } from "@/lib/format";
import { conflictMessage, createInternalAppointments, moveAppointment, rescheduleAppointment, type MoveInput } from "@/server/appointments";
import { saveCalendarMode, saveCalendarOptions } from "@/server/calendar-board";
import { DECEASED_BLOCKED_MSG } from "@/lib/patient-deceased";
import { keepOptionParams, parseOptionParams, resolveCalendarOptions, toStoredOptions } from "@/lib/calendar-options";
import { assignFeedAppointmentPatient } from "@/server/calendar-feeds";
import { seriesStarts } from "@/lib/appointment-series";
import { findDuplicates, insertPatient, parseBirthDate, patientInput, toPatientValues } from "@/server/patients";
import { changeAppointmentStatus, offerAfterCancel, UNDO_GRACE_MS, type StatusResult } from "@/server/calendar-status";
import { durationFromServices } from "@/lib/appointment-duration";

export type ApptFormState = { error?: string; conflict?: boolean } | undefined;

// Meldungen auf Deutsch: das Formular prüft nicht im Browser (noValidate – dessen Blasen sind in der Systemsprache,
// verschwinden wieder und erscheinen auf dem Handy oft außerhalb des Sichtfelds), sondern hier.
const schema = z.object({
  patientId: z.uuid("Bitte eine Patient:in aus der Liste wählen.").optional(),
  title: z.string().trim().max(200, "Titel höchstens 200 Zeichen.").optional(),
  date: z.string({ error: "Bitte ein Datum angeben." }).regex(/^\d{4}-\d{2}-\d{2}$/, "Bitte ein Datum angeben."),
  time: z.string({ error: "Bitte eine Uhrzeit angeben." }).regex(/^\d{2}:\d{2}$/, "Bitte eine Uhrzeit angeben."),
  durationMin: z.coerce.number({ error: "Dauer bitte als Zahl (Minuten) angeben." }).int("Dauer bitte in ganzen Minuten.").min(5, "Dauer mindestens 5 Minuten.").max(480, "Dauer höchstens 480 Minuten.").optional(),
  therapistId: z.uuid("Bitte eine Behandler:in wählen.").optional(),
  source: z.enum(["manual", "doctolib", "online", "phone", "whatsapp", "email", "voice_agent"], { error: "Bitte eine Quelle wählen." }).default("phone"),
  homeVisit: z.literal("on").optional(),
  notes: z.string().trim().max(2000, "Notiz höchstens 2000 Zeichen.").optional(),
  repeatWeeks: z.coerce.number({ error: "Wiederholung bitte als Zahl angeben." }).int("Wiederholung bitte in ganzen Wochen.").min(0, "Wiederholung: 0 bis 26 Wochen.").max(26, "Wiederholung: 0 bis 26 Wochen.").default(0),
  repeatCount: z.coerce.number({ error: "Anzahl bitte als Zahl angeben." }).int("Anzahl bitte als ganze Zahl.").min(1, "Anzahl Termine: 1 bis 12.").max(12, "Anzahl Termine: 1 bis 12.").default(1),
  allowConflict: z.literal("1").optional(),
});

/** Termin(e) aus dem Formular anlegen – gemeinsam für die Seite /kalender/neu und das Fenster im Kalender. */
async function createFromForm(form: FormData): Promise<{ ok: false; state: NonNullable<ApptFormState> } | { ok: true; id: string; date: string; n: number }> {
  const auth = await requireAuth("appointments.write");
  const org = auth.organization.id;
  const fail = (state: NonNullable<ApptFormState>) => ({ ok: false as const, state });
  const serviceIds = form.getAll("serviceId").map(String).filter(Boolean);
  const parsed = schema.safeParse(Object.fromEntries([...form.entries()].filter(([k, v]) => v !== "" && k !== "serviceId")));
  if (!parsed.success) return fail({ error: parsed.error.issues[0]?.message });
  const d = parsed.data;
  if (!d.patientId && !d.title) return fail({ error: "Bitte eine Patient:in wählen (Termin ohne Patient:in: unter „Weitere Optionen“ einen Titel angeben)." });

  const svc = serviceIds.length
    ? await withOrg(org, (tx) => tx.select().from(services).where(and(eq(services.organizationId, org), inArray(services.id, serviceIds), eq(services.active, true))))
    : [];
  // Ohne eigene Dauer: Summe der Leistungen – über 480 Minuten nicht still kürzen, sondern melden
  let duration = d.durationMin;
  if (duration === undefined) {
    const fromSvc = durationFromServices(svc.reduce((s, x) => s + x.durationMin, 0));
    if (!fromSvc.ok) return fail({ error: fromSvc.error });
    duration = fromSvc.durationMin;
  }
  // Wanduhrzeit in Berlin bleibt über Zeitumstellungen gleich (Datum weiterzählen, dann in UTC umrechnen)
  const occurrences = seriesStarts(d.date, d.time, d.repeatWeeks, d.repeatCount);

  // Ohne Auswahl: eigene Spalte – nur wer selbst einen Kalender hat (Empfang/Azubis müssen eine Behandler:in wählen)
  const therapistId = d.therapistId ?? (hasOwnCalendar(auth.role) ? auth.user.id : null);
  if (!therapistId) return fail({ error: "Bitte eine Behandler:in wählen." });
  const res = await createInternalAppointments(org, {
    patientId: d.patientId ?? null,
    therapistId,
    occurrences,
    durationMin: duration,
    source: d.source,
    title: d.title ?? (svc.map((x) => x.name).join(", ") || "Behandlung"),
    notes: d.notes ?? null,
    homeVisit: !!d.homeVisit,
    serviceIds: svc.map((x) => x.id),
    allowConflict: !!d.allowConflict,
  });
  if (!res.ok && "deceased" in res) return fail({ error: DECEASED_BLOCKED_MSG });
  if (!res.ok) return fail(res.conflict ? { error: conflictMessage(res), conflict: true } : { error: res.error });
  await audit({ organizationId: org, userId: auth.user.id, action: "appointment.create", meta: { n: occurrences.length, allowConflict: !!d.allowConflict } });
  revalidatePath("/kalender");
  revalidatePath("/heute");
  return { ok: true, id: res.ids[0], date: d.date, n: res.ids.length };
}

/** Seite /kalender/neu (auch ohne JavaScript): nach dem Anlegen zum Kalender am Tag des Termins */
export async function createAppointmentAction(_: ApptFormState, form: FormData): Promise<ApptFormState> {
  const r = await createFromForm(form);
  if (!r.ok) return r.state;
  redirect(`/kalender?datum=${r.date}`);
}

export type DialogApptState = (NonNullable<ApptFormState> & { created?: { id: string; date: string; n: number } }) | undefined;

/** Fenster „Neuer Termin“ im Kalender: kein Seitenwechsel – das Fenster schließt sich und meldet den neuen Termin */
export async function createAppointmentInDialogAction(_: DialogApptState, form: FormData): Promise<DialogApptState> {
  const r = await createFromForm(form);
  if (!r.ok) return r.state;
  return { created: { id: r.id, date: r.date, n: r.n } };
}

export type QuickPatientState =
  | { error?: string; duplicates?: { id: string; number: number; name: string }[]; patient?: { id: string; number: number; firstName: string | null; lastName: string } }
  | undefined;

/**
 * Neue Patient:in direkt aus dem Terminformular (Name, Telefon, optional Geburtsdatum/E-Mail). Gleiche Rechte
 * (patients.write), Prüfung (patientInput) und Dublettenprüfung wie /kunden/neu; „trotzdem anlegen“ mit ignoreDuplicates.
 */
export async function quickCreatePatientAction(_: QuickPatientState, form: FormData): Promise<QuickPatientState> {
  const auth = await requireAuth("patients.write");
  const org = auth.organization.id;
  const pick = (k: string) => String(form.get(k) ?? "").trim();
  const parsed = patientInput.safeParse({ firstName: pick("firstName"), lastName: pick("lastName"), phoneMobile: pick("phoneMobile"), email: pick("email"), birthDate: parseBirthDate(pick("birthDate")) });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const values = toPatientValues(parsed.data);
  if (form.get("ignoreDuplicates") !== "1") {
    const dups = await findDuplicates(org, values);
    if (dups.length) {
      return {
        error: "Möglicherweise gibt es diese Person schon. Bitte auswählen oder trotzdem anlegen.",
        duplicates: dups.map((d) => ({ id: d.id, number: d.number, name: [d.firstName, d.lastName].filter(Boolean).join(" ") })),
      };
    }
  }
  const created = await insertPatient(org, values);
  if (!created.ok) return { error: created.error };
  await audit({ organizationId: org, userId: auth.user.id, action: "patient.create", entity: "patient", entityId: created.id, meta: { via: "termin" } });
  revalidatePath("/kunden");
  return { patient: { id: created.id, number: created.number, firstName: values.firstName ?? null, lastName: values.lastName } };
}

export type { AppointmentStatus, StatusResult } from "@/server/calendar-status";

/**
 * Status eines Termins setzen (Terminzeile/Terminseite: „Nicht da“, „Absagen“ und deren „Rückgängig“).
 * Regeln (erlaubte Übergänge, Abrechnung, Doctolib/Kalender-Abo, Zeit inzwischen vergeben) in changeAppointmentStatus.
 * Gibt den vorherigen Status zurück, damit die Oberfläche die Änderung rückgängig machen kann.
 */
export async function changeAppointmentStatusAction(input: { id: string; status: string; expected?: string }): Promise<StatusResult> {
  const auth = await requireAuth("appointments.write");
  const org = auth.organization.id;
  const res = await changeAppointmentStatus(auth, input);
  if (!res.ok) return res;
  // Absage → frei gewordenen Termin der Warteliste anbieten, erst nach der Frist für „Rückgängig“ (offerFreedSlot
  // prüft dann, ob der Termin noch abgesagt ist). Läuft dieser Nachlauf nicht (Neustart), übernimmt der Cron.
  if (input.status === "cancelled" && res.prev !== "cancelled") {
    after(async () => {
      await new Promise((r) => setTimeout(r, UNDO_GRACE_MS));
      await offerAfterCancel(org, input.id);
    });
  }
  revalidatePath("/kalender");
  revalidatePath("/heute");
  revalidatePath(`/kalender/termin/${input.id}`);
  return res;
}

export type AssignState = { error?: string; ok?: string } | undefined;

/** Importierten Termin (Kalender-Abo) manuell einer Patient:in zuordnen – nie automatisch. */
export async function assignFeedPatientAction(_: AssignState, form: FormData): Promise<AssignState> {
  const auth = await requireAuth("appointments.write");
  const id = z.string().uuid().safeParse(form.get("appointmentId"));
  const patient = z.string().uuid().safeParse(form.get("patientId"));
  if (!id.success) return { error: "Termin fehlt." };
  if (!patient.success) return { error: "Bitte eine Patient:in wählen." };
  const ok = await assignFeedAppointmentPatient(auth, id.data, patient.data);
  if (ok === "deceased") return { error: "Patient:in ist als verstorben markiert – ein künftiger Termin kann nicht zugeordnet werden." };
  if (!ok) return { error: "Zuordnung nicht möglich (Termin oder Patient:in nicht gefunden)." };
  revalidatePath("/kalender");
  revalidatePath("/heute");
  return { ok: "Termin zugeordnet." };
}

export type RescheduleState = { error?: string; conflict?: boolean; ok?: string } | undefined;

const rescheduleSchema = z.object({
  id: z.uuid("Termin nicht gefunden."),
  date: z.string({ error: "Datum fehlt" }).regex(/^\d{4}-\d{2}-\d{2}$/, "Datum fehlt"),
  time: z.string({ error: "Uhrzeit fehlt" }).regex(/^\d{2}:\d{2}$/, "Uhrzeit fehlt"),
  durationMin: z.coerce.number({ error: "Dauer bitte als Zahl (Minuten) angeben." }).int("Dauer bitte in ganzen Minuten.").min(5, "Dauer mindestens 5 Minuten").max(480, "Dauer höchstens 480 Minuten"),
  therapistId: z.uuid("Bitte Behandler:in wählen"),
  allowConflict: z.literal("1").optional(),
});

/** Termin verschieben (nur in PodoHero geführte Termine – Doctolib/Kalender-Abo werden in der Quelle geändert). */
export async function rescheduleAppointmentAction(_: RescheduleState, form: FormData): Promise<RescheduleState> {
  const auth = await requireAuth("appointments.write");
  const parsed = rescheduleSchema.safeParse(Object.fromEntries([...form.entries()].filter(([, v]) => v !== "")));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const d = parsed.data;
  const res = await rescheduleAppointment(auth, d.id, { startsAt: berlinToUtc(d.date, d.time), durationMin: d.durationMin, therapistId: d.therapistId, allowConflict: !!d.allowConflict });
  if (!res.ok) return { error: res.error, conflict: res.conflict };
  revalidatePath("/kalender");
  revalidatePath("/heute");
  revalidatePath(`/kalender/termin/${d.id}`);
  redirect(`/kalender?datum=${d.date}`);
}

export type MoveResult = { ok: true } | { ok: false; error: string; conflict?: true };

/**
 * Kalender: Termin per Ziehen verschieben bzw. „Rückgängig“ (alte Zeit wiederherstellen). Gleiche Logik wie das
 * Formular „Datum und Uhrzeit ändern“ (rescheduleAppointment) – bei Überschneidung/Abwesenheit erst nach Bestätigung.
 */
export async function moveAppointmentAction(input: MoveInput): Promise<MoveResult> {
  const auth = await requireAuth("appointments.write");
  const res = await moveAppointment(auth, input);
  if (!res.ok) return res.conflict ? { ok: false, error: res.error, conflict: true } : { ok: false, error: res.error };
  revalidatePath("/kalender");
  revalidatePath("/heute");
  if (typeof input?.id === "string") revalidatePath(`/kalender/termin/${input.id}`);
  return { ok: true };
}

const modeSchema = z.object({
  mode: z.enum(["simple", "full"]),
  datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ansicht: z.enum(["tag", "woche", "monat"]).optional(),
});

/** Kalenderansicht umschalten („Einfach“/„Vollständig“) und je Person merken (users.prefs.calendar). */
export async function setCalendarModeAction(form: FormData) {
  const auth = await requireAuth("appointments.read");
  const parsed = modeSchema.safeParse(Object.fromEntries([...form.entries()].filter(([, v]) => v !== "")));
  if (!parsed.success) redirect("/kalender");
  const d = parsed.data;
  await saveCalendarMode(auth.user.id, d.mode);
  // Die einfache Ansicht kennt nur Tag/Woche – aus „Monat“ wird „Woche“
  const ansicht = d.mode === "simple" ? (d.ansicht === "woche" || d.ansicht === "monat" ? "woche" : undefined) : d.ansicht;
  const p = new URLSearchParams();
  if (d.datum) p.set("datum", d.datum);
  if (ansicht) p.set("ansicht", ansicht);
  revalidatePath("/kalender");
  redirect(`/kalender${p.size ? `?${p}` : ""}`);
}

const optionsNavSchema = z.object({
  mode: z.enum(["simple", "full"]),
  datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ansicht: z.enum(["tag", "woche", "monat"]).optional(),
  modus: z.enum(["einfach", "voll"]).optional(),
});

/**
 * Anzeige-Optionen des Kalenders (Feiertage, Schulferien, Wochenende …) je Person merken.
 * Nur Anzeige – keine Auswirkung auf Buchung oder Verfügbarkeit. Im Support-Modus wird nichts gespeichert:
 * die Auswahl wird dann nur als URL-Parameter weitergegeben.
 */
export async function saveCalendarOptionsAction(form: FormData) {
  const auth = await requireAuth("appointments.read");
  const entries: Record<string, string | string[]> = {};
  for (const k of new Set(form.keys())) {
    const all = form.getAll(k).filter((v): v is string => typeof v === "string");
    entries[k] = all.length > 1 ? all : (all[0] ?? "");
  }
  const one = (k: string) => (Array.isArray(entries[k]) ? (entries[k] as string[]).at(-1) : (entries[k] as string | undefined)) || undefined;
  const nav = optionsNavSchema.safeParse({ mode: one("mode"), datum: one("datum"), ansicht: one("ansicht"), modus: one("modus") });
  if (!nav.success) redirect("/kalender");
  const { mode, datum, ansicht, modus } = nav.data;
  const p = new URLSearchParams();
  if (datum) p.set("datum", datum);
  if (ansicht) p.set("ansicht", ansicht);
  if (modus) p.set("modus", modus);
  if (auth.support) {
    // Support-Modus: nichts speichern, Auswahl nur in der Adresse
    redirect(`/kalender?${p}${one("reset") ? "" : keepOptionParams(entries)}`);
  }
  const submitted = parseOptionParams(entries);
  await saveCalendarOptions(auth.user.id, (prev) => (one("reset") ? null : toStoredOptions(mode, resolveCalendarOptions(mode, prev, submitted), prev)));
  revalidatePath("/kalender");
  redirect(`/kalender${p.size ? `?${p}` : ""}`);
}
