import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectFiles } from "./collect";
import { buildPlan, pseudonym, type ExistingSnapshot } from "./plan";
import { buildZip } from "./zip";

const FIX = path.resolve(__dirname, "../__fixtures__/tinana");
const TINANA = ["patients_export_2026-01-15.csv", "appointments_export_2026-01-15.csv", "prescriptions_export_2026-01-15.csv", "doctors_export_2026-01-15.csv", "invoices_export_2026-01-15.csv"];
const pdf = (n: string) => new TextEncoder().encode(`%PDF-1.4\n% Rechnung ${n}\n%%EOF`);

export async function tinanaUpload() {
  return collectFiles([
    ...TINANA.map((n) => ({ name: n, data: new Uint8Array(readFileSync(path.join(FIX, n))) })),
    { name: "rechnungen_pdf_export_2026-01-15.zip", data: buildZip(["RE-2026-00001", "RE-2026-00002", "RE-2026-00003", "RE-2099-00009"].map((n) => ({ path: `${n}.pdf`, data: pdf(n) }))) },
  ]);
}

const empty = (): ExistingSnapshot => ({
  patients: [],
  appointmentRefs: new Set(),
  prescriptionRefs: new Set(),
  documentHashes: new Set(),
  therapists: [],
  locations: [],
  services: [],
});
const NOW = new Date("2026-01-13T08:00:00Z");

describe("Übernahme-Plan (Tinana)", () => {
  it("leere Praxis: alles neu, Verordnungen über Name+Geburtsdatum, PDFs nur bei eindeutiger Zuordnung", async () => {
    const plan = buildPlan(await tinanaUpload(), empty(), { prescriptionMode: "billed", now: NOW });
    expect(plan.totals).toMatchObject({
      patientsNew: 4,
      patientsLinked: 0,
      appointmentsNew: 3,
      prescriptionsNew: 2,
      prescriptionsUnassigned: 0,
      documentsNew: 2,
      documentsUnassigned: 2,
      invoicesInfo: 3,
    });
    expect(plan.hasWork).toBe(true);
    // Kasse/Versichertennummer aus der jüngsten Verordnung
    const erika = plan.patientsCreate.find((p) => p.values.lastName === "Musterfrau")!;
    expect(erika.values).toMatchObject({ insurerName: "Beispiel-BKK", insuranceNumber: "A000000001", externalIds: { tinana: "10000000-0000-4000-8000-000000000001" }, source: "tinana-import" });
    expect(erika.values.extra).toMatchObject({ payerIk: "100000001", gender: "female" });
    // Termine: vergangen + Stattgefunden → erledigt; Zukunft geplant
    expect(plan.appointments.map((a) => a.status)).toEqual(["done", "planned", "planned"]);
    expect(plan.appointments[0].notes).toMatch(/Dokumentation \(Tinana\): Hornhaut/);
    // Verordnungen als abgerechnet (keine Doppelabrechnung), Rohdaten bleiben nachvollziehbar
    expect(plan.prescriptions[0].values).toMatchObject({ status: "billed", diagnosisGroup: "DF", units: 6, doctorLanr: "999999999" });
    expect(plan.prescriptions[0].values.importData).toMatchObject({ source: "tinana", billedOutside: true });
    // Rechnungen: nur PDFs von Standard/Zuzahlung, GKV-Abrechnung und unbekannte Nummer nicht
    expect(plan.documents.map((d) => d.name).sort()).toEqual(["RE-2026-00001.pdf", "RE-2026-00002.pdf"]);
    const notes = plan.files.filter((f) => f.label === "PDF-Dokument").map((f) => f.note);
    expect(notes.some((n) => /GKV-Abrechnung/.test(n ?? ""))).toBe(true);
    expect(notes.some((n) => /Keine passende Rechnungsnummer/.test(n ?? ""))).toBe(true);
    expect(plan.warnings.some((w) => /nicht als PodoHero-Rechnungen/.test(w.message))).toBe(true);
  });

  it("Beispielzeilen sind pseudonymisiert (keine vollen Namen)", async () => {
    const plan = buildPlan(await tinanaUpload(), empty(), { prescriptionMode: "billed", now: NOW });
    const all = [...plan.samples.patients, ...plan.samples.appointments, ...plan.samples.prescriptions, ...plan.samples.documents].join("\n");
    expect(all).not.toMatch(/Musterfrau|Mustermann|Erika/);
    expect(pseudonym("Erika", "Musterfrau", "1950-04-03")).toBe("E. M. (Jg. 1950)");
  });

  it("vorhandene Person (gleicher Name + Geburtsdatum) wird verknüpft statt doppelt angelegt", async () => {
    const ex = empty();
    ex.patients.push({ id: "p-1", number: 7, firstName: "Erika", lastName: "Musterfrau", birthDate: "1950-04-03", email: "andere@example.org", phoneMobile: null, externalIds: {} });
    const plan = buildPlan(await tinanaUpload(), ex, { prescriptionMode: "active", now: NOW });
    expect(plan.totals).toMatchObject({ patientsNew: 3, patientsLinked: 1 });
    expect(plan.patientsLink).toEqual([{ patientId: "p-1", key: "tinana", externalId: "10000000-0000-4000-8000-000000000001" }]);
    expect(plan.appointments[0].patient).toEqual({ existingId: "p-1" });
    expect(plan.prescriptions[0]).toMatchObject({ patient: { existingId: "p-1" }, values: { status: "active" } });
  });

  it("zweiter Lauf: bereits übernommene Datensätze werden übersprungen (idempotent)", async () => {
    const first = buildPlan(await tinanaUpload(), empty(), { prescriptionMode: "billed", now: NOW });
    const ex = empty();
    first.patientsCreate.forEach((c, i) => ex.patients.push({ id: `p${i}`, number: i + 1, firstName: c.values.firstName, lastName: c.values.lastName, birthDate: c.values.birthDate, email: c.values.email, phoneMobile: c.values.phoneMobile, externalIds: c.values.externalIds }));
    first.appointments.forEach((a) => ex.appointmentRefs.add(a.externalId));
    first.prescriptions.forEach((p) => ex.prescriptionRefs.add(p.externalRef));
    const idOf = (ref: string) => `p${first.patientsCreate.findIndex((c) => c.ref === ref)}`;
    first.documents.forEach((d) => ex.documentHashes.add(`${"ref" in d.patient ? idOf(d.patient.ref) : d.patient.existingId}|${d.sha256}`));
    const second = buildPlan(await tinanaUpload(), ex, { prescriptionMode: "billed", now: NOW });
    expect(second.totals).toMatchObject({ patientsNew: 0, patientsExisting: 4, appointmentsNew: 0, appointmentsExisting: 3, prescriptionsNew: 0, prescriptionsExisting: 2, documentsNew: 0, documentsExisting: 2 });
    expect(second.hasWork).toBe(false);
  });

  it("Dubletten-Hinweise: Bestand (findDuplicates-Kriterien) und innerhalb des Uploads", async () => {
    const ex = empty();
    ex.patients.push({ id: "x", number: 12, firstName: "Andere", lastName: "Mustermann", birthDate: "1962-11-17", email: null, phoneMobile: null, externalIds: {} });
    const plan = buildPlan(await tinanaUpload(), ex, { prescriptionMode: "billed", now: NOW });
    expect(plan.warnings.some((w) => /mögliche Dublette zu Nr\. 12/.test(w.message))).toBe(true);
  });

  it("Verordnung ohne passende Patient:in wird nicht übernommen, sondern gemeldet", async () => {
    const files = (await tinanaUpload()).filter((f) => f.kind !== "tinana.patients");
    const plan = buildPlan(files, empty(), { prescriptionMode: "billed", now: NOW });
    expect(plan.totals).toMatchObject({ prescriptionsNew: 0, prescriptionsUnassigned: 2, appointmentsNew: 0, appointmentsUnassigned: 3 });
    expect(plan.warnings.some((w) => /keine Patient:in mit gleichem Namen und Geburtsdatum/.test(w.message))).toBe(true);
  });

  it("Behandler:in und Leistungen werden über den Namen zugeordnet", async () => {
    const ex = empty();
    ex.therapists.push({ id: "u1", name: "Therapeutin Eins" });
    ex.services.push({ id: "s1", name: "Podologische Behandlung (groß)", code: "PBG" }, { id: "s2", name: "Podologische Befundung", code: "PBF" });
    const plan = buildPlan(await tinanaUpload(), ex, { prescriptionMode: "billed", now: NOW });
    expect(plan.appointments[0]).toMatchObject({ therapistId: "u1", serviceIds: ["s1", "s2"] });
    expect(plan.appointments[1].therapistId).toBeNull();
    expect(plan.warnings.some((w) => /Therapeut Zwei/.test(w.message))).toBe(true);
  });
});
