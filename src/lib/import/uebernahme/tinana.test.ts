import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decimalCents, mapAppointmentStatus, parseTinanaAppointments, parseTinanaInvoices, parseTinanaPatients, parseTinanaPrescriptions } from "./tinana";

const read = (name: string) => readFileSync(path.resolve(__dirname, "../__fixtures__/tinana", name), "utf8");

describe("Tinana-Parser", () => {
  it("Patienten: Anrede, Geburtsdatum, Telefon nach Label, Versicherung, Notiz mit Semikolon", () => {
    const { patients, issues } = parseTinanaPatients(read("patients_export_2026-01-15.csv"));
    expect(issues).toEqual([]);
    expect(patients).toHaveLength(4);
    expect(patients[0]).toMatchObject({
      id: "10000000-0000-4000-8000-000000000001",
      salutation: "Frau",
      firstName: "Erika",
      lastName: "Musterfrau",
      gender: "female",
      birthDate: "1950-04-03",
      street: "Teststraße 1",
      zip: "12345",
      phoneMobile: "0151 0000001",
      phoneLandline: "030 0000001",
      notes: "Diabetikerin; Marcumar",
      insuranceType: "gkv",
      vip: false,
    });
    expect(patients[1]).toMatchObject({ title: "Dr.", insuranceType: "pkv", vip: true, street: "Musterweg 12a" });
    // führende Null der PLZ bleibt erhalten, leere Versicherungsart → Selbstzahler
    expect(patients[2]).toMatchObject({ zip: "01001", insuranceType: "self", insuranceRaw: null, salutation: "Divers" });
    expect(patients[3]).toMatchObject({ lastName: "Probe", birthDate: null, street: null });
  });

  it("Termine: Berliner Ortszeit, Hausbesuch, Wegzeiten, Dokumentation", () => {
    const { appointments, issues } = parseTinanaAppointments(read("appointments_export_2026-01-15.csv"));
    expect(issues).toEqual([]);
    expect(appointments[0]).toMatchObject({
      id: "20000000-0000-4000-8000-000000000001",
      patientId: "10000000-0000-4000-8000-000000000001",
      startsAt: "2026-01-12T09:15:00+01:00",
      endsAt: "2026-01-12T10:05:00+01:00",
      statusRaw: "Stattgefunden",
      therapistName: "Therapeutin Eins",
      documentation: "Hornhaut abgetragen, Nägel gekürzt",
      homeVisit: false,
    });
    expect(appointments[1]).toMatchObject({ homeVisit: true, travel: expect.stringContaining("6.5 km") });
  });

  it("Terminstatus: vergangene „Geplant“ → erledigt (angenommen), Absagen → abgesagt", () => {
    const now = new Date("2026-01-13T12:00:00Z");
    expect(mapAppointmentStatus("Stattgefunden", "2026-01-12T09:15:00+01:00", now)).toEqual({ status: "done", assumed: false });
    expect(mapAppointmentStatus("Geplant", "2026-01-12T09:15:00+01:00", now)).toEqual({ status: "done", assumed: true });
    expect(mapAppointmentStatus("Geplant", "2026-01-14T09:15:00+01:00", now)).toEqual({ status: "planned", assumed: false });
    expect(mapAppointmentStatus("Vom Patienten abgesagt", "2026-01-12T09:15:00+01:00", now).status).toBe("cancelled");
    expect(mapAppointmentStatus("Nicht erschienen", "2026-01-12T09:15:00+01:00", now).status).toBe("no_show");
  });

  it("Verordnungen: eine Zeile je Heilmittel → gruppiert, Diagnosegruppe gekürzt, Preise als Cent", () => {
    const { prescriptions, issues } = parseTinanaPrescriptions(read("prescriptions_export_2026-01-15.csv"));
    expect(issues).toEqual([]);
    expect(prescriptions).toHaveLength(2);
    const [erika, kim] = prescriptions;
    expect(erika).toMatchObject({
      rows: [2, 3],
      issuedAt: "2026-01-08",
      patientFirstName: "Erika",
      patientBirthDate: "1950-04-03",
      doctorName: "Dr. med. Ärztin Beispiel",
      doctorLanr: "999999999",
      diagnosisGroup: "DF",
      icd10: "E11.74",
      units: 6,
      insurerName: "Beispiel-BKK",
      insuranceNumber: "A000000001",
    });
    expect(erika.positions).toEqual([
      { position: "X8020", code: "PB-G", label: "Podologische Behandlung (groß)", units: 6, priceCents: 5192 },
      { position: "X8030", code: "PBF", label: "Podologische Befundung", units: 6, priceCents: 357 },
    ]);
    expect(kim).toMatchObject({ diagnosisGroup: "UI1", homeVisit: true, units: 8 });
    expect(erika.key).not.toBe(kim.key);
    // stabiler Schlüssel (Idempotenz): gleicher Inhalt → gleicher Schlüssel
    expect(parseTinanaPrescriptions(read("prescriptions_export_2026-01-15.csv")).prescriptions[0].key).toBe(erika.key);
  });

  it("Rechnungen: Beträge mit Punkt, Typ, Patient leer bei GKV-Abrechnung", () => {
    const inv = parseTinanaInvoices(read("invoices_export_2026-01-15.csv"));
    expect(inv.map((i) => [i.number, i.type, i.totalCents, i.patientLastName])).toEqual([
      ["RE-2026-00003", "Abrechnung", 1080, null],
      ["RE-2026-00002", "Standard", 3500, "Mustermann"],
      ["RE-2026-00001", "Zuzahlung", 4330, "Musterfrau"],
    ]);
  });

  it("decimalCents: Punkt und Komma, ohne Tausendertrennung", () => {
    expect(decimalCents("51.92")).toBe(5192);
    expect(decimalCents("57.2")).toBe(5720);
    expect(decimalCents("75")).toBe(7500);
    expect(decimalCents("171,00")).toBe(17100);
    expect(decimalCents("-12,50")).toBe(-1250);
    expect(decimalCents("")).toBeNull();
  });
});
