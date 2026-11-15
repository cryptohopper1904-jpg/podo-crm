/**
 * Übernahme-Assistent, Review Runde 2 (Recht, Code-Review, Buchhaltung, AppSec): Unit-Tests ohne Datenbank.
 * Ausschließlich erfundene Daten.
 */
import { describe, expect, it } from "vitest";
import { writeDoctolibPatientsCsv } from "@/integrations/doctolib/csv";
import { parseWorkbook } from "../excel/parse";
import { buildWorkbook } from "../excel/excel-import.test";
import { collectFiles, RUN_LIMITS } from "./collect";
import { analyzeFile, XLSX_LIMITS } from "./detect";
import { CONSENT_HINT, dataCopyHint, DSGVO_HINT, EXCEL_PAYMENTS_HINT, RETENTION_HINT, REUPLOAD_HINT, SOURCE_HELP } from "./help";
import { buildPlan, type ExistingPatient, type ExistingSnapshot } from "./plan";
import { tinanaUpload } from "./plan.test";
import { toPreview } from "./preview-safety";
import { exclusive, ImportBusyError, ServerBusyError } from "./run";
import { normName, parseTinanaAppointments, parseTinanaPatients, SOURCE_ID_RE } from "./tinana";
import type { DetectedFile } from "./types";
import { buildZip } from "./zip";

const enc = (s: string) => new TextEncoder().encode(s);
const NOW = new Date("2026-01-13T08:00:00Z");
const empty = (): ExistingSnapshot => ({ patients: [], appointmentRefs: new Set(), prescriptionRefs: new Set(), documentHashes: new Set(), therapists: [], locations: [], services: [] });
const TINANA_HEADER =
  "patienten_id;anrede;titel;vorname;nachname;geschlecht;geburtsdatum;strasse;hausnummer;plz;stadt;standort;email;telefon_1_label;telefon_1;telefon_2_label;telefon_2;notiz;vip;versicherungstyp;erstellt_am";
const APPT_HEADER = "termin_id;patienten_id;agenda_id;agenda_label;titel;startzeit;endzeit;status;heilmittel";
const person = (over: Partial<ExistingPatient> = {}): ExistingPatient => ({
  id: "00000000-0000-4000-8000-000000000001",
  number: 7,
  firstName: "Erika",
  lastName: "Musterfrau",
  birthDate: "1950-04-03",
  email: null,
  phoneMobile: null,
  externalIds: {},
  ...over,
});
const tinanaRow = (id: string, first = "Erika", last = "Musterfrau", birth = "03.04.1950") => `${id};Frau;;${first};${last};Weiblich;${birth};;;;;;;;;;;;Nein;GKV;`;
const tinanaFile = async (...rows: string[]) => analyzeFile("patients_export_2026-01-15.csv", enc([TINANA_HEADER, ...rows].join("\n")));

describe("A-B1: Gesamtgrenzen je Lauf und ein Lauf gleichzeitig", () => {
  it("Datensätze, Dateien und Byte-Summe der Textdateien sind je Lauf begrenzt", async () => {
    expect(RUN_LIMITS).toEqual({ maxRecords: 100_000, maxFiles: 5_000, maxTextBytes: 40 * 1024 * 1024 });
    const file = (id: string, n: number) => ({ name: `${id}.csv`, data: enc([TINANA_HEADER, ...Array.from({ length: n }, (_, i) => tinanaRow(`${id}-${i}`))].join("\n")) });
    // Datensätze: die zweite Datei überschreitet die Grenze → nicht übernommen, ohne Inhalte
    const recs = await collectFiles([file("a", 3), file("b", 3)], {}, { maxRecords: 5, maxFiles: 100, maxTextBytes: 1e9 });
    expect(recs.map((d) => d.status)).toEqual(["import", "rejected"]);
    expect(recs[1].note).toMatch(/Zu viele Datensätze in einem Lauf \(mehr als 5\)/);
    expect(recs[1].tinanaPatients).toBeUndefined();
    // Dateien: ein ZIP mit mehr Einträgen als erlaubt wird schon beim Entpacken abgelehnt (Runde 3 SB1) …
    const zip = buildZip(Array.from({ length: 6 }, (_, i) => ({ path: `p${i}.csv`, data: enc(`${TINANA_HEADER}\n${tinanaRow(`z${i}`)}`) })));
    const many = await collectFiles([{ name: "export.zip", data: zip }], {}, { maxRecords: 100, maxFiles: 4, maxTextBytes: 1e9 });
    expect(many).toHaveLength(1);
    expect(many[0]).toMatchObject({ status: "rejected", label: "ZIP-Archiv" });
    expect(many[0].note).toMatch(/Zu viele Dateien in einem Lauf \(mehr als 4\) – das ZIP wurde nicht gelesen/);
    // … ZIP-Einträge plus einzelne Dateien darüber: Rest wird nicht gelesen
    const small = buildZip(Array.from({ length: 3 }, (_, i) => ({ path: `p${i}.csv`, data: enc(`${TINANA_HEADER}\n${tinanaRow(`y${i}`)}`) })));
    const mixed = await collectFiles([{ name: "export.zip", data: small }, file("e", 1), file("f", 1)], {}, { maxRecords: 100, maxFiles: 4, maxTextBytes: 1e9 });
    expect(mixed.filter((d) => d.status === "import")).toHaveLength(4);
    expect(mixed.find((d) => d.name === "weitere 1 Dateien")?.note).toMatch(/Zu viele Dateien in einem Lauf \(mehr als 4\)/);
    // Byte-Summe aller Textdateien
    const bytes = await collectFiles([file("c", 2), file("d", 2)], {}, { maxRecords: 100, maxFiles: 100, maxTextBytes: file("c", 2).data.length + 10 });
    expect(bytes.map((d) => d.status)).toEqual(["import", "rejected"]);
    expect(bytes[1].note).toMatch(/Textdateien dieses Laufs sind zusammen größer als/);
  });

  it("prozessweite Semaphore: ein zweiter Lauf bricht sofort ab, danach ist wieder frei", async () => {
    let release!: () => void;
    const first = exclusive(() => new Promise<string>((r) => (release = () => r("fertig"))));
    await expect(exclusive(async () => "zweiter")).rejects.toBeInstanceOf(ServerBusyError);
    // gleiche Behandlung in der Action wie die Praxis-Sperre
    await expect(exclusive(async () => "zweiter")).rejects.toBeInstanceOf(ImportBusyError);
    release();
    await expect(first).resolves.toBe("fertig");
    await expect(exclusive(async () => "danach")).resolves.toBe("danach");
    // auch nach einem Fehler wird die Sperre freigegeben
    await expect(exclusive(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(exclusive(async () => "wieder")).resolves.toBe("wieder");
  });
});

describe("AppSec Runde 2 (A-H2 … A-H8)", () => {
  it("A-H4: Vorschau kürzt Dateien, Hinweise und Entscheidungen auf 200 und nennt die Gesamtzahl", async () => {
    const plan = buildPlan(await tinanaUpload(), empty(), { prescriptionMode: "billed", now: NOW });
    const files = Array.from({ length: 450 }, (_, i) => ({ ...plan.files[0], name: `datei-${i}.pdf` }));
    const decisions = Array.from({ length: 230 }, (_, i) => ({ key: `tinana:${i}`, who: "E. M.", sourceLabel: "Tinana", candidates: [], defaultChoice: "new", choice: "new" }));
    const p = toPreview({ ...plan, files, decisions });
    expect([p.files.length, p.filesTotal, p.decisions.length, p.decisionsTotal]).toEqual([200, 450, 200, 230]);
  });

  it("A-H5: Doctolib-Export entschärft Formeln, nur echte „+49 …“-Nummern in Telefonspalten bleiben roh", () => {
    const csv = writeDoctolibPatientsCsv([{ lastName: "=HYPERLINK(1)", firstName: "+SUMME(1)", phoneMobile: "+49 151 0000001", phoneLandline: "+49 (30) 000-0001", crucialInfo: "+49 nur Text" }], { delimiter: ",", bom: false });
    expect(csv).toContain("'=HYPERLINK(1)");
    expect(csv).toContain("'+SUMME(1)");
    expect(csv).toContain(",+49 151 0000001,");
    expect(csv).toContain(",+49 (30) 000-0001,");
    expect(csv).toContain("'+49 nur Text");
    const evil = writeDoctolibPatientsCsv([{ lastName: "Muster", phoneMobile: "+1+cmd|' /C calc'!A0" }], { delimiter: ",", bom: false });
    expect(evil).toContain("'+1+cmd");
  });

  it("A-H6: Quell-IDs höchstens 100 Zeichen und nur unbedenkliche Zeichen – sonst Zeile übersprungen", () => {
    expect(SOURCE_ID_RE.test("10000000-0000-4000-8000-000000000001")).toBe(true);
    expect(SOURCE_ID_RE.test("x".repeat(100))).toBe(true);
    expect(SOURCE_ID_RE.test("x".repeat(101))).toBe(false);
    const { patients, issues } = parseTinanaPatients([TINANA_HEADER, tinanaRow("x".repeat(101)), tinanaRow("a b"), tinanaRow("<script>"), tinanaRow("ok-1")].join("\n"));
    expect(patients.map((p) => p.id)).toEqual(["ok-1"]);
    expect(issues.filter((i) => /Patienten-ID ungültig/.test(i.message))).toHaveLength(3);
    const appts = parseTinanaAppointments([APPT_HEADER, `t1;${"p".repeat(120)};a;A;T;10.01.2026 09:00;10.01.2026 09:30;Geplant;`, "t 2;p1;a;A;T;10.01.2026 09:00;10.01.2026 09:30;Geplant;", "t3;p1;a;A;T;10.01.2026 09:00;10.01.2026 09:30;Geplant;"].join("\n"));
    expect(appts.appointments.map((a) => a.id)).toEqual(["t3"]);
    expect(appts.issues.filter((i) => /ungültig/.test(i.message))).toHaveLength(2);
  });

  it("A-H6: Doctolib-Zeile mit ungültiger ID wird mit Hinweis übersprungen", async () => {
    const csv = writeDoctolibPatientsCsv([{ externalId: "1".repeat(101), lastName: "Muster", firstName: "Max" }, { externalId: "4711", lastName: "Probe", firstName: "Lena" }], { delimiter: ",", bom: false });
    const plan = buildPlan([await analyzeFile("doctolib.csv", enc(csv))], empty(), { prescriptionMode: "billed", now: NOW });
    expect(plan.patientsCreate.map((c) => c.values.lastName)).toEqual(["Probe"]);
    expect(plan.warnings.some((w) => /Doctolib-ID ungültig.*übersprungen/.test(w.message))).toBe(true);
  });

  it("A-H7: Trennzeichen aus der Erkennung – Doctolib-Datei mit Leerzeile vor der Kopfzeile wird gelesen", async () => {
    const csv = writeDoctolibPatientsCsv([{ externalId: "4711", lastName: "Probe", firstName: "Lena" }], { delimiter: ",", bom: false });
    const f = await analyzeFile("doctolib.csv", enc(`\n\n${csv}`));
    expect(f).toMatchObject({ kind: "doctolib.patients", status: "import", records: 1 });
    expect(f.doctolibPatients?.[0]).toMatchObject({ lastName: "Probe", externalId: "4711" });
    // Tinana mit Leerzeile: gleiche Zerlegung wie bei der Erkennung
    const t = await analyzeFile("p.csv", enc(`\n${TINANA_HEADER}\n${tinanaRow("a1")}`));
    expect(t).toMatchObject({ kind: "tinana.patients", records: 1 });
  });

  it("A-H8: XLSX entpackt höchstens 25 MB", () => {
    expect(XLSX_LIMITS).toMatchObject({ maxEntryBytes: 25 * 1024 * 1024, maxTotalBytes: 25 * 1024 * 1024 });
  });

  it("A-H2: Excel-Zeile MIT Legacy-ID einer gelöschten Person (Name + Geburtsdatum) wird nicht neu angelegt", async () => {
    const res = await parseWorkbook(await buildWorkbook(), { today: "2026-11-07" });
    const p0 = { ...res.patients[0], legacyId: 9001, firstName: "Erika", lastName: "Musterfrau", birthDate: "1950-04-03" };
    const excel: DetectedFile = { name: "r.xlsx", sha256: "x", size: 1, kind: "podohero.excel", source: "podohero-excel", label: "Excel", target: "–", status: "import", records: 1, issues: [], excel: { ...res, patients: [p0] } };
    const ex = empty();
    ex.patients.push(person({ erased: true }));
    const plan = buildPlan([excel], ex, { prescriptionMode: "billed", now: NOW });
    expect(plan.totals.excel).toMatchObject({ patientsNew: 0, patientsExisting: 1 });
    expect(plan.warnings.some((w) => /Excel: 1 Person mit gelöschten Kontaktdaten.*gelöscht, nicht übernommen/.test(w.message))).toBe(true);
  });
});

describe("Code-Review Runde 2 (S2–S4, Nice)", () => {
  it("S2: normName vergleicht NFD-Schreibweisen (u + Trema) wie „ü“", () => {
    expect(normName("Müller")).toBe("mueller");
    expect(normName("Müller")).toBe(normName("Müller"));
    expect(normName("Müller")).toBe(normName("Mueller"));
  });

  it("S3: gleiche Person schon mit anderer Tinana-ID verknüpft → neu angelegt mit Hinweis", async () => {
    const ex = empty();
    ex.patients.push(person({ externalIds: { tinana: "alt-1" } }));
    const plan = buildPlan([await tinanaFile(tinanaRow("neu-2"))], ex, { prescriptionMode: "billed", now: NOW });
    expect(plan.totals).toMatchObject({ patientsNew: 1, patientsLinked: 0 });
    expect(plan.warnings.map((w) => w.message)).toContain("E. M. (Jg. 1950): gleiche Person ist bereits mit anderer Tinana-ID verknüpft – neu angelegt, bitte prüfen.");
  });

  it("S4: dieselbe Bestandsperson für zwei Zeilen gewählt → Konflikt (Import wird abgelehnt), keine stille Umstellung", async () => {
    const ex = empty();
    ex.patients.push(person());
    const file = await tinanaFile(tinanaRow("t-1"), tinanaRow("t-2"));
    const ok = buildPlan([file], ex, { prescriptionMode: "billed", now: NOW, choices: { "tinana:t-1": person().id } });
    expect(ok.conflicts).toEqual([]);
    const bad = buildPlan([file], ex, { prescriptionMode: "billed", now: NOW, choices: { "tinana:t-1": person().id, "tinana:t-2": person().id } });
    expect(bad.conflicts).toEqual([{ key: "tinana:t-2", number: 7 }]);
    expect(bad.warnings.map((w) => w.message)).toContain("Nr. 7 kann nur einmal verknüpft werden, bitte erneut prüfen.");
  });

  it("gelöschte Person mit aktivem Namensvetter: Hinweis „bitte manuell zuordnen“; ihr Rechnungs-PDF „gelöscht, nicht übernommen“", async () => {
    const ex = empty();
    ex.patients.push(person({ id: "e-1", number: 3, erased: true, externalIds: { tinana: "10000000-0000-4000-8000-000000000001" } }), person({ id: "e-2", number: 4 }));
    const plan = buildPlan(await tinanaUpload(), ex, { prescriptionMode: "billed", now: NOW });
    expect(plan.warnings.some((w) => /gelöscht, nicht übernommen.*Gleichnamige aktive Nr\. 4 vorhanden – bitte manuell zuordnen\./.test(w.message))).toBe(true);
    const erikaPdf = plan.files.find((f) => f.name.endsWith("RE-2026-00001.pdf"))!;
    expect(erikaPdf.note).toMatch(/Kontaktdaten der Patient:in wurden in PodoHero auf Wunsch gelöscht \(Art\. 17 DSGVO\) – gelöscht, nicht übernommen\./);
  });

  it("Excel-Zahlen berücksichtigen im selben Lauf angelegte Tinana-Personen (Excel-Zeile ohne Legacy-ID)", async () => {
    const res = await parseWorkbook(await buildWorkbook(), { today: "2026-11-07" });
    const row = { ...res.patients[0], legacyId: null, firstName: "Erika", lastName: "Musterfrau", birthDate: "1950-04-03" };
    const excel: DetectedFile = { name: "r.xlsx", sha256: "x", size: 1, kind: "podohero.excel", source: "podohero-excel", label: "Excel", target: "–", status: "import", records: 1, issues: [], excel: { ...res, patients: [row] } };
    const plan = buildPlan([await tinanaFile(tinanaRow("t-9")), excel], empty(), { prescriptionMode: "billed", now: NOW });
    expect(plan.totals.patientsNew).toBe(1);
    expect(plan.totals.excel).toMatchObject({ patientsNew: 0, patientsExisting: 1 });
  });

  it("Hilfe: vollständig gelöschte Personen würden bei erneutem Upload wieder angelegt", () => {
    expect(REUPLOAD_HINT).toMatch(/vollständig gelöscht.*wieder angelegt/);
  });
});

describe("Recht und Buchhaltung Runde 2 (Texte)", () => {
  it("B1: Aufbewahrung nennt Excel-Rechnungen, Lexoffice und 10 Jahre für Kassenbuch", () => {
    expect(RETENTION_HINT).toMatch(/Excel-Rechnungsmanager/);
    expect(RETENTION_HINT).toMatch(/Excel/);
    expect(RETENTION_HINT).toContain("10 Jahre für Kassenbuch");
    expect(RETENTION_HINT).toContain("Übertragen Sie diese Rechnungen nicht noch einmal in Ihre Buchhaltung (z. B. Lexoffice), wenn sie dort schon erfasst sind.");
    expect(RETENTION_HINT.startsWith("Rechnungen aus Online-Software (z. B. Tinana) legt PodoHero nur als PDF-Kopie bei der Patient:in ab")).toBe(true);
  });

  it("E1/E2/E3: Einwilligungen, Datenkopie, Pododesk-Support", () => {
    expect(CONSENT_HINT).toContain(
      "Holen Sie sie in PodoHero neu ein; bis dahin verschickt PodoHero an neu übernommene Patient:innen keine Erinnerungen. Bei Personen, die schon in PodoHero geführt werden, gelten deren bisherige Einwilligungen in PodoHero weiter.",
    );
    expect(DSGVO_HINT).toContain(
      "Sie können jederzeit eine vollständige Kopie anweisen; bei Vertragsende muss sie die Daten nach Ihrer Wahl zurückgeben oder löschen (Art. 28 Abs. 3 lit. a und g DSGVO) – wählen Sie die Rückgabe.",
    );
    const pododesk = SOURCE_HELP.find((h) => h.id === "pododesk")!;
    expect(pododesk.tips).toEqual([dataCopyHint("beim Pododesk-Support")]);
    expect(JSON.stringify(SOURCE_HELP)).not.toMatch(/Hellmut Ruck/);
  });

  it("B1/K3: Excel-Hinweis in der Vorschau – nicht erneut an die Buchhaltung, Zahlungen nicht in der Kasse", async () => {
    const res = await parseWorkbook(await buildWorkbook(), { today: "2026-11-07" });
    expect(res.invoices.length).toBeGreaterThan(0);
    const excel: DetectedFile = { name: "r.xlsx", sha256: "x", size: 1, kind: "podohero.excel", source: "podohero-excel", label: "Excel", target: "–", status: "import", records: 1, issues: [], excel: res };
    const plan = buildPlan([excel], empty(), { prescriptionMode: "billed", now: NOW });
    const msg = plan.warnings.find((w) => w.message.startsWith("Excel-Rechnungsmanager"))!.message;
    expect(msg).toContain(" Übertragen Sie sie nicht erneut an Ihre Buchhaltung, wenn sie dort schon erfasst sind.");
    expect(msg).toContain(EXCEL_PAYMENTS_HINT);
    expect(EXCEL_PAYMENTS_HINT).toBe(
      "Übernommene Zahlungen werden nur an der Rechnung vermerkt. Sie erscheinen nicht in der Kasse, im Tagesabschluss oder im DSFinV-K-Export – sie sind im Kassenbuch Ihres bisherigen Systems erfasst.",
    );
  });
});
