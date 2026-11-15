/**
 * Härtung des Übernahme-Assistenten (AppSec B1/B2, Code-Review CR3–CR8, Recht): Grenzen gegen präparierte Dateien,
 * Excel-Vorabprüfung, Namensabgleich, gelöschte Personen, PDF-Zuordnung, Dubletten-Entscheidung, Maskierung.
 * Ausschließlich erfundene Daten.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeCsv } from "@/integrations/csv";
import { writeDoctolibPatientsCsv } from "@/integrations/doctolib/csv";
import { doctolibPatientValues } from "@/integrations/doctolib/patient-values";
import { noRemindersFlag } from "@/lib/reminders";
import { buildWorkbook } from "../excel/excel-import.test";
import { collectFiles, ONE_EXCEL_NOTE } from "./collect";
import { analyzeFile, XLSM_NOTE } from "./detect";
import { CONSENT_HINT, dataCopyHint, DSGVO_HINT, RETENTION_HINT, SOURCE_HELP } from "./help";
import { buildPlan, type ExistingSnapshot } from "./plan";
import { tinanaUpload } from "./plan.test";
import { plural } from "./plural";
import { maskPii } from "./preview-safety";
import { normName, parseTinanaPatients, parseTinanaPrescriptions } from "./tinana";
import { parseCsvBounded, TEXT_LIMITS, TextLimitError, textSignature } from "./text";
import { buildZip } from "./zip";

const FIX = path.resolve(__dirname, "../__fixtures__/tinana");
const enc = (s: string) => new TextEncoder().encode(s);
const NOW = new Date("2026-01-13T08:00:00Z");
const empty = (): ExistingSnapshot => ({ patients: [], appointmentRefs: new Set(), prescriptionRefs: new Set(), documentHashes: new Set(), therapists: [], locations: [], services: [] });
const TINANA_HEADER = "patienten_id;anrede;titel;vorname;nachname;geschlecht;geburtsdatum;strasse;hausnummer;plz;stadt;standort;email;telefon_1_label;telefon_1;telefon_2_label;telefon_2;notiz;vip;versicherungstyp;erstellt_am";

describe("AppSec B1: harte Grenzen für Textdateien", () => {
  it("1 Mio. Zeilen werden abgelehnt (Regression), ohne die Datei zu übernehmen", async () => {
    const text = `${TINANA_HEADER}\n${"X;Frau;;A;B;;;;;;;;;;;;;;Nein;GKV;\n".repeat(1_000_000)}`;
    const t0 = Date.now();
    const f = await analyzeFile("patients_export_2026-01-15.csv", enc(text));
    expect(f).toMatchObject({ status: "rejected", records: 0 });
    expect(f.note).toMatch(/größer als 10 MB|Zu viele Zeilen/);
    expect(f.tinanaPatients).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("Zeilen-, Spalten- und Feldgrenze greifen beim Parsen (Abbruch statt Aufbau riesiger Arrays)", () => {
    expect(() => parseCsvBounded("a\n".repeat(TEXT_LIMITS.maxRows + 1))).toThrow(TextLimitError);
    expect(() => parseCsvBounded(`${"x;".repeat(TEXT_LIMITS.maxCols)}x`)).toThrow(/Zu viele Spalten/);
    expect(() => parseCsvBounded(`a;"${"y".repeat(TEXT_LIMITS.maxFieldChars + 1)}"`)).toThrow(/länger als/);
    expect(parseCsvBounded('a;"b\nc"\r\n1;2')).toEqual([["a", "b\nc"], ["1", "2"]]);
  });

  it("51.000 Zeilen einer erkannten Datei → abgelehnt mit Hinweis auf kleinere Teile", async () => {
    const text = `${TINANA_HEADER}\n${"X;Frau;;A;B;;;;;;;;;;;;;;Nein;GKV;\n".repeat(51_000)}`;
    const f = await analyzeFile("p.csv", enc(text));
    expect(f).toMatchObject({ status: "rejected" });
    expect(f.note).toMatch(/Zu viele Zeilen.*kleineren Teilen/);
  });

  it("Erkennung liest nur den Anfang: Kopfzeile aus den ersten 64 KB, mehrzeilige Felder in der Kopfzeile", () => {
    const sig = textSignature(`\n\n"a\nb";c\n1;2\n${"z".repeat(200_000)}`);
    expect(sig).toMatchObject({ delimiter: ";", headers: ["a b", "c"] });
    expect(sig.firstLine).toBe('"a');
  });

  it("PDF größer als 25 MB wird nicht angenommen", async () => {
    const big = new Uint8Array(25 * 1024 * 1024 + 10);
    big.set(enc("%PDF-1.4"));
    const f = await analyzeFile("RE-1.pdf", big);
    expect(f).toMatchObject({ status: "rejected", kind: "unknown" });
    expect(f.pdf).toBeUndefined();
  });
});

describe("AppSec B2: Excel-Vorabprüfung", () => {
  it("nur eine XLSX je Lauf – die zweite wird gar nicht erst gelesen", async () => {
    const a = new Uint8Array(await buildWorkbook());
    const b = buildZip([{ path: "[Content_Types].xml", data: "<x/>" }]);
    const files = await collectFiles([
      { name: "a.xlsx", data: a },
      { name: "b.xlsx", data: b },
    ]);
    expect(files.map((f) => [f.name, f.status])).toEqual([
      ["a.xlsx", "import"],
      ["b.xlsx", "rejected"],
    ]);
    expect(files[1].note).toBe(ONE_EXCEL_NOTE);
  });

  it("XLSM wird abgelehnt – direkt und im ZIP", async () => {
    const xlsm = buildZip([{ path: "xl/vbaProject.bin", data: "makro" }]);
    const files = await collectFiles([
      { name: "m.xlsm", data: xlsm },
      { name: "paket.zip", data: buildZip([{ path: "innen/m2.xlsm", data: buildZip([{ path: "xl/vbaProject.bin", data: "anderes makro" }]) }]) },
    ]);
    expect(files.every((f) => f.status === "rejected" && f.note === XLSM_NOTE)).toBe(true);
  });

  it("XLSX mit Makro-Teil (vbaProject.bin) und XLSX-Bombe werden vor dem Parsen abgelehnt", async () => {
    const macro = await analyzeFile("tarn.xlsx", buildZip([{ path: "xl/vbaProject.bin", data: "x" }]));
    expect(macro).toMatchObject({ status: "rejected", note: XLSM_NOTE });
    // 60 MB Nullen in einem Tabellenblatt: entpackt über der Grenze (50 MB je Teil)
    const bomb = buildZip([{ path: "xl/worksheets/sheet1.xml", data: new Uint8Array(60 * 1024 * 1024) }]);
    const f = await analyzeFile("bombe.xlsx", bomb);
    expect(f.status).toBe("rejected");
    expect(f.note).toMatch(/^Excel-Datei abgelehnt: .*(zu groß|stark gepackt)/);
  });
});

describe("Namensabgleich (Code-Review CR8)", () => {
  it("Umlaute und Umschreibung, Bindestrich und Leerzeichen gelten als gleich", () => {
    expect(normName("Müller")).toBe(normName("Mueller"));
    expect(normName("Anna-Maria")).toBe(normName("Anna  Maria"));
    expect(normName("Strauß")).toBe(normName("STRAUSS"));
    expect(normName("José")).toBe("jose");
  });

  it("Geschlecht „Männlich“ wird weiterhin erkannt", () => {
    const { patients } = parseTinanaPatients(`${TINANA_HEADER}\nX;Herr;;Max;Muster;Männlich;;;;;;;;;;;;;Nein;GKV;`);
    expect(patients[0].gender).toBe("male");
  });

  it("Verordnung ist auch mit Umschreibung im Bestand eindeutig zuordenbar (Müller ↔ Mueller)", async () => {
    const files = (await tinanaUpload()).filter((f) => f.kind === "tinana.prescriptions");
    const ex = empty();
    ex.patients.push({ id: "p-1", number: 1, firstName: "Erika", lastName: "Musterfrau", birthDate: "1950-04-03", email: null, phoneMobile: null, externalIds: {} });
    ex.patients.push({ id: "p-2", number: 2, firstName: "Kim", lastName: "Beispiel", birthDate: "1990-01-01", email: null, phoneMobile: null, externalIds: {} });
    const plan = buildPlan(files, ex, { prescriptionMode: "billed", now: NOW });
    expect(plan.prescriptions.map((p) => p.patient)).toEqual([{ existingId: "p-1" }, { existingId: "p-2" }]);
  });
});

describe("Verordnungen (CR4, Recht)", () => {
  it("Schlüssel aus geparsten Datumswerten: von Excel neu gespeichert (TT.MM.JJ) → gleicher Schlüssel", () => {
    const text = readFileSync(path.join(FIX, "prescriptions_export_2026-01-15.csv"), "utf8");
    const resaved = text.replace(/(\d{2})\.(\d{2})\.20(\d{2})/g, "$1.$2.$3");
    expect(resaved).not.toBe(text);
    expect(parseTinanaPrescriptions(resaved).prescriptions.map((p) => p.key)).toEqual(parseTinanaPrescriptions(text).prescriptions.map((p) => p.key));
  });

  it("import_data enthält nur die Feld-Auswahl – keine Freitexte (Leitsymptomatik, Therapieziele)", async () => {
    const plan = buildPlan(await tinanaUpload(), empty(), { prescriptionMode: "billed", now: NOW });
    const data = plan.prescriptions[0].values.importData;
    expect(data).not.toHaveProperty("raw");
    expect(data.fields).toMatchObject({ formType: "Muster 13", leadSymptomCode: "c", providerIk: "999999999" });
    expect(JSON.stringify(data)).not.toMatch(/Einschränkung der Fußpflege|Erhalt der Fußgesundheit/);
  });
});

describe("Gelöschte Personen (Art. 17, CR3)", () => {
  it("Treffer über Tinana-ID oder Name + Geburtsdatum: nicht neu anlegen, auch keine Termine/Verordnungen", async () => {
    const ex = empty();
    ex.patients.push({ id: "g1", number: 3, firstName: "Erika", lastName: "Musterfrau", birthDate: "1950-04-03", email: null, phoneMobile: null, externalIds: { tinana: "10000000-0000-4000-8000-000000000001" }, erased: true });
    ex.patients.push({ id: "g2", number: 4, firstName: "Kim", lastName: "Beispiel", birthDate: "1990-01-01", email: null, phoneMobile: null, externalIds: {}, erased: true });
    const plan = buildPlan(await tinanaUpload(), ex, { prescriptionMode: "billed", now: NOW });
    expect(plan.totals).toMatchObject({ patientsNew: 2, patientsErased: 2, patientsLinked: 0, appointmentsNew: 1, prescriptionsNew: 0 });
    expect(plan.patientsCreate.map((c) => c.values.lastName).sort()).toEqual(["Mustermann", "Probe"]);
    expect(plan.appointments.every((a) => !("existingId" in a.patient))).toBe(true);
    expect(plan.warnings.some((w) => /gelöscht, nicht übernommen/.test(w.message))).toBe(true);
    // keine Rechnungs-PDF an eine gelöschte Person
    expect(plan.documents.map((d) => d.name)).toEqual(["RE-2026-00002.pdf"]);
  });
});

describe("Rechnungs-PDFs nur bei Person aus dem Upload (CR5, AppSec)", () => {
  it("nur im Bestand (ohne Patientendatei) → nicht zugeordnet, ausdrücklich ausgewiesen", async () => {
    const files = (await tinanaUpload()).filter((f) => f.kind !== "tinana.patients");
    const ex = empty();
    ex.patients.push({ id: "p-1", number: 7, firstName: "Erika", lastName: "Musterfrau", birthDate: "1950-04-03", email: null, phoneMobile: null, externalIds: {} });
    const plan = buildPlan(files, ex, { prescriptionMode: "billed", now: NOW });
    expect(plan.documents).toEqual([]);
    const notes = plan.files.filter((f) => f.label === "PDF-Dokument").map((f) => f.note ?? "");
    expect(notes.some((n) => /RE-2026-00001: Name nur im PodoHero-Bestand gefunden/.test(n))).toBe(true);
  });

  it("mehrdeutig (zwei gleichnamige Personen in der Patientendatei) → nicht übernommen", async () => {
    const twin = `${TINANA_HEADER}\n10000000-0000-4000-8000-000000000099;Frau;;Erika;Musterfrau;Weiblich;05.05.1955;;;;;;;;;;;;Nein;GKV;`;
    const files = [...(await tinanaUpload()), await analyzeFile("patients_standort2.csv", enc(twin))];
    const plan = buildPlan(files, empty(), { prescriptionMode: "billed", now: NOW });
    expect(plan.documents.map((d) => d.name)).toEqual(["RE-2026-00002.pdf"]);
    expect(plan.files.some((f) => /RE-2026-00001: mehrere Patient:innen/.test(f.note ?? ""))).toBe(true);
  });

  it("Rechnung ohne Patient:in (leer) → nicht übernommen", async () => {
    const plan = buildPlan(await tinanaUpload(), empty(), { prescriptionMode: "billed", now: NOW });
    expect(plan.files.some((f) => /GKV-Abrechnung/.test(f.note ?? ""))).toBe(true);
    expect(plan.documents.some((d) => d.name === "RE-2026-00003.pdf")).toBe(false);
  });
});

describe("Mögliche Dubletten: Praxis entscheidet je Fall", () => {
  const withErika = () => {
    const ex = empty();
    ex.patients.push({ id: "11111111-1111-4111-8111-111111111111", number: 7, firstName: "Erika", lastName: "Musterfrau", birthDate: "1950-04-03", email: null, phoneMobile: null, externalIds: {} });
    ex.patients.push({ id: "22222222-2222-4222-8222-222222222222", number: 8, firstName: "Andere", lastName: "Person", birthDate: null, email: "kim@example.org", phoneMobile: null, externalIds: {} });
    return ex;
  };

  it("Standard: gleicher Name + Geburtsdatum → verknüpfen; E-Mail-Treffer → neu anlegen (wählbar)", async () => {
    const plan = buildPlan(await tinanaUpload(), withErika(), { prescriptionMode: "billed", now: NOW });
    const erika = plan.decisions.find((d) => d.key === "tinana:10000000-0000-4000-8000-000000000001")!;
    expect(erika).toMatchObject({ defaultChoice: "11111111-1111-4111-8111-111111111111", choice: "11111111-1111-4111-8111-111111111111" });
    const kim = plan.decisions.find((d) => d.key === "tinana:10000000-0000-4000-8000-000000000003")!;
    expect(kim).toMatchObject({ defaultChoice: "new", candidates: [{ number: 8, reason: "gleiche E-Mail-Adresse" }] });
    expect(plan.totals).toMatchObject({ patientsNew: 3, patientsLinked: 1 });
  });

  it("Auswahl „neu anlegen“ bzw. „verknüpfen mit Nr. 8“ wird übernommen; unbekannte IDs werden ignoriert", async () => {
    const plan = buildPlan(await tinanaUpload(), withErika(), {
      prescriptionMode: "billed",
      now: NOW,
      choices: {
        "tinana:10000000-0000-4000-8000-000000000001": "new",
        "tinana:10000000-0000-4000-8000-000000000003": "22222222-2222-4222-8222-222222222222",
        "tinana:10000000-0000-4000-8000-000000000002": "33333333-3333-4333-8333-333333333333",
      },
    });
    expect(plan.totals).toMatchObject({ patientsNew: 3, patientsLinked: 1 });
    expect(plan.patientsLink).toEqual([{ patientId: "22222222-2222-4222-8222-222222222222", key: "tinana", externalId: "10000000-0000-4000-8000-000000000003" }]);
  });

  it("eine Bestandsperson wird je Quelle nur einmal verknüpft (Zähler ohne Doppelte)", async () => {
    const twin = `${TINANA_HEADER}\n10000000-0000-4000-8000-000000000099;Frau;;Erika;Musterfrau;Weiblich;03.04.1950;;;;;;;;;;;;Nein;GKV;`;
    const files = [...(await tinanaUpload()), await analyzeFile("patients_standort2.csv", enc(twin))];
    const plan = buildPlan(files, withErika(), { prescriptionMode: "billed", now: NOW, choices: { "tinana:10000000-0000-4000-8000-000000000099": "11111111-1111-4111-8111-111111111111" } });
    expect(plan.patientsLink.filter((l) => l.patientId === "11111111-1111-4111-8111-111111111111")).toHaveLength(1);
    expect(plan.totals.patientsLinked).toBe(1);
  });

  it("verknüpfte Bestandsperson mit künftigem Termin: Hinweis auf mögliche Erinnerungen (CR7)", async () => {
    const ex = empty();
    ex.patients.push({ id: "p-2", number: 2, firstName: "Max", lastName: "Mustermann", birthDate: "1962-11-17", email: null, phoneMobile: null, externalIds: {} });
    const plan = buildPlan(await tinanaUpload(), ex, { prescriptionMode: "billed", now: NOW });
    expect(plan.warnings.some((w) => /1 künftiger Termin gehört zu Patient:innen, die schon in PodoHero geführt werden.*Erinnerungen/.test(w.message))).toBe(true);
  });
});

describe("Doctolib ohne ID (CR4)", () => {
  const csv = writeDoctolibPatientsCsv([
    { externalId: null, lastName: "Ohne", firstName: "Id", birthDate: null, email: "ohne.id@example.org" },
    { externalId: null, lastName: "Gar", firstName: "Nichts" },
  ]);
  it("zweiter Lauf erkennt die Person über Name + E-Mail wieder; ganz ohne Merkmal → Hinweis „nicht wiedererkennbar“", async () => {
    const files = [await analyzeFile("doctolib.csv", enc(csv))];
    const first = buildPlan(files, empty(), { prescriptionMode: "billed", now: NOW });
    expect(first.totals.patientsNew).toBe(2);
    expect(first.warnings.some((w) => /nicht wiedererkennbar/.test(w.message))).toBe(true);
    const ex = empty();
    first.patientsCreate.forEach((c, i) => ex.patients.push({ id: `d${i}`, number: i + 1, firstName: c.values.firstName, lastName: c.values.lastName, birthDate: c.values.birthDate, email: c.values.email, phoneMobile: c.values.phoneMobile, externalIds: c.values.externalIds }));
    const second = buildPlan(files, ex, { prescriptionMode: "billed", now: NOW });
    expect(second.totals).toMatchObject({ patientsExisting: 1, patientsNew: 1 });
  });

  it("Doctolib-Werte: kein Geburtsname/Beruf, „keine Benachrichtigungen“ als no_reminders", () => {
    const v = doctolibPatientValues({ lastName: "Muster", maidenName: "Alt", occupation: "Beruf", noNotifications: true });
    expect(v.extra).toEqual({ no_reminders: true });
    expect(noRemindersFlag(v.extra)).toBe(true);
    // Altdaten mit dem früheren Schlüssel gelten weiter
    expect(noRemindersFlag({ noReminders: true })).toBe(true);
    expect(noRemindersFlag({ no_reminders: "true" })).toBe(true);
    expect(noRemindersFlag({})).toBe(false);
  });
});

describe("Excel ohne Legacy-ID (CR4)", () => {
  it("Vorschau zählt Zeilen ohne ID mit gleichem Namen + Geburtsdatum als schon übernommen", async () => {
    const files = await collectFiles([{ name: "Rechnungsmanager.xlsx", data: new Uint8Array(await buildWorkbook()) }]);
    const excel = files[0].excel!;
    const max = excel.patients.find((p) => p.lastName === "Mustermann")!;
    excel.patients = [{ ...max, legacyId: null, row: 99, firstName: "Max", lastName: "Mustermann" }];
    const ex = empty();
    ex.patients.push({ id: "x", number: 99, firstName: "max", lastName: "MUSTERMANN", birthDate: max.birthDate, email: null, phoneMobile: null, externalIds: {} });
    expect(buildPlan(files, ex, { prescriptionMode: "billed", now: NOW }).totals.excel).toMatchObject({ patientsNew: 0, patientsExisting: 1 });
    expect(buildPlan(files, empty(), { prescriptionMode: "billed", now: NOW }).totals.excel).toMatchObject({ patientsNew: 1, patientsExisting: 0 });
  });
});

describe("Vorschau: Klardaten maskiert", () => {
  it("E-Mail, Telefon und Rohwerte zu Geburtsdatum/E-Mail/Telefon werden maskiert, Pseudonym und Rechnungsnummern bleiben", () => {
    expect(maskPii("Ungültiges Geburtsdatum „31.02.1950“.")).toBe("Ungültiges Geburtsdatum „***“.");
    expect(maskPii("Patienten: E-Mail-Adresse wirkt ungültig („erika@@example.org“).")).not.toMatch(/erika|example/);
    expect(maskPii("Telefonnummer als Zahl gespeichert – führende 0 ergänzt (01601234567).")).toBe("Telefonnummer als Zahl gespeichert – führende 0 ergänzt (***).");
    expect(maskPii("Kontakt max@example.org, Tel. +49 151 0000001")).toBe("Kontakt ***@***, Tel. ***");
    expect(maskPii("E. M. (Jg. 1950): mögliche Dublette zu Nr. 12")).toBe("E. M. (Jg. 1950): mögliche Dublette zu Nr. 12");
    expect(maskPii("Rechnung RE-2026-00001: Patient:in nicht eindeutig")).toBe("Rechnung RE-2026-00001: Patient:in nicht eindeutig");
  });

  it("Parser-Meldungen enthalten keine Rohwerte", () => {
    const { issues } = parseTinanaPatients(`${TINANA_HEADER}\nX;Frau;;A;B;;31.02.1950;;;;;;kaputt@;;;;;;Nein;GKV;`);
    expect(issues.map((i) => i.message).join(" ")).not.toMatch(/31\.02|kaputt/);
  });
});

describe("Feldlängen, Einzahl, Texte", () => {
  it("überlange Felder werden gekürzt", async () => {
    const long = `${TINANA_HEADER}\nX;Frau;;${"V".repeat(500)};${"N".repeat(500)};;;;;;;;;;;;;${"n".repeat(20_000)};Nein;GKV;`;
    const plan = buildPlan([await analyzeFile("p.csv", enc(long))], empty(), { prescriptionMode: "billed", now: NOW });
    const v = plan.patientsCreate[0].values;
    expect([v.firstName?.length, v.lastName.length, v.notes?.length]).toEqual([100, 100, 5000]);
  });

  it("Einzahl: „1 Rechnung“, „1 vergangener Termin“", async () => {
    expect(plural(1, "Verordnung", "Verordnungen")).toBe("1 Verordnung");
    expect(plural(2, "Verordnung", "Verordnungen")).toBe("2 Verordnungen");
    const files = (await tinanaUpload()).map((f) => (f.kind === "tinana.invoices" ? { ...f, tinanaInvoices: f.tinanaInvoices!.slice(0, 1) } : f));
    const plan = buildPlan(files, empty(), { prescriptionMode: "billed", now: new Date("2026-01-13T12:00:00Z") });
    expect(plan.warnings.some((w) => w.message.startsWith("1 Rechnung aus Tinana"))).toBe(true);
  });

  it("Rechtstexte: kein Art. 20, Datenkopie nach Art. 28, Hinweis nur für Online-Software, Sie-Form", () => {
    const all = [...SOURCE_HELP.flatMap((h) => [...h.steps, ...h.missing, ...h.tips]), DSGVO_HINT, RETENTION_HINT, CONSENT_HINT].join("\n");
    expect(all).not.toMatch(/Art\. 20/);
    expect(all).not.toMatch(/\b(du|dir|dein|deine|deiner|deinen)\b/i);
    expect(dataCopyHint("beim Tinana-Support")).toMatch(/Art\. 28 Abs\. 3 lit\. a und g DSGVO/);
    expect(SOURCE_HELP.find((h) => h.id === "excel")).toMatchObject({ online: false, tips: [expect.not.stringMatching(/Art\. 28/)] });
    expect(SOURCE_HELP.find((h) => h.id === "pododesk")!.missing.join(" ")).toMatch(/in der Regel über die sevdesk-Anbindung/);
    // Recht Runde 2 B1: Excel-Rechnungen und Kassenbuch-Frist ausdrücklich genannt
    expect(RETENTION_HINT).toMatch(/Excel/);
    expect(RETENTION_HINT).toContain("10 Jahre für Kassenbuch");
  });
});

describe("CSV-Export: Formel-Entschärfung standardmäßig", () => {
  it("writeCsv entschärft = + - @; Doctolib-Importformat behält „+49 …“", () => {
    expect(writeCsv([["=HYPERLINK(1)", "@x", 5]], { bom: false })).toBe("'=HYPERLINK(1);'@x;5\r\n");
    expect(writeCsv([["=1"]], { bom: false, neutralize: false })).toBe("=1\r\n");
    expect(writeDoctolibPatientsCsv([{ lastName: "Muster", phoneMobile: "+49 151 0000001" }])).toContain(",+49 151 0000001,");
  });
});
