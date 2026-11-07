"use server";

import { and, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withOrg } from "@/db";
import { appointmentServices, appointments, consents, messages, organizations, patients, services } from "@/db/schema";
import { audit } from "@/lib/audit";
import { berlinToUtc } from "@/lib/format";
import { requestMeta } from "@/lib/auth/session";

export type BookingState = { error?: string; ok?: string } | undefined;

// einfache Drosselung pro IP (Speicher des Prozesses; für mehrere Instanzen: Redis)
const hits = new Map<string, number[]>();
function limited(ip: string) {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 3600_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 5;
}

const schema = z.object({
  slug: z.string().min(1),
  serviceId: z.string().uuid("Bitte eine Leistung wählen."),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Bitte einen Tag wählen."),
  time: z.string().regex(/^\d{2}:\d{2}$/, "Bitte eine Uhrzeit wählen."),
  firstName: z.string().trim().min(1, "Vorname fehlt").max(80),
  lastName: z.string().trim().min(1, "Nachname fehlt").max(80),
  phone: z.string().trim().min(6, "Telefonnummer fehlt").max(40),
  email: z.string().trim().email("E-Mail ungültig").max(200).optional().or(z.literal("")),
  note: z.string().trim().max(500).optional(),
  privacy: z.literal("on", { message: "Bitte die Datenschutzhinweise bestätigen." }),
  noShow: z.literal("on", { message: "Bitte die Ausfallregelung bestätigen." }),
  website: z.string().max(0).optional(), // Honeypot
});

export async function bookAction(_: BookingState, form: FormData): Promise<BookingState> {
  const parsed = schema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  const { ip } = await requestMeta();
  if (limited(ip ?? "unbekannt")) return { error: "Zu viele Anfragen. Bitte später erneut versuchen oder anrufen." };
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, d.slug));
  if (!org) return { error: "Praxis nicht gefunden." };
  const start = berlinToUtc(d.date, d.time);
  if (start.getTime() < Date.now() + 2 * 3600_000) return { error: "Bitte einen späteren Termin wählen." };

  const result = await withOrg(org.id, async (tx) => {
    const [svc] = await tx.select().from(services).where(and(eq(services.organizationId, org.id), eq(services.id, d.serviceId), eq(services.active, true)));
    if (!svc) return { error: "Leistung nicht verfügbar." };
    const end = new Date(start.getTime() + svc.durationMin * 60_000);
    const clash = await tx.select({ id: appointments.id, status: appointments.status }).from(appointments).where(and(eq(appointments.organizationId, org.id), lt(appointments.startsAt, end), gte(appointments.endsAt, start)));
    if (clash.some((c) => c.status !== "cancelled")) return { error: "Dieser Termin wurde gerade vergeben. Bitte einen anderen wählen." };
    // Bestehenden Kunden über Telefon/E-Mail + Name finden, sonst neu anlegen (als „Online“ markiert)
    const phone = d.phone.replace(/\s/g, "");
    const existing = await tx.select().from(patients).where(and(eq(patients.organizationId, org.id), eq(patients.lastName, d.lastName)));
    let patient = existing.find((p) => (p.phoneMobile ?? "").replace(/\s/g, "") === phone || (d.email && p.email === d.email));
    if (!patient) {
      // Nummernvergabe serialisieren (parallele Online-Buchungen)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"pnum:" + org.id}))`);
      const [{ max }] = (await tx.execute<{ max: number }>(sql`select coalesce(max(number),0)::int as max from patients where organization_id = ${org.id}`)).rows;
      [patient] = await tx
        .insert(patients)
        .values({ organizationId: org.id, number: max + 1, firstName: d.firstName, lastName: d.lastName, phoneMobile: d.phone, email: d.email || null, source: "online-buchung" })
        .returning();
    }
    const [a] = await tx
      .insert(appointments)
      .values({ organizationId: org.id, patientId: patient.id, startsAt: start, endsAt: end, status: "planned", source: "online", title: svc.name, notes: d.note || null })
      .returning();
    await tx.insert(appointmentServices).values({ organizationId: org.id, appointmentId: a.id, serviceId: svc.id });
    await tx.insert(consents).values([
      { organizationId: org.id, patientId: patient.id, type: "privacy_notice", granted: true, via: "online-buchung" },
      { organizationId: org.id, patientId: patient.id, type: "no_show_terms", granted: true, via: "online-buchung" },
    ]);
    await tx.insert(messages).values({
      organizationId: org.id,
      patientId: patient.id,
      channel: "email",
      direction: "inbound",
      subject: "Neue Online-Buchung",
      body: `Online-Buchung: ${svc.name} am ${d.date} um ${d.time}. Bitte bestätigen.${d.note ? `\nNotiz: ${d.note}` : ""}`,
      status: "new",
    });
    return { ok: true as const, appointmentId: a.id };
  });
  if ("error" in result) return { error: result.error };
  await audit({ organizationId: org.id, action: "booking.online", entity: "appointment", entityId: result.appointmentId });
  return { ok: "Danke! Deine Anfrage ist eingegangen. Die Praxis bestätigt den Termin kurzfristig." };
}
