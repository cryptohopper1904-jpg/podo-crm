/**
 * Pododesk-Gesamtexport, Review-Runde 2 (PR #108): Code-Review B1, S2–S4, Nice; AppSec A-B1, A-B2, A-H1–H3.
 * Unit-Tests ohne Datenbank, ausschließlich erfundene Daten.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { asString } from "../excel/cells";
import { collectFiles } from "./collect";
import { analyzeFile } from "./detect";
import { buildPlan, type ExistingSnapshot } from "./plan";
import { MAX_SERVICES_PER_APPOINTMENT, parseServiceRefs, PODODESK_COLUMNS, PODODESK_HEADERS, pododeskFileOf } from "./pododesk";
import { errorForLog, maskPii, toPreview } from "./preview-safety";
import { readTable, tableFromRows } from "./text";
import { parseTinanaPrescriptions } from "./tinana";
import { buildZip } from "./zip";

const FIX = path.resolve(__dirname, "../__fixtures__/pododesk/gesamtexport");
const FILES = ["aerzte.csv", "leistungenPrivat.csv", "patienten.csv", "praxisstammdaten.csv", "termine.csv", "users.csv"];
const fx = (n: string) => new Uint8Array(readFileSync(path.join(FIX, n)));
const enc = (s: string) => new TextEncoder().encode(s);
const NOW = new Date("2026-11-16T10:00:00Z");
const empty = (over: Partial<ExistingSnapshot> = {}): ExistingSnapshot => ({
  patients: [],
  appointmentRefs: new Set(),
  prescriptionRefs: new Set(),
  documentHashes: new Set(),
  therapists: [],
  locations: [],
  services: [],
  ...over,
});
const q = (v: string) => (v === "" ? "" : `"${v.replace(/"/g, '""')}"`);
/** CSV im Format des Gesamtexports (BOM, „;“, Kopfzeile wie im Original) */
function csv(file: keyof typeof PODODESK_HEADERS, rows: Record<string, string>[], headers: readonly string[] = PODODESK_HEADERS[file]): string {
  return ["﻿" + headers.map(q).join(";"), ...rows.map((r) => headers.map((h) => q(r[h] ?? "")).join(";"))].join("\n");
}
const warningsOf = (p: { warnings: { message: string }[] }) => p.warnings.map((w) => w.message).join("\n");

describe("B1: mehrere Pododesk-Praxen (ID-Kollision)", () => {
  it("(a) zwei unterschiedliche patienten.csv im selben Upload → beide abgelehnt, mit Hinweis", async () => {
    const a = csv("patienten", [{ id: "1", vorname: "Anna", nachname: "Praxis-A", geburtsdatum: "1950-01-01" }]);
    const b = csv("patienten", [{ id: "1", vorname: "Berta", nachname: "Praxis-B", geburtsdatum: "1980-02-02" }]);
    const files = await collectFiles([
      { name: "a/patienten.csv", data: enc(a) },
      { name: "b/patienten.csv", data: enc(b) },
    ]);
    expect(files.map((f) => f.status)).toEqual(["rejected", "rejected"]);
    for (const f of files) {
      expect(f.note).toBe("Mehrere unterschiedliche Pododesk-Exporte – bitte nur einen Export hochladen. Mehrere Pododesk-Praxen in einem PodoHero-Konto werden derzeit nicht unterstützt.");
      expect(f.label).toBe("Pododesk – Patient:innen");
      expect(f.pododeskPatients).toBeUndefined();
    }
    const plan = buildPlan(files, empty(), { prescriptionMode: "billed", now: NOW });
    expect(plan.patientsCreate).toEqual([]);
  });

  it("(a) zwei Gesamtexport-ZIPs zweier Praxen → alle doppelt vorhandenen Arten abgelehnt; gleicher Inhalt zweimal bleibt „doppelt“", async () => {
    const zipA = buildZip(FILES.map((n) => ({ path: n, data: fx(n) })));
    const other = csv("termine", [{ id: "101", beginn: "2026-01-13T08:00:00.000Z", patient: "1" }]);
    const zipB = buildZip([{ path: "termine.csv", data: enc(other) }]);
    const files = await collectFiles([
      { name: "praxis-a.zip", data: zipA },
      { name: "praxis-b.zip", data: zipB },
    ]);
    const termine = files.filter((f) => f.kind === "pododesk.appointments" || f.label === "Pododesk – Termine");
    expect(termine).toHaveLength(2);
    expect(termine.every((f) => f.status === "rejected" && /nur einen Export hochladen/.test(f.note ?? ""))).toBe(true);
    // die übrigen Dateien (nur einmal vorhanden) bleiben erhalten
    expect(files.find((f) => f.kind === "pododesk.patients")!.status).toBe("import");
    // derselbe Export zweimal: nur „doppelt“, nicht abgelehnt
    const twice = await collectFiles([
      { name: "x/patienten.csv", data: fx("patienten.csv") },
      { name: "y/patienten.csv", data: fx("patienten.csv") },
    ]);
    expect(twice.map((f) => f.status)).toEqual(["import", "duplicate"]);
  });

  it("(b) Treffer über die Pododesk-ID, aber Name und Geburtsdatum weichen ab → nicht verknüpft, Warnung, Termine nicht zugeordnet", async () => {
    const zip = buildZip(FILES.map((n) => ({ path: n, data: fx(n) })));
    const existing = empty({
      patients: [{ id: "fremd", number: 41, firstName: "Otto", lastName: "Andere-Praxis", birthDate: "1990-09-09", email: null, phoneMobile: null, externalIds: { pododesk: "1" } }],
    });
    const plan = buildPlan(await collectFiles([{ name: "export.zip", data: zip }]), existing, { prescriptionMode: "billed", now: NOW });
    expect(plan.patientsLink).toEqual([]);
    expect(plan.patientsCreate.some((p) => p.values.externalIds.pododesk === "1")).toBe(false);
    expect(plan.totals.patientsExisting).toBe(0);
    const w = warningsOf(plan);
    expect(w).toContain("Pododesk-ID 1: Nr. 41 im Bestand ist nicht sicher dieselbe Person (anderer Name, anderes Geburtsdatum) – nicht verknüpft");
    // Termine 101, 103, 107 gehören zu Pododesk-ID 1 → nicht zugeordnet
    expect(plan.appointments.map((a) => a.externalId).sort()).toEqual(["pododesk:102", "pododesk:104"]);
    expect(plan.appointments.some((a) => "existingId" in a.patient && a.patient.existingId === "fremd")).toBe(false);
    expect(w).toMatch(/3 Termine gehören zu Pododesk-IDs, deren Bestandsperson nicht sicher dieselbe ist – nicht übernommen/);
  });

  it("(b) nur der Name weicht ab (z. B. Heirat) bzw. gleicher Name mit anderem Geburtsdatum → je eine Entscheidung, Standard „nicht verknüpfen“ (R4-B)", async () => {
    const zip = buildZip(FILES.map((n) => ({ path: n, data: fx(n) })));
    const existing = empty({
      patients: [
        { id: "p1", number: 1, firstName: "Paula", lastName: "Neuname", birthDate: "1953-04-15", email: null, phoneMobile: null, externalIds: { pododesk: "1" } },
        { id: "p2", number: 2, firstName: "Bruno", lastName: "Beispielmann", birthDate: "1947-10-06", email: null, phoneMobile: null, externalIds: { pododesk: "2" } },
      ],
    });
    const plan = buildPlan(await collectFiles([{ name: "export.zip", data: zip }]), existing, { prescriptionMode: "billed", now: NOW });
    expect(plan.totals.patientsExisting).toBe(0);
    expect(plan.decisions.map((d) => [d.key, d.defaultChoice, d.candidates[0].reason])).toEqual([
      ["pododesk:1", "new", "gleiche Pododesk-ID, anderer Name, gleiches Geburtsdatum"],
      ["pododesk:2", "new", "gleiche Pododesk-ID, gleicher Name, anderes Geburtsdatum"],
    ]);
    // Auswahl „verknüpfen“ für die Heirat → dieselbe Person
    const chosen = buildPlan(await collectFiles([{ name: "export.zip", data: zip }]), existing, { prescriptionMode: "billed", now: NOW, choices: { "pododesk:1": "p1" } });
    expect(chosen.totals.patientsExisting).toBe(1);
    expect(warningsOf(chosen)).toMatch(/Pododesk-ID 2: Nr\. 2 im Bestand ist nicht sicher dieselbe Person/);
  });
});

describe("AppSec A-B1: keine ReDoS in der Vorschau (betrifft alle Quellen)", () => {
  it("Regressionstest: 32.000-Zeichen-Meldung wird in < 50 ms maskiert", () => {
    for (const msg of [
      `Leistung K0${"k".repeat(32_000)}: Vergütung nicht lesbar – Preis 0 übernommen, bitte prüfen.`,
      `${"a@".repeat(16_000)}`,
      `${"a@b".repeat(10_000)}.`,
      `E-Mail (${"1".repeat(32_000)}`,
      `Geburtsdatum ${"„".repeat(32_000)}`,
      `Telefon ${"0 ".repeat(16_000)}`,
    ]) {
      const t0 = performance.now();
      maskPii(msg);
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });

  it("E-Mail-Adressen und Telefonnummern werden weiterhin maskiert", () => {
    expect(maskPii("Kontakt erika.musterfrau@example.org, Tel. 0170 1234567.")).toBe("Kontakt ***@***, Tel. ***.");
    expect(maskPii("„a.b@c.de.“")).toBe("„***@***.“");
    expect(maskPii("Rechnung RE-2026-00001")).toBe("Rechnung RE-2026-00001");
  });

  it("toPreview kürzt Meldungen und Dateinotizen vor dem Maskieren; 200 lange Hinweise in < 1 s", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: String(i), kuerzel: `K${i}` + "k".repeat(16_000), mehrwertsteuer: "v", verguetung: "-1" }));
    const files = await collectFiles([{ name: "leistungenPrivat.csv", data: enc(csv("leistungenPrivat", rows)) }]);
    const plan = buildPlan(files, empty(), { prescriptionMode: "billed", now: NOW });
    // Kürzel in Hinweisen gekürzt (50 Zeichen)
    expect(Math.max(...plan.warnings.map((w) => w.message.length))).toBeLessThan(300);
    const long = { ...plan, warnings: [...plan.warnings, { message: "x".repeat(32_000) }], files: plan.files.map((f) => ({ ...f, note: "n".repeat(32_000) })) };
    const t0 = performance.now();
    const p = toPreview(long);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(Math.max(...p.warnings.map((w) => w.message.length))).toBeLessThanOrEqual(501);
    expect(Math.max(...p.files.map((f) => f.note?.length ?? 0))).toBeLessThanOrEqual(501);
  });

  it("MwSt-Rohwert (20) und Tinana-Formulartyp in Hinweisen gekürzt", async () => {
    const files = await collectFiles([{ name: "leistungenPrivat.csv", data: enc(csv("leistungenPrivat", [{ id: "1", kuerzel: "X", mehrwertsteuer: "1".repeat(5000) + ".5", verguetung: "100" }])) }]);
    const msgs = files[0].issues.map((i) => i.message);
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) expect(m.length).toBeLessThan(200);
    const header = "formulartyp;heilmittel_positionsnummer;kostentraeger_id;patient_geburtsdatum;patient_vorname;patient_nachname;ausstelldatum";
    const t = readTable(`${header}\n${"F".repeat(5000)};78501;100000001;01.01.1950;E;M;01.01.2026\n`);
    const { issues } = parseTinanaPrescriptions(t, "p.csv");
    const form = issues.find((i) => /Formular/.test(i.message))!;
    expect(form.message.length).toBeLessThan(200);
  });
});

describe("AppSec A-B2: Steuerzeichen und Server-Log (betrifft alle Quellen)", () => {
  it("NUL und andere Steuerzeichen werden aus Feldern und Kopfzeilen entfernt (Tab/Zeilenumbruch bleiben)", () => {
    const t = tableFromRows([
      ["id\u0000", "nachname", "notizen"],
      ["1", "Kaputt\u0000\u0007\u001b", "Zeile 1\nZeile 2\tTab\u007f"],
    ]);
    expect(t.headers).toEqual(["id", "nachname", "notizen"]);
    expect(t.records[0].values).toEqual({ id: "1", nachname: "Kaputt", notizen: "Zeile 1\nZeile 2\tTab" });
  });

  it("auch der Excel-Pfad (Rechnungsmanager) entfernt Steuerzeichen", () => {
    expect(asString("Muster\u0000frau\u0008")).toBe("Musterfrau");
    expect(asString("Zeile 1\nZeile 2")).toBe("Zeile 1\nZeile 2");
  });

  it("NUL hinter den ersten 4 KB einer Pododesk-Datei erreicht den Plan nicht (Gegenmessung nul.mts)", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: String(i + 1), nachname: `Name${i}`, vorname: "Erika", geburtsdatum: "1950-01-01", notizen: "erfunden" }));
    rows.push({ id: "999", nachname: "Kaputt\u0000", vorname: "X", geburtsdatum: "", notizen: "a\u0000b" });
    const data = csv("patienten", rows);
    expect(data.indexOf("\u0000")).toBeGreaterThan(4096);
    const f = await analyzeFile("patienten.csv", enc(data));
    expect(f.status).toBe("import");
    expect(JSON.stringify(f.pododeskPatients)).not.toContain("\\u0000");
    expect(f.pododeskPatients!.find((p) => p.id === "999")).toMatchObject({ lastName: "Kaputt", notes: "ab" });
  });

  it("Server-Log enthält bei DB-Fehlern nur Name und Fehlercode, nie die Meldung (Abfrage mit Parametern = Klardaten)", () => {
    const e = new Error('Failed query: insert into "patients" … params: Geheimname3,Diabetes Typ 2', { cause: Object.assign(new Error("invalid byte sequence"), { code: "22021" }) });
    const line = errorForLog(e);
    expect(line).toBe("Error 22021");
    expect(line).not.toMatch(/Geheimname|Diabetes|insert/);
    expect(errorForLog("irgendwas mit Klartext")).toBe("unbekannter Fehler");
    expect(errorForLog(Object.assign(new TypeError("x@y.de"), { code: "ERR_X" }))).toBe("TypeError ERR_X");
  });
});

describe("S2: gelöschte Leistungen an alten Terminen", () => {
  it("werden nicht als „nicht in leistungenPrivat.csv“ gemeldet, sondern als gelöschte Leistung", async () => {
    const files = await collectFiles([{ name: "export.zip", data: buildZip(FILES.map((n) => ({ path: n, data: fx(n) }))) }]);
    const plan = buildPlan(files, empty(), { prescriptionMode: "billed", now: NOW });
    const w = warningsOf(plan);
    expect(w).not.toMatch(/nicht in leistungenPrivat\.csv/);
    expect(w).toMatch(/1 Termin verweist auf eine in Pododesk gelöschte Leistung/);
    const t104 = plan.appointments.find((a) => a.externalId === "pododesk:104")!;
    expect(t104.notes).toMatch(/ALT \(gelöschte Leistung\)/);
  });
});

describe("S3: Erkennung über Pflichtspalten", () => {
  it("Zusatzspalte (neue Pododesk-Version) wird erkannt, fehlende Pflichtspalte nicht; zusätzliche Spalten werden nicht gelesen", async () => {
    const h = PODODESK_HEADERS.patienten.map((x) => x.toLowerCase());
    expect(pododeskFileOf([...h, "neuesfeld"])).toBe("patienten");
    expect(pododeskFileOf(h.filter((x) => x !== "geburtsdatum"))).toBeNull();
    // nicht gelesene Originalspalte fehlt → trotzdem erkannt (nur Pflichtspalten zählen)
    expect(pododeskFileOf(h.filter((x) => x !== "abgewandertzu"))).toBe("patienten");
    // Ärzte-Pflichtspalten sind Teilmenge der Patientendatei: die genauere Datei gewinnt
    expect(pododeskFileOf(PODODESK_HEADERS.aerzte.map((x) => x.toLowerCase()))).toBe("aerzte");
    const data = csv("patienten", [{ id: "1", nachname: "Zusatz", vorname: "Z", neuesFeld: "geheim-zusatz" } as Record<string, string>], [...PODODESK_HEADERS.patienten, "neuesFeld"]);
    const f = await analyzeFile("patienten.csv", enc(data));
    expect(f.kind).toBe("pododesk.patients");
    expect(JSON.stringify(f)).not.toContain("geheim-zusatz");
  });
});

describe("S4 / A-H3: Mehrwertsteuer nur 0, 7 oder 19 %", () => {
  it("anderer Satz → 19 % mit Warnung (wie Excel-Import); 7 % bleibt", async () => {
    const rows = [
      { id: "1", kuerzel: "A", mehrwertsteuer: "16.00", verguetung: "100" },
      { id: "2", kuerzel: "B", mehrwertsteuer: "7.00", verguetung: "100" },
      { id: "3", kuerzel: "C", mehrwertsteuer: "0.00", verguetung: "100" },
      { id: "4", kuerzel: "D", mehrwertsteuer: "19,4", verguetung: "100" },
    ];
    const f = await analyzeFile("leistungenPrivat.csv", enc(csv("leistungenPrivat", rows)));
    expect(f.pododeskServices!.map((s) => s.vatRate)).toEqual([19, 7, 0, 19]);
    const msgs = f.issues.map((i) => i.message).join("\n");
    expect(msgs).toMatch(/Leistung A: Ungewöhnlicher Steuersatz 16\.00 % – 19 % angenommen, bitte prüfen\./);
    expect(msgs).toMatch(/Leistung D: Ungewöhnlicher Steuersatz 19,4 %/);
    expect(msgs).not.toMatch(/Leistung [BC]:/);
  });
});

describe("AppSec A-H1/A-H2: Grenzen für Leistungen und Produkte am Termin", () => {
  it("höchstens 10 Leistungen je Termin; Produkte-Feld über 10.000 Zeichen wird nicht gelesen", async () => {
    expect(MAX_SERVICES_PER_APPOINTMENT).toBe(10);
    const refs = JSON.stringify(Array.from({ length: 30 }, (_, k) => ({ istKKLeistung: false, id: k + 1 })));
    expect(parseServiceRefs(refs)).toHaveLength(10);
    const products = JSON.stringify(Array.from({ length: 500 }, () => ({ amount: 1, productId: 1 })));
    expect(products.length).toBeGreaterThan(10_000);
    const f = await analyzeFile("termine.csv", enc(csv("termine", [{ id: "1", beginn: "2026-01-13T08:00:00.000Z", patient: "1", leistungen: refs, products }])));
    const a = f.pododeskAppointments![0];
    expect(a.services).toHaveLength(10);
    expect(a.products).toBe(0);
    expect(f.issues.map((i) => i.message).join("\n")).toMatch(/mehr als 10 Leistungen – nur die ersten 10 übernommen/);
  });

  it("höchstens 200.000 Verknüpfungen Termin–Leistung je Lauf, mit Hinweis in der Vorschau", async () => {
    const svc = Array.from({ length: 10 }, (_, k) => ({ id: String(k + 1), kuerzel: `K${k + 1}`, mehrwertsteuer: "19.00", verguetung: "100" }));
    const leist = JSON.stringify(svc.map((s) => ({ istKKLeistung: false, id: Number(s.id) })));
    const appts = Array.from({ length: 20_005 }, (_, i) => ({ id: String(i + 1), beginn: "2025-03-01T08:00:00.000Z", ende: "2025-03-01T08:30:00.000Z", patient: "1", leistungen: leist }));
    const files = await collectFiles([
      { name: "patienten.csv", data: enc(csv("patienten", [{ id: "1", nachname: "M", vorname: "E" }])) },
      { name: "leistungenPrivat.csv", data: enc(csv("leistungenPrivat", svc)) },
      { name: "termine.csv", data: enc(csv("termine", appts)) },
    ]);
    const plan = buildPlan(files, empty(), { prescriptionMode: "billed", now: NOW });
    const links = plan.appointments.reduce((n, a) => n + a.serviceIds.length + (a.serviceCodes?.length ?? 0), 0);
    expect(links).toBe(200_000);
    expect(plan.appointments).toHaveLength(20_005);
    expect(warningsOf(toPreview(plan))).toMatch(/Mehr als 200\.000 Leistungen an Terminen – bei 5 Terminen stehen die Leistungen nur in der Terminnotiz/);
  });
});

describe("Nice", () => {
  it("isallday wird nicht gelesen; Leistungsname mit eigener Längengrenze", async () => {
    expect(PODODESK_COLUMNS.termine).not.toContain("isallday");
    const f = await analyzeFile("leistungenPrivat.csv", enc(csv("leistungenPrivat", [{ id: "1", kuerzel: "L", beschreibung: "B".repeat(1000), mehrwertsteuer: "0.00", verguetung: "100" }])));
    const plan = buildPlan([f], empty(), { prescriptionMode: "billed", now: NOW });
    expect(plan.servicesCreate[0].name.length).toBe(200);
  });
});
