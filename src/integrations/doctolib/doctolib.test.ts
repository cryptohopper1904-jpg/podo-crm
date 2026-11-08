import { describe, expect, it } from "vitest";
import { DOCTOLIB_PATIENT_COLUMNS, parseDoctolibPatientsCsv, writeDoctolibPatientsCsv } from "./csv";
import { DoctolibMock } from "./doctolib";
import { parseDoctolibEmail } from "./email";

const header = DOCTOLIB_PATIENT_COLUMNS.join(";");
const csv =
  "﻿" +
  header +
  "\n" +
  '101;;female;Beispiel;Muster;Erika;01/02/1950;Erika@Example.org;030 1234567;0171 1234567;"Musterweg 1";12345;Musterstadt;public;AOK;"Diabetes; Marcumar";Dr. Weiß;Rentnerin;Dr. Hausarzt;Musterstadt;"Notiz mit ""Zitat""";true\n' +
  "102;;male;Mustermann;;Max;1960-13-01;;;;;;;private;;;;;;;;false\n" +
  ";;;;;;;;;;;;;;;;;;;;;\n" +
  "103;;;;;Ohne;;;;;;;;;;;;;;;;\n";

describe("Doctolib-CSV", () => {
  it("importiert 22-Spalten-Patientenexport", async () => {
    const { patients, issues } = await new DoctolibMock().importCsv("patients", csv);
    expect(patients).toHaveLength(2);
    const p = patients[0];
    expect(p).toMatchObject({
      externalId: "101",
      salutation: "Frau",
      lastName: "Beispiel",
      maidenName: "Muster",
      firstName: "Erika",
      birthDate: "1950-02-01",
      email: "erika@example.org",
      phoneMobile: "0171 1234567",
      phoneLandline: "030 1234567",
      insuranceType: "gkv",
      crucialInfo: "Diabetes; Marcumar",
      notes: 'Notiz mit "Zitat"',
      noNotifications: true,
    });
    expect(patients[1].insuranceType).toBe("pkv");
    expect(patients[1].birthDate).toBeNull();
    expect(issues.map((i) => i.row)).toEqual([3, 5]);
  });

  it("exportiert und re-importiert verlustfrei", () => {
    const { patients } = parseDoctolibPatientsCsv(csv);
    const out = writeDoctolibPatientsCsv(patients);
    expect(out.split("\r\n")[0]).toBe("﻿" + DOCTOLIB_PATIENT_COLUMNS.join(","));
    const again = parseDoctolibPatientsCsv(out).patients;
    expect(again[0]).toMatchObject({ lastName: "Beispiel", birthDate: "1950-02-01", phoneMobile: "0171 1234567", crucialInfo: "Diabetes; Marcumar", insuranceType: "gkv" });
  });

  it("importiert Termin-CSV", async () => {
    const { appointments } = await new DoctolibMock().importCsv(
      "appointments",
      "id,start,duration,first_name,last_name,visit_motive,status\nA1,09.11.2026 10:30,40,Erika,Beispiel,Podologische Komplexbehandlung,confirmed\nA2,2026-11-10 08:00,,Max,Mustermann,,cancelled\n",
    );
    expect(appointments[0]).toMatchObject({ startsAt: "2026-11-09T10:30:00+01:00", patientName: "Erika Beispiel", kind: "booked", externalId: "A1" });
    expect(appointments[0].endsAt).toBe("2026-11-09T10:10:00.000Z");
    expect(appointments[1].kind).toBe("cancelled");
  });
});

describe("Doctolib-Mailparser", () => {
  it("erkennt Buchung mit ausgeschriebenem Datum", () => {
    const c = parseDoctolibEmail(
      "Guten Tag,\nIhr Termin wurde bestätigt.\nTermin am Montag, 9. November 2026 um 10:30 Uhr\nPatientin: Erika Beispiel\nBesuchsgrund: Podologische Komplexbehandlung\nE-Mail: erika@example.org",
      "Terminbestätigung",
    );
    expect(c).toMatchObject({
      kind: "booked",
      startsAt: "2026-11-09T10:30:00+01:00",
      patientName: "Erika Beispiel",
      reason: "Podologische Komplexbehandlung",
      patientEmail: "erika@example.org",
    });
    expect(c.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("erkennt Absage mit numerischem Datum", () => {
    const c = parseDoctolibEmail("Der Termin von Max Mustermann am 12.03.2026, 08:15 wurde abgesagt.\nPatient: Max Mustermann");
    expect(c.kind).toBe("cancelled");
    expect(c.startsAt).toBe("2026-03-12T08:15:00+01:00");
  });

  it("niedrige Konfidenz bei unbekanntem Text", () => {
    const c = parseDoctolibEmail("Newsletter: Neues aus der Praxiswelt");
    expect(c.confidence).toBeLessThan(0.5);
    expect(c.warnings.length).toBeGreaterThan(0);
  });
});
