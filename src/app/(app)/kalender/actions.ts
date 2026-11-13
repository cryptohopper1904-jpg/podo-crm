"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db";
import { appointments, services } from "@/db/schema";
import { audit } from "@/lib/audit";
import { hasOwnCalendar } from "@/lib/auth/permissions";
import { requireAuth } from "@/lib/auth/session";
import { berlinToUtc } from "@/lib/format";
import { conflictMessage, createInternalAppointments, rescheduleAppointment } from "@/server/appointments";
import { saveCalendarMode } from "@/server/calendar-board";
import { assignFeedAppointmentPatient, isFeedAppointment } from "@/server/calendar-feeds";
import { offerFreedSlotSafe } from "@/server/waitlist";

export type ApptFormState = { error?: string; conflict?: boolean } | undefined;

const schema = z.object({
  patientId: z.string().uuid().optional(),
  title: z.string().trim().max(200).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum fehlt"),
  time: z.string().regex(/^\d{2}:\d{2}$/, "Uhrzeit fehlt"),
  durationMin: z.coerce.number().int().min(5).max(480).optional(),
  therapistId: z.string().uuid().optional(),
  source: z.enum(["manual", "doctolib", "online", "phone", "whatsapp", "email", "voice_agent"]).default("phone"),
  homeVisit: z.literal("on").optional(),
  notes: z.string().trim().max(2000).optional(),
  repeatWeeks: z.coerce.number().int().min(0).max(26).default(0),
  repeatCount: z.coerce.number().int().min(1).max(12).default(1),
  allowConflict: z.literal("1").optional(),
});

export async function createAppointmentAction(_: ApptFormState, form: FormData): Promise<ApptFormState> {
  const auth = await requireAuth("appointments.write");
  const org = auth.organization.id;
  const serviceIds = form.getAll("serviceId").map(String).filter(Boolean);
  const parsed = schema.safeParse(Object.fromEntries([...form.entries()].filter(([k, v]) => v !== "" && k !== "serviceId")));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  if (!d.patientId && !d.title) return { error: "Bitte eine Patient:in wählen oder einen Titel (z. B. Blocker) eingeben." };

  const svc = serviceIds.length
    ? await withOrg(org, (tx) => tx.select().from(services).where(and(eq(services.organizationId, org), inArray(services.id, serviceIds))))
    : [];
  const duration = d.durationMin ?? (svc.reduce((s, x) => s + x.durationMin, 0) || 30);
  const firstStart = berlinToUtc(d.date, d.time);
  const occurrences = Array.from({ length: d.repeatWeeks ? d.repeatCount : 1 }, (_, i) => new Date(firstStart.getTime() + i * d.repeatWeeks * 7 * 86400_000));

  // Ohne Auswahl: eigene Spalte – nur wer selbst einen Kalender hat (Empfang/Azubis müssen eine Behandler:in wählen)
  const therapistId = d.therapistId ?? (hasOwnCalendar(auth.role) ? auth.user.id : null);
  if (!therapistId) return { error: "Bitte eine Behandler:in wählen." };
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
  if (!res.ok) return res.conflict ? { error: conflictMessage(res), conflict: true } : { error: res.error };
  await audit({ organizationId: org, userId: auth.user.id, action: "appointment.create", meta: { n: occurrences.length, allowConflict: !!d.allowConflict } });
  revalidatePath("/kalender");
  revalidatePath("/heute");
  redirect(`/kalender?datum=${d.date}`);
}

export async function setAppointmentStatusAction(form: FormData) {
  const auth = await requireAuth("appointments.write");
  const org = auth.organization.id;
  const id = z.string().uuid().parse(form.get("id"));
  const status = z.enum(["planned", "confirmed", "done", "cancelled", "no_show"]).parse(form.get("status"));
  // Termine aus dem Kalender-Abo werden in der Quelle (z. B. Doctolib) abgesagt – der Abgleich übernimmt die Absage
  if (status === "cancelled" && (await isFeedAppointment(org, id))) return;
  const prev = await withOrg(org, async (tx) => {
    const [a] = await tx.select({ status: appointments.status }).from(appointments).where(and(eq(appointments.organizationId, org), eq(appointments.id, id))).for("update");
    if (a) await tx.update(appointments).set({ status, updatedAt: new Date() }).where(and(eq(appointments.organizationId, org), eq(appointments.id, id)));
    return a?.status ?? null;
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "appointment.status", entity: "appointment", entityId: id, meta: { status } });
  // Absage durch die Praxis (auch nach einem Absagewunsch per KI-Telefon) → frei gewordenen Termin der Warteliste anbieten
  if (status === "cancelled" && prev && prev !== "cancelled") after(() => offerFreedSlotSafe(org, id));
  revalidatePath("/kalender");
  revalidatePath("/heute");
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
  if (!ok) return { error: "Zuordnung nicht möglich (Termin oder Patient:in nicht gefunden)." };
  revalidatePath("/kalender");
  revalidatePath("/heute");
  return { ok: "Termin zugeordnet." };
}

export type RescheduleState = { error?: string; conflict?: boolean; ok?: string } | undefined;

const rescheduleSchema = z.object({
  id: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum fehlt"),
  time: z.string().regex(/^\d{2}:\d{2}$/, "Uhrzeit fehlt"),
  durationMin: z.coerce.number().int().min(5, "Dauer mindestens 5 Minuten").max(480, "Dauer höchstens 480 Minuten"),
  therapistId: z.string().uuid("Bitte Behandler:in wählen"),
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
