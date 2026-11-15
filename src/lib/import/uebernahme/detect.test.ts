/** Erkenner je Quelle mit den (erfundenen) Fixtures aus src/lib/import/__fixtures__ – exakte Kopfzeilen der Originale. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeDoctolibPatientsCsv } from "@/integrations/doctolib/csv";
import { buildWorkbook } from "../excel/excel-import.test";
import { analyzeFile, recognize, UNKNOWN_NOTE } from "./detect";
import { collectFiles } from "./collect";
import { buildZip } from "./zip";

const FIX = path.resolve(__dirname, "../__fixtures__");
const fx = (sub: string, name: string) => new Uint8Array(readFileSync(path.join(FIX, sub, name)));
const tinana = (name: string) => fx("tinana", name);

describe("Erkennung: Tinana-Datenexport", () => {
  it.each([
    ["patients_export_2026-01-15.csv", "tinana.patients", "import", 4],
    ["appointments_export_2026-01-15.csv", "tinana.appointments", "import", 3],
    ["prescriptions_export_2026-01-15.csv", "tinana.prescriptions", "import", 2],
    ["doctors_export_2026-01-15.csv", "tinana.doctors", "info", 3],
    ["invoices_export_2026-01-15.csv", "tinana.invoices", "info", 3],
    ["rechnungen-2026-01-15.csv", "tinana.invoice_list", "info", 3],
  ])("%s → %s", async (name, kind, status, records) => {
    const f = await analyzeFile(name, tinana(name));
    expect(f).toMatchObject({ kind, source: "tinana", status, records });
    expect(f.label).toMatch(/^Tinana – /);
  });

  it.each(["Umsatz_nach_Termin_Januar_2026.csv", "Mitarbeiterbericht_Heute_2026-01-15.csv", "Heilmittelbericht_Dieses_Jahr.csv", "Verordnungsbericht_Dieses_Jahr_monatlich_anzahl.csv"])(
    "Bericht %s wird erkannt und mit Hinweis abgelehnt",
    async (name) => {
      const f = await analyzeFile(name, tinana(name));
      expect(f).toMatchObject({ kind: "tinana.report", status: "rejected" });
      expect(f.note).toMatch(/Bericht.*Datenexport/);
    },
  );

  it("erkennt über die Kopfzeile – auch umbenannt, ohne BOM und von Excel mit Komma gespeichert", async () => {
    const text = new TextDecoder().decode(tinana("patients_export_2026-01-15.csv")).replace(/^﻿/, "").replace(/;/g, ",");
    const f = await analyzeFile("Download (1).csv", new TextEncoder().encode(text));
    expect(f.kind).toBe("tinana.patients");
    expect(f.tinanaPatients?.[0]).toMatchObject({ lastName: "Musterfrau", birthDate: "1950-04-03" });
  });

  it("Windows-1252 statt UTF-8 wird gelesen", async () => {
    const text = "patienten_id;anrede;titel;vorname;nachname;geschlecht;geburtsdatum;strasse;hausnummer;plz;stadt;standort;email;telefon_1_label;telefon_1;telefon_2_label;telefon_2;notiz;vip;versicherungstyp;erstellt_am\nX1;Frau;;Jürgen;Mößner;Männlich;01.02.1960;;;;;;;;;;;;Nein;GKV;";
    const bytes = Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
    const f = await analyzeFile("p.csv", bytes);
    expect(f.tinanaPatients?.[0]).toMatchObject({ firstName: "Jürgen", lastName: "Mößner" });
  });
});

describe("Erkennung: andere Quellen", () => {
  it("Pododesk-Kassenbuch: nur Hinweis mit letztem Kassenbestand", async () => {
    const name = "Kassenbuch Musterpraxis 01.01.26 - 31.12.26 (mit Zeilen).csv";
    const f = await analyzeFile(name, fx("pododesk", name));
    expect(f).toMatchObject({ kind: "pododesk.cashbook", source: "pododesk", status: "info", records: 5 });
    expect(f.note).toMatch(/nicht nachbuchen, nur Anfangsbestand/);
    expect(f.cashbook).toEqual({ rows: 5, firstDate: "2026-01-02", lastDate: "2026-01-05", lastBalanceCents: 17100 });
  });

  it("Pododesk-Kassenbuch ohne Buchungen (byte-genauer Leer-Export)", async () => {
    const name = "Kassenbuch Musterpraxis 01.01.26 - 31.12.26.csv";
    const f = await analyzeFile(name, fx("pododesk", name));
    expect(f).toMatchObject({ kind: "pododesk.cashbook", records: 0 });
    expect(f.cashbook?.lastBalanceCents).toBeNull();
  });

  it("Doctolib-Patientenliste nutzt den vorhandenen Parser", async () => {
    const csv = writeDoctolibPatientsCsv([{ externalId: "D-1", lastName: "Muster", firstName: "Anna", birthDate: "1970-05-06", gender: "female" }]);
    const f = await analyzeFile("export.csv", new TextEncoder().encode(csv));
    expect(f).toMatchObject({ kind: "doctolib.patients", status: "import", records: 1 });
    expect(f.doctolibPatients?.[0]).toMatchObject({ externalId: "D-1", lastName: "Muster" });
  });

  it("PodoHero-Excel (Rechnungsmanager) nutzt den vorhandenen Parser", async () => {
    const f = await analyzeFile("Rechnungsmanager.xlsx", new Uint8Array(await buildWorkbook()));
    expect(f).toMatchObject({ kind: "podohero.excel", source: "podohero-excel", status: "import" });
    expect(f.excel?.patients.length).toBeGreaterThan(0);
  });

  it("unbekannte Dateien: klare Meldung mit den unterstützten Formaten", async () => {
    const f = await analyzeFile("liste.csv", new TextEncoder().encode("Name;Telefon\nA;1"));
    expect(f).toMatchObject({ kind: "unknown", status: "rejected", note: UNKNOWN_NOTE });
    expect(f.note).toMatch(/Tinana.*Doctolib.*Excel.*Pododesk/);
    const bin = await analyzeFile("bild.csv", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    expect(bin.status).toBe("rejected");
  });

  it("jede Fixture-Datei wird erkannt (keine „unbekannt“)", () => {
    for (const sub of ["tinana", "pododesk"]) {
      for (const name of readdirSync(path.join(FIX, sub))) {
        expect(recognize(new TextDecoder().decode(fx(sub, name))), `${sub}/${name}`).not.toBeNull();
      }
    }
  });

  it("collectFiles: ZIP mit allen Tinana-Exporten + PDFs, doppelte Dateien werden markiert", async () => {
    const names = ["patients_export_2026-01-15.csv", "appointments_export_2026-01-15.csv"];
    const zip = buildZip([...names.map((n) => ({ path: n, data: tinana(n) })), { path: "rechnungen_pdf/RE-2026-00002.pdf", data: "%PDF-1.4 test" }]);
    const files = await collectFiles([{ name: "tinana.zip", data: zip }, { name: names[0], data: tinana(names[0]) }]);
    expect(files.map((f) => [f.name, f.kind, f.status])).toEqual([
      ["tinana.zip/patients_export_2026-01-15.csv", "tinana.patients", "import"],
      ["tinana.zip/appointments_export_2026-01-15.csv", "tinana.appointments", "import"],
      ["tinana.zip/rechnungen_pdf/RE-2026-00002.pdf", "pdf", "info"],
      ["patients_export_2026-01-15.csv", "tinana.patients", "duplicate"],
    ]);
  });
});
