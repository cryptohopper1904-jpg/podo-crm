/**
 * Legt eine Demo-Praxis mit ERFUNDENEN Daten an (keine echten Patienten!).
 * Aufruf: pnpm db:seed   (nutzt DATABASE_URL = App-Rolle; RLS über app.org_id)
 * Login danach: demo@podocrm.local – Passwort siehe src/lib/demo-seed.ts (Gesamt-Review K1):
 *   - SEED_DEMO_PASSWORD gesetzt → dieses Passwort
 *   - PUBLIC_URL ist eine echte Domain → Zufallspasswort, wird EINMAL hier ausgegeben (migrate-Log)
 *   - sonst (localhost/IP) → demo-passwort-123
 * Die Inhaber:in muss beim ersten Login 2FA einrichten (Pflicht für Inhaber:innen, Gesamt-Review H1).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { hash } from "@node-rs/argon2";
import * as s from "../src/db/schema";
import { DEFAULT_SERVICES } from "../src/lib/org-defaults";
import { chainHash } from "../src/lib/records";
import { DEMO_EMAIL, resolveDemoPassword } from "../src/lib/demo-seed";

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

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema: s });
  const email = DEMO_EMAIL;
  const demo = resolveDemoPassword(process.env);
  const [existing] = await db.select().from(s.users).where(eq(s.users.email, email));
  if (existing) {
    console.log("Demo existiert bereits.");
    await pool.end();
    return;
  }
  await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(s.organizations)
      .values({ name: "Podologie Demo", slug: `demo-${Date.now().toString(36)}`, legalName: "Podologische Praxis Demo", street: "Musterstraße 1", zip: "16540", city: "Hohen Neuendorf", phone: "03303 000000", email: "praxis@example.org", iban: "DE00 0000 0000 0000 0000 00", state: "BB" })
      .returning();
    const [user] = await tx.insert(s.users).values({ email, name: "Dana Demo", passwordHash: await hash(demo.password) }).returning();
    await tx.insert(s.memberships).values({ organizationId: org.id, userId: user.id, role: "owner" });
    await tx.execute(sql`select set_config('app.org_id', ${org.id}, true)`);
    await tx.insert(s.locations).values({ organizationId: org.id, name: "Hauptpraxis" });
    const svc = await tx
      .insert(s.services)
      .values(DEFAULT_SERVICES.map((x) => ({ organizationId: org.id, code: x.code, name: x.name, priceCents: x.priceCents, vatRate: x.vatRate, durationMin: x.durationMin, category: x.category, requiresTherapeuticPurpose: !("requiresTherapeuticPurpose" in x) })))
      .returning();
    const providers = ["lexoffice", "sumup", "doctolib", "google_business", "email_imap", "whatsapp", "sms", "voice_agent", "transcription", "llm", "calendar_ics"] as const;
    await tx.insert(s.integrationConnections).values(providers.map((provider) => ({ organizationId: org.id, provider, status: "mock" as const })));

    const pts = await tx
      .insert(s.patients)
      .values(
        PEOPLE.map(([salutation, firstName, lastName, birthDate, city, diabetes, anticoag], i) => ({
          organizationId: org.id,
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
        organizationId: org.id,
        patientId: pts[i].id,
        therapistId: user.id,
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
      const [appt] = await tx.insert(s.appointments).values({ organizationId: org.id, patientId: p.id, therapistId: user.id, startsAt: start, endsAt: new Date(start.getTime() + 40 * 60_000), status: "done", source: "phone", title: pk.name }).returning();
      const content = { findings: "Hyperkeratose plantar, Nägel verdickt", servicesText: pk.name, at: start.toISOString() };
      const prevHash = lastHash.get(p.id) ?? null;
      const hash = chainHash(prevHash, { ...content, w });
      lastHash.set(p.id, hash);
      await tx.insert(s.treatmentRecords).values({ organizationId: org.id, patientId: p.id, authorId: user.id, treatedAt: start, appointmentId: appt.id, findings: content.findings, servicesText: content.servicesText, prevHash, hash });
      // bezahlte Quittung
      const [inv] = await tx.insert(s.invoices).values({ organizationId: org.id, patientId: p.id, kind: "receipt", status: "draft", createdBy: user.id }).returning();
      await tx.insert(s.invoiceLines).values({ organizationId: org.id, invoiceId: inv.id, serviceId: pk.id, description: pk.name, unitPriceCents: pk.priceCents, vatRate: 0, totalCents: pk.priceCents });
      await tx.update(s.invoices).set({ status: "paid", number: `Q${start.getFullYear()}-${String(w).padStart(4, "0")}`, issuedAt: start.toISOString().slice(0, 10), netCents: pk.priceCents, totalCents: pk.priceCents, paidCents: pk.priceCents }).where(eq(s.invoices.id, inv.id));
      await tx.insert(s.payments).values({ organizationId: org.id, invoiceId: inv.id, method: w % 2 ? "cash" : "card", amountCents: pk.priceCents, paidAt: start, createdBy: user.id });
    }
    await tx.insert(s.numberSequences).values({ organizationId: org.id, key: "receipt", year: now.getFullYear(), next: 11 });

    await tx.insert(s.messages).values([
      { organizationId: org.id, patientId: pts[0].id, channel: "whatsapp", direction: "inbound", fromAddress: "0151 00000000", body: "Kann ich meinen Termin am Dienstag auf nachmittags schieben?", status: "new" },
      { organizationId: org.id, channel: "email", direction: "inbound", fromAddress: "neu@example.org", subject: "Terminanfrage", body: "Guten Tag, ich hätte gern einen Termin für eine Fußpflege. Haben Sie nächste Woche etwas frei?", status: "new" },
    ]);
    await tx.insert(s.reviews).values([
      { organizationId: org.id, externalId: "demo-1", author: "M. K.", rating: 5, text: "Sehr freundlich und gründlich, ich komme gern wieder!" },
      { organizationId: org.id, externalId: "demo-2", author: "Anonym", rating: 3, text: "Gute Behandlung, aber lange Wartezeit am Telefon." },
    ]);
    await tx.insert(s.fixedCosts).values([
      { organizationId: org.id, category: "Miete", amountCents: 80000, interval: "monthly", startDate: "2026-01-01" },
      { organizationId: org.id, category: "Strom", amountCents: 5000, interval: "monthly", startDate: "2026-01-01" },
      { organizationId: org.id, category: "Berufshaftpflicht", amountCents: 13517, interval: "yearly", startDate: "2026-02-06" },
      { organizationId: org.id, category: "Software & Telefon", amountCents: 6000, interval: "monthly", startDate: "2026-01-01" },
    ]);
    await tx.insert(s.tasks).values([
      { organizationId: org.id, title: "Sterilisator: Validierung bis Monatsende beauftragen", kind: "hygiene" },
      { organizationId: org.id, title: "Doctolib-Partnerantrag stellen", kind: "manual" },
    ]);
  });
  if (demo.source === "well-known") {
    console.log(`Demo-Praxis angelegt: ${email} / ${demo.password}  (bekanntes Passwort – nur lokal/IP)`);
  } else if (demo.source === "generated") {
    // Einziges Mal, dass dieses Passwort sichtbar ist (nicht gespeichert, nur als Hash in der DB)
    console.log(`Demo-Praxis angelegt: ${email} / ${demo.password}`);
    console.log("ACHTUNG: Zufallspasswort – nur in diesem Log. Bitte jetzt notieren; beim ersten Login wird 2FA eingerichtet.");
  } else {
    console.log(`Demo-Praxis angelegt: ${email} / (Passwort aus SEED_DEMO_PASSWORD)`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
