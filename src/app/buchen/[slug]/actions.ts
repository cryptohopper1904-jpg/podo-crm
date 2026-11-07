"use server";

import { and, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withOrg } from "@/db";
import { appointmentServices, appointments, messages, organizations, services } from "@/db/schema";
import { audit } from "@/lib/audit";
import { berlinToUtc } from "@/lib/format";
import { requestMeta } from "@/lib/auth/session";

export type BookingState = { error?: string; ok?: string } | undefined;

// einfache Drosselung pro IP (Speicher des Prozesses; für mehrere Instanzen: Redis)
const hits = new Map<string, number[]>();
function limited(ip: string) {
  const now = Date.now();
  // alte Einträge entfernen, Größe begrenzen (kein Speicher-Leck)
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 3600_000)) hits.delete(k);
  if (hits.size > 10000) hits.clear();
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
    // Buchungen je Praxis serialisieren → keine Doppelbelegung bei gleichzeitigen Anfragen
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"book:" + org.id}))`);
    const [svc] = await tx
      .select({ id: services.id, name: services.name, durationMin: services.durationMin })
      .from(services)
      .where(and(eq(services.organizationId, org.id), eq(services.id, d.serviceId), eq(services.active, true)));
    if (!svc) return { error: "Leistung nicht verfügbar." };
    const end = new Date(start.getTime() + svc.durationMin * 60_000);
    const clash = await tx.select({ id: appointments.id, status: appointments.status }).from(appointments).where(and(eq(appointments.organizationId, org.id), lt(appointments.startsAt, end), gte(appointments.endsAt, start)));
    if (clash.some((c) => c.status !== "cancelled")) return { error: "Dieser Termin wurde gerade vergeben. Bitte einen anderen wählen." };
    // Sicherheit: Eine öffentliche Anfrage wird NIE automatisch an eine bestehende Akte gehängt
    // (sonst könnte jemand mit Name + Telefonnummer fremde Akten verändern). Die Praxis ordnet im Posteingang zu.
    const initials = `${d.firstName} ${d.lastName.slice(0, 1)}.`;
    const [a] = await tx
      .insert(appointments)
      .values({ organizationId: org.id, patientId: null, startsAt: start, endsAt: end, status: "planned", source: "online", title: `Online-Anfrage: ${initials} · ${svc.name}`, notes: "Unbestätigt – Kunde im Posteingang zuordnen und Termin bestätigen." })
      .returning({ id: appointments.id });
    await tx.insert(appointmentServices).values({ organizationId: org.id, appointmentId: a.id, serviceId: svc.id });
    await tx.insert(messages).values({
      organizationId: org.id,
      patientId: null,
      channel: d.email ? "email" : "sms",
      direction: "inbound",
      fromAddress: d.email || d.phone,
      subject: "Neue Online-Buchung (unbestätigt)",
      body: [
        `Online-Anfrage: ${svc.name} am ${d.date} um ${d.time} Uhr.`,
        `Name: ${d.firstName} ${d.lastName}`,
        `Telefon: ${d.phone}${d.email ? ` · E-Mail: ${d.email}` : ""}`,
        `Datenschutzhinweise und Ausfallregelung bei der Buchung bestätigt (${new Date().toISOString()}).`,
        d.note ? `Notiz: ${d.note}` : null,
        "Bitte Kunde zuordnen (bestehend oder neu) und Termin bestätigen.",
      ].filter(Boolean).join("\n"),
      status: "new",
    });
    return { ok: true as const, appointmentId: a.id };
  });
  if ("error" in result) return { error: result.error };
  await audit({ organizationId: org.id, action: "booking.online", entity: "appointment", entityId: result.appointmentId });
  return { ok: "Danke! Deine Anfrage ist eingegangen. Die Praxis bestätigt den Termin kurzfristig." };
}
