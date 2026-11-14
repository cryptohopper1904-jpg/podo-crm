"use server";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, withOrg } from "@/db";
import { appointmentServices, appointments, messages, organizations } from "@/db/schema";
import { audit } from "@/lib/audit";
import { berlinToUtc } from "@/lib/format";
import { requestMeta } from "@/lib/auth/session";
import { ONLINE_REQUEST_SUBJECT, onlineRequestKey, singleLine } from "@/lib/online-request";
import { checkPublicSlot, publicBookingAvailable, clashes, lockBooking, overDayLimit } from "@/server/portal-booking";

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
  // eine Zeile (der Name steht in einer eigenen Zeile der Posteingangs-Nachricht und in messages.meta)
  firstName: z.string().transform(singleLine).pipe(z.string().min(1, "Vorname fehlt").max(80)),
  lastName: z.string().transform(singleLine).pipe(z.string().min(1, "Nachname fehlt").max(80)),
  phone: z.string().trim().min(6, "Telefonnummer fehlt").max(40),
  email: z.string().trim().email("E-Mail ungültig").max(200).optional().or(z.literal("")),
  note: z.string().trim().max(500).optional(),
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
  // Unbekannt, Löschantrag, Online-Buchung aus oder Nur-Lesen: nach außen nicht unterscheidbar (wie die 404 der Seite)
  if (!org || !(await publicBookingAvailable(org.id))) return { error: "Praxis nicht gefunden." };
  const start = berlinToUtc(d.date, d.time);
  // Serverseitig dieselbe Verfügbarkeit wie Portal/Telefon: Freigabe, Leistungsliste, Arbeitszeiten, Abwesenheiten,
  // Feiertage, Vorlauf und Buchungsfenster – nur exakt angebotene Startzeiten (Gesamt-Review M1)
  const check = await checkPublicSlot(org.id, d.serviceId, start);
  if (!check.ok) return { error: check.error };
  const svc = check.service;
  const end = new Date(start.getTime() + svc.durationMin * 60_000);

  const result = await withOrg(org.id, async (tx) => {
    // Buchungen je Praxis serialisieren → keine Doppelbelegung bei gleichzeitigen Anfragen (gleiche Sperre wie überall)
    await lockBooking(tx, org.id);
    if (await clashes(tx, org.id, start, end)) return { error: "Dieser Termin wurde gerade vergeben. Bitte einen anderen wählen." };
    if (await overDayLimit(tx, org.id, check.cfg, start)) return { error: "An diesem Tag sind keine Online-Termine mehr frei. Bitte einen anderen Tag wählen." };
    // Sicherheit: Eine öffentliche Anfrage wird NIE automatisch an eine bestehende Akte gehängt
    // (sonst könnte jemand mit Name + Telefonnummer fremde Akten verändern). Die Praxis ordnet im Posteingang zu.
    const initials = `${d.firstName} ${d.lastName.slice(0, 1)}.`;
    // Kennzeichen „online-request:<id>“ an Termin (external_id) und Nachricht (thread_key): nur so markierte Anfragen
    // löscht die Aufbewahrung nach 6 Monaten (src/server/online-request-retention.ts), samt genau dieser Nachricht
    const id = randomUUID();
    const key = onlineRequestKey(id);
    const [a] = await tx
      .insert(appointments)
      .values({ id, organizationId: org.id, patientId: null, startsAt: start, endsAt: end, status: "planned", source: "online", externalId: key, title: `Online-Anfrage: ${initials} · ${svc.name}`, notes: "Unbestätigt – Patient im Posteingang zuordnen und Termin bestätigen." })
      .returning({ id: appointments.id });
    await tx.insert(appointmentServices).values({ organizationId: org.id, appointmentId: a.id, serviceId: svc.id });
    await tx.insert(messages).values({
      organizationId: org.id,
      patientId: null,
      channel: d.email ? "email" : "sms",
      direction: "inbound",
      fromAddress: d.email || d.phone,
      subject: ONLINE_REQUEST_SUBJECT,
      threadKey: key,
      // Name strukturiert: wird vor einem KI-Antwortvorschlag zuverlässig entfernt (src/lib/online-request.ts)
      meta: { onlineRequest: { firstName: d.firstName, lastName: d.lastName } },
      body: [
        `Online-Anfrage: ${svc.name} am ${d.date} um ${d.time} Uhr.`,
        `Name: ${d.firstName} ${d.lastName}`,
        `Telefon: ${d.phone}${d.email ? ` · E-Mail: ${d.email}` : ""}`,
        `Ausfallregelung bei der Buchung bestätigt; Datenschutzhinweise verlinkt (${new Date().toISOString()}).`,
        d.note ? `Notiz: ${d.note}` : null,
        "Bitte Patient zuordnen (bestehend oder neu) und Termin bestätigen.",
      ].filter(Boolean).join("\n"),
      status: "new",
    });
    return { ok: true as const, appointmentId: a.id };
  });
  if ("error" in result) return { error: result.error };
  await audit({ organizationId: org.id, action: "booking.online", entity: "appointment", entityId: result.appointmentId });
  return { ok: "Vielen Dank! Ihre Terminanfrage ist eingegangen. Der Termin ist erst verbindlich, wenn die Praxis ihn bestätigt. Die Praxis meldet sich dazu bei Ihnen." };
}
