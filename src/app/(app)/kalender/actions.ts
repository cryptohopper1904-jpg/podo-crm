"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db";
import { appointmentServices, appointments, services } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { berlinToUtc } from "@/lib/format";
import { findConflicts } from "@/server/appointments";

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
  if (!d.patientId && !d.title) return { error: "Bitte Kunde wählen oder einen Titel (z. B. Blocker) eingeben." };

  const svc = serviceIds.length
    ? await withOrg(org, (tx) => tx.select().from(services).where(and(eq(services.organizationId, org), inArray(services.id, serviceIds))))
    : [];
  const duration = d.durationMin ?? (svc.reduce((s, x) => s + x.durationMin, 0) || 30);
  const firstStart = berlinToUtc(d.date, d.time);
  const occurrences = Array.from({ length: d.repeatWeeks ? d.repeatCount : 1 }, (_, i) => new Date(firstStart.getTime() + i * d.repeatWeeks * 7 * 86400_000));

  if (!d.allowConflict) {
    for (const s of occurrences) {
      const c = await findConflicts(org, d.therapistId ?? null, s, new Date(s.getTime() + duration * 60_000));
      if (c.length) return { error: "Zu dieser Zeit ist bereits ein Termin eingetragen.", conflict: true };
    }
  }
  await withOrg(org, async (tx) => {
    for (const s of occurrences) {
      const [a] = await tx
        .insert(appointments)
        .values({
          organizationId: org,
          patientId: d.patientId ?? null,
          therapistId: d.therapistId ?? auth.user.id,
          startsAt: s,
          endsAt: new Date(s.getTime() + duration * 60_000),
          source: d.source,
          title: d.title ?? (svc.map((x) => x.name).join(", ") || "Behandlung"),
          notes: d.notes ?? null,
          homeVisit: !!d.homeVisit,
        })
        .returning({ id: appointments.id });
      if (svc.length) await tx.insert(appointmentServices).values(svc.map((x) => ({ organizationId: org, appointmentId: a.id, serviceId: x.id })));
    }
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "appointment.create", meta: { n: occurrences.length } });
  revalidatePath("/kalender");
  revalidatePath("/heute");
  redirect(`/kalender?datum=${d.date}`);
}

export async function setAppointmentStatusAction(form: FormData) {
  const auth = await requireAuth("appointments.write");
  const org = auth.organization.id;
  const id = z.string().uuid().parse(form.get("id"));
  const status = z.enum(["planned", "confirmed", "done", "cancelled", "no_show"]).parse(form.get("status"));
  await withOrg(org, (tx) => tx.update(appointments).set({ status, updatedAt: new Date() }).where(and(eq(appointments.organizationId, org), eq(appointments.id, id))));
  await audit({ organizationId: org, userId: auth.user.id, action: "appointment.status", entity: "appointment", entityId: id, meta: { status } });
  revalidatePath("/kalender");
  revalidatePath("/heute");
}
