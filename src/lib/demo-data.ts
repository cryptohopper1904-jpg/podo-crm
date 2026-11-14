/**
 * Erfundene Beispieldaten für eine Demo-Praxis (KEINE echten Patient:innen – Namen, Adressen und Befunde sind
 * ausgedacht, E-Mail-Adressen nur @example.org). Genutzt von scripts/seed-demo.ts (eigene Demo-Inhaber:in) und
 * vom Bootstrap (src/lib/bootstrap.ts: „Demo-Praxis (Beispieldaten)“ für den Plattform-Admin).
 * Läuft im migrate-Container – nur relative Importe ohne Next-Abhängigkeiten (siehe deploy/Dockerfile.migrate).
 */
import { eq, sql } from "drizzle-orm";
import type { Tx } from "../db";
import * as s from "../db/schema";
import { DEFAULT_SERVICES, seedServiceCategories } from "./org-defaults";
import { chainHash } from "./records";

/** Stammdaten der Demo-Praxis (fiktiv) */
export const DEMO_PRACTICE_FIELDS = {
  legalName: "Podologische Praxis Demo",
  street: "Musterstraße 1",
  zip: "16540",
  city: "Hohen Neuendorf",
  phone: "03303 000000",
  email: "praxis@example.org",
  iban: "DE00 0000 0000 0000 0000 00",
  state: "BB",
} as const;

const PEOPLE = [
  ["Frau", "Erika", "Beispiel", "1952-03-14", "Hohen Neuendorf", true, false],
  ["Herr", "Hans", "Muster", "1948-11-02", "Birkenwerder", true, true],
  ["Frau", "Gisela", "Probe", "1960-06-21", "Glienicke/Nordbahn", false, false],
  ["Herr", "Karl", "Testmann", "1939-01-30", "Hohen Neuendorf", true, true],
  ["Frau", "Monika", "Demo", "1971-09-09", "Oranienburg", false, false],
  ["Herr", "Peter", "Platzhalter", "1955-04-17", "Mühlenbecker Land", false, false],
  ["Frau", "Ursula", "Fiktiv", "1944-12-24", "Hohen Neuendorf", true, false],
  ["Divers", "Alex", "Musterperson", "1990-07-07", "Berlin", false, false],
] as const;

/**
 * Füllt eine (leere) Praxis mit erfundenen Beispieldaten. Erwartet eine Transaktion; setzt app.org_id selbst
 * (mandantengeschützte Tabellen, RLS). `ownerUserId` wird Behandler:in der Termine und Autor:in der Doku.
 */
export async function seedDemoPracticeData(tx: Tx, orgId: string, ownerUserId: string): Promise<void> {
  await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
  await tx.insert(s.locations).values({ organizationId: orgId, name: "Hauptpraxis" });
  await seedServiceCategories(tx, orgId);
  const svc = await tx
    .insert(s.services)
    .values(DEFAULT_SERVICES.map((x) => ({ organizationId: orgId, code: x.code, name: x.name, priceCents: x.priceCents, vatRate: x.vatRate, durationMin: x.durationMin, category: x.category, requiresTherapeuticPurpose: !("requiresTherapeuticPurpose" in x) })))
    .returning();
  const providers = ["lexoffice", "sumup", "doctolib", "google_business", "email_imap", "whatsapp", "sms", "voice_agent", "transcription", "llm", "calendar_ics"] as const;
  await tx.insert(s.integrationConnections).values(providers.map((provider) => ({ organizationId: orgId, provider, status: "mock" as const })));

  const pts = await tx
    .insert(s.patients)
    .values(
      PEOPLE.map(([salutation, firstName, lastName, birthDate, city, diabetes, anticoag], i) => ({
        organizationId: orgId,
        number: i + 1,
        salutation,
        firstName,
        lastName,
        birthDate,
        city,
        zip: "16540",
        street: `Beispielweg ${i + 3}`,
        phoneMobile: `0151 0000000${i}`,
        email: `${firstName.toLowerCase()}@example.org`,
        preferredChannel: (i % 3 === 0 ? "whatsapp" : i % 3 === 1 ? "sms" : "email") as "whatsapp" | "sms" | "email",
        insuranceType: (diabetes ? "gkv" : "self") as "gkv" | "self",
        insurerName: diabetes ? "AOK Nordost" : null,
        riskFlags: { diabetes, diabetesType: diabetes ? "Typ 2" : undefined, anticoagulation: anticoag },
        homeVisit: i === 3,
        visitIntervalWeeks: 6,
        source: "demo",
      })),
    )
    .returning();

  // Termine heute und in den letzten Wochen
  const now = new Date();
  const base = new Date(now);
  base.setHours(8, 30, 0, 0);
  const pk = svc.find((x) => x.code === "PK")!;
  for (let i = 0; i < 6; i++) {
    const start = new Date(base.getTime() + i * 50 * 60_000);
    await tx.insert(s.appointments).values({
      organizationId: orgId,
      patientId: pts[i].id,
      therapistId: ownerUserId,
      startsAt: start,
      endsAt: new Date(start.getTime() + 40 * 60_000),
      status: i === 0 ? "done" : "confirmed",
      source: i % 2 ? "doctolib" : "phone",
      title: i === 1 ? "Nagelspange setzen" : pk.name,
      homeVisit: i === 3,
    });
  }
  const lastHash = new Map<string, string>();
  for (let w = 10; w >= 1; w--) {
    const p = pts[w % pts.length];
    const start = new Date(base.getTime() - w * 7 * 86400_000);
    const [appt] = await tx.insert(s.appointments).values({ organizationId: orgId, patientId: p.id, therapistId: ownerUserId, startsAt: start, endsAt: new Date(start.getTime() + 40 * 60_000), status: "done", source: "phone", title: pk.name }).returning();
    const content = { findings: "Hyperkeratose plantar, Nägel verdickt", servicesText: pk.name, at: start.toISOString() };
    const prevHash = lastHash.get(p.id) ?? null;
    const hash = chainHash(prevHash, { ...content, w });
    lastHash.set(p.id, hash);
    await tx.insert(s.treatmentRecords).values({ organizationId: orgId, patientId: p.id, authorId: ownerUserId, treatedAt: start, appointmentId: appt.id, findings: content.findings, servicesText: content.servicesText, prevHash, hash });
    // bezahlte Quittung
    const [inv] = await tx.insert(s.invoices).values({ organizationId: orgId, patientId: p.id, kind: "receipt", status: "draft", createdBy: ownerUserId }).returning();
    await tx.insert(s.invoiceLines).values({ organizationId: orgId, invoiceId: inv.id, serviceId: pk.id, description: pk.name, unitPriceCents: pk.priceCents, vatRate: 0, totalCents: pk.priceCents });
    await tx.update(s.invoices).set({ status: "paid", number: `Q${start.getFullYear()}-${String(w).padStart(4, "0")}`, issuedAt: start.toISOString().slice(0, 10), netCents: pk.priceCents, totalCents: pk.priceCents, paidCents: pk.priceCents }).where(eq(s.invoices.id, inv.id));
    await tx.insert(s.payments).values({ organizationId: orgId, invoiceId: inv.id, method: w % 2 ? "cash" : "card", amountCents: pk.priceCents, paidAt: start, createdBy: ownerUserId });
  }
  await tx.insert(s.numberSequences).values({ organizationId: orgId, key: "receipt", year: now.getFullYear(), next: 11 });

  await tx.insert(s.messages).values([
    { organizationId: orgId, patientId: pts[0].id, channel: "whatsapp", direction: "inbound", fromAddress: "0151 00000000", body: "Kann ich meinen Termin am Dienstag auf nachmittags schieben?", status: "new" },
    { organizationId: orgId, channel: "email", direction: "inbound", fromAddress: "neu@example.org", subject: "Terminanfrage", body: "Guten Tag, ich hätte gern einen Termin für eine Fußpflege. Haben Sie nächste Woche etwas frei?", status: "new" },
  ]);
  await tx.insert(s.reviews).values([
    { organizationId: orgId, externalId: "demo-1", author: "M. K.", rating: 5, text: "Sehr freundlich und gründlich, ich komme gern wieder!" },
    { organizationId: orgId, externalId: "demo-2", author: "Anonym", rating: 3, text: "Gute Behandlung, aber lange Wartezeit am Telefon." },
  ]);
  await tx.insert(s.fixedCosts).values([
    { organizationId: orgId, category: "Miete", amountCents: 80000, interval: "monthly", startDate: "2026-01-01" },
    { organizationId: orgId, category: "Strom", amountCents: 5000, interval: "monthly", startDate: "2026-01-01" },
    { organizationId: orgId, category: "Berufshaftpflicht", amountCents: 13517, interval: "yearly", startDate: "2026-02-06" },
    { organizationId: orgId, category: "Software & Telefon", amountCents: 6000, interval: "monthly", startDate: "2026-01-01" },
  ]);
  await tx.insert(s.tasks).values([
    { organizationId: orgId, title: "Sterilisator: Validierung bis Monatsende beauftragen", kind: "hygiene" },
    { organizationId: orgId, title: "Doctolib-Partnerantrag stellen", kind: "manual" },
  ]);
}
