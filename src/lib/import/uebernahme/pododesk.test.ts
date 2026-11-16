/**
 * Pododesk-Gesamtexport: Erkennung (exakte Kopfzeilen, einzeln und im ZIP), Parser, Verwerfen sensibler Spalten,
 * Zeitzonen und Plan. Nur erfundene Daten (src/lib/import/__fixtures__/pododesk/gesamtexport).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectFiles } from "./collect";
import { analyzeFile } from "./detect";
import { buildPlan, type ExistingSnapshot } from "./plan";
import { paletteColor, parseServiceRefs, parseUtc, PODODESK_COLUMNS, PODODESK_HEADERS, PODODESK_SENSITIVE, pododeskFileOf, restrictColumns } from "./pododesk";
import { toPreview } from "./preview-safety";
import { readTable } from "./text";
import { buildZip } from "./zip";

const FIX = path.resolve(__dirname, "../__fixtures__/pododesk/gesamtexport");
export const PODODESK_FILES = ["aerzte.csv", "leistungenPrivat.csv", "patienten.csv", "praxisstammdaten.csv", "termine.csv", "users.csv"];
const fx = (n: string) => new Uint8Array(readFileSync(path.join(FIX, n)));

/** Gesamtexport wie von Pododesk: ein ZIP mit den sechs CSV-Dateien */
export function pododeskZip(): Uint8Array {
  return buildZip(PODODESK_FILES.map((n) => ({ path: n, data: fx(n) })));
}
export const pododeskUpload = () => collectFiles([{ name: "praxisdaten-export.zip", data: pododeskZip() }]);

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
const NOW = new Date("2026-11-16T10:00:00Z");
const berlin = (iso: string) => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" }).format(new Date(iso));

/** Werte, die nie aus dem Export gelesen werden dürfen (Bank, Zugangsdaten, Tokens) */
const SECRETS = ["DE00123456780000000099", "TESTDEFFXXX", "Beispielbank", "paypal-geheim@example.org", "sevdesk-geheim-0000", "sevdesk-nutzer-0000", "auth-geheim-0001", "ical-geheim-0001", "therapeutin@example.org"];

describe("Pododesk-Gesamtexport: Erkennung", () => {
  it("Fixtures haben exakt die Kopfzeilen des echten Exports (UTF-8 mit BOM, „;“)", () => {
    expect(readdirSync(FIX).sort()).toEqual([...PODODESK_FILES].sort());
    for (const n of PODODESK_FILES) {
      const data = fx(n);
      expect([...data.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const first = new TextDecoder().decode(data).replace(/^﻿/, "").split("\n")[0];
      expect(first).toBe(PODODESK_HEADERS[n.replace(".csv", "") as keyof typeof PODODESK_HEADERS].map((h) => `"${h}"`).join(";"));
    }
  });

  it.each([
    ["patienten.csv", "pododesk.patients", "import", 3],
    ["termine.csv", "pododesk.appointments", "import", 7],
    ["leistungenPrivat.csv", "pododesk.services", "import", 4],
    ["aerzte.csv", "pododesk.doctors", "info", 2],
    ["users.csv", "pododesk.users", "info", 2],
    ["praxisstammdaten.csv", "pododesk.practice", "info", 1],
  ])("%s einzeln → %s", async (name, kind, status, records) => {
    const f = await analyzeFile(name, fx(name));
    expect(f).toMatchObject({ kind, source: "pododesk", status, records });
    expect(f.label).toMatch(/^Pododesk – /);
  });

  it("erkennt die Dateien im ZIP und umbenannt – nur über die Kopfzeile", async () => {
    const files = await pododeskUpload();
    expect(files.map((f) => f.kind).sort()).toEqual(["pododesk.appointments", "pododesk.doctors", "pododesk.patients", "pododesk.practice", "pododesk.services", "pododesk.users"]);
    const renamed = await analyzeFile("Download (1).csv", fx("patienten.csv"));
    expect(renamed.kind).toBe("pododesk.patients");
  });

  it("Pflichtspalten: Reihenfolge egal, zusätzliche Spalten erlaubt, fehlende Pflichtspalte → nicht erkannt (S3)", () => {
    const h = PODODESK_HEADERS.patienten.map((x) => x.toLowerCase());
    expect(pododeskFileOf(h)).toBe("patienten");
    expect(pododeskFileOf([...h].reverse())).toBe("patienten");
    expect(pododeskFileOf(h.slice(1))).toBeNull();
    expect(pododeskFileOf([...h, "extra"])).toBe("patienten");
  });
});

describe("Pododesk-Gesamtexport: sensible Spalten werden verworfen", () => {
  it("Bankdaten, PayPal, sevDesk-Schlüssel, iCal-Token, Auth-IDs und Einwilligungs-Schalter erreichen weder Erkennung noch Plan noch Vorschau", async () => {
    const files = await pododeskUpload();
    const plan = buildPlan(files, empty(), { prescriptionMode: "billed", now: NOW });
    const dump = JSON.stringify([files, plan, toPreview(plan)], (_k, v) => (v instanceof Set ? [...v] : v instanceof Uint8Array ? null : v));
    for (const s of SECRETS) expect(dump).not.toContain(s);
    // Einwilligungs-Schalter (emailErinnerung/smsReminder/emailNewsletter) werden nicht als Einwilligung gewertet
    expect(dump).not.toMatch(/erinnerung|newsletter|smsreminder|callreminder/i);
    for (const c of plan.patientsCreate) expect(Object.keys(c.values.extra)).not.toEqual(expect.arrayContaining(["consents", "no_reminders"]));
  });

  it("restrictColumns behält nur die erlaubten Spalten", () => {
    const text = new TextDecoder().decode(fx("praxisstammdaten.csv"));
    const t = restrictColumns(readTable(text), "praxisstammdaten");
    expect(t.headers.sort()).toEqual([...PODODESK_COLUMNS.praxisstammdaten].sort());
    expect(Object.keys(t.records[0].values).sort()).toEqual(["currency", "standardbehandlungsdauer", "terminraster"]);
    for (const k of PODODESK_SENSITIVE.praxisstammdaten) expect(t.records[0].values[k]).toBeUndefined();
    const u = restrictColumns(readTable(new TextDecoder().decode(fx("users.csv"))), "users");
    for (const k of PODODESK_SENSITIVE.users) expect(u.records[0].values[k]).toBeUndefined();
    const p = restrictColumns(readTable(new TextDecoder().decode(fx("patienten.csv"))), "patienten");
    for (const k of PODODESK_SENSITIVE.patienten) expect(p.records[0].values[k]).toBeUndefined();
  });
});

describe("Pododesk-Gesamtexport: Zeitzonen und Felder", () => {
  it("UTC-Zeitstempel → richtige Berliner Uhrzeit im Winter (MEZ) und Sommer (MESZ)", async () => {
    const f = await analyzeFile("termine.csv", fx("termine.csv"));
    const a = (id: string) => f.pododeskAppointments!.find((x) => x.id === id)!;
    expect(a("101").startsAt).toBe("2026-01-13T08:00:00.000Z");
    expect(berlin(a("101").startsAt)).toBe("13.01.26, 09:00");
    expect(berlin(a("102").startsAt)).toBe("01.07.26, 09:00");
    expect(berlin(a("103").startsAt)).toBe("12.03.30, 09:30");
    expect(berlin(a("106").startsAt)).toBe("02.07.30, 09:00");
    // Zeitumstellung: 29.03.2026 01:30 UTC = 03:30 MESZ
    expect(berlin(parseUtc("2026-03-29T01:30:00.000Z")!)).toBe("29.03.26, 03:30");
    // ohne Zone (z. B. nach Excel) gilt der Wert als UTC wie im Export
    expect(parseUtc("2026-07-01 07:00")).toBe("2026-07-01T07:00:00.000Z");
    expect(parseUtc("01.07.2026 07:00")).toBe("2026-07-01T07:00:00.000Z");
    expect(parseUtc("Montag")).toBeNull();
  });

  it("Leistungen am Termin (JSON), Absage, Hausbesuch, organisatorisch, Produkte", async () => {
    const f = await analyzeFile("termine.csv", fx("termine.csv"));
    const a = (id: string) => f.pododeskAppointments!.find((x) => x.id === id)!;
    expect(a("101").services).toEqual([{ id: "1", kk: false }, { id: "5", kk: true }]);
    expect(a("102")).toMatchObject({ homeVisit: true, cancelled: false });
    expect(a("104")).toMatchObject({ cancelled: true, cancelledOn: "2026-05-04", cancelReason: "Termin verschoben (erfunden)" });
    expect(a("105")).toMatchObject({ organizational: true, patientId: null });
    expect(a("107").products).toBe(1);
    expect(parseServiceRefs("kein json")).toBeNull();
    expect(parseServiceRefs('[{"id":"../x","istKKLeistung":false}]')).toEqual([]);
  });

  it("Patient:innen, Leistungen und Farben", async () => {
    const p = (await analyzeFile("patienten.csv", fx("patienten.csv"))).pododeskPatients!;
    expect(p[0]).toMatchObject({ id: "1", number: "1001", salutation: "Frau", lastName: "Beispiel", birthDate: "1953-04-15", street: "Beispielweg 1", phoneMobile: "0176 04069001", insurerName: "Beispiel-BKK", insurerIk: "100000001", insuranceNumber: "X000000001", insuranceType: "gkv", gpId: "1" });
    // Mobilnummer im Telefonfeld → Mobil; privat versichert
    expect(p[1]).toMatchObject({ salutation: "Herr", title: "Prof.", phoneMobile: "0176 04069002", phoneLandline: null, insuranceType: "pkv", specialistId: "2" });
    expect(p[2]).toMatchObject({ deceased: true, deceasedOn: "2026-10-01" });
    const s = (await analyzeFile("leistungenPrivat.csv", fx("leistungenPrivat.csv"))).pododeskServices!;
    expect(s[0]).toMatchObject({ code: "DFa2 priv.", name: "Hornhautabtragung (beide Füße)", priceCents: 1200, vatRate: 19, durationMin: 30, deleted: false });
    expect(s[1]).toMatchObject({ code: "PKB", priceCents: 4500, vatRate: 0, durationMin: 45 });
    expect(s[2].deleted).toBe(true);
    expect(s[3].durationMin).toBe(20);
    expect(paletteColor("#2a9d8f")).toBe("teal");
    expect(paletteColor("#e76f51")).toBe("orange");
    expect(paletteColor("#2563eb")).toBe("blue");
    expect(paletteColor("#9ca3af")).toBe("stone");
    expect(paletteColor("rot")).toBeNull();
  });
});

describe("Pododesk-Gesamtexport: Plan", () => {
  it("leere Praxis: Patient:innen, Leistungen und Termine neu – mit Hinweisen statt stiller Annahmen", async () => {
    const plan = buildPlan(await pododeskUpload(), empty({ therapists: [{ id: "u1", name: "Therapeutin Eins", color: null }] }), { prescriptionMode: "billed", now: NOW });
    expect(plan.totals).toMatchObject({ patientsNew: 3, appointmentsNew: 5, appointmentsUnassigned: 1, servicesNew: 3, servicesExisting: 0 });
    expect(plan.hasWork).toBe(true);
    const paula = plan.patientsCreate.find((p) => p.values.lastName === "Beispiel")!;
    expect(paula.values).toMatchObject({
      salutation: "Frau",
      insuranceType: "gkv",
      insurerName: "Beispiel-BKK",
      insuranceNumber: "X000000001",
      gpName: "Dr. med. Hanna Beispielarzt",
      email: "paula.beispiel@example.org",
      externalIds: { pododesk: "1" },
      source: "pododesk-import",
    });
    expect(paula.values.extra).toMatchObject({ payerIk: "100000001", pododeskNumber: "1001", gp_city: "Musterstadt", occupation: "Lehrerin", patientSince: "2020-05-04" });
    expect(plan.patientsCreate.find((p) => p.values.lastName === "Beispielmann")!.values.extra).toMatchObject({ specialist: "Dr. Felix Facharzt-Beispiel" });
    expect(plan.patientsCreate.find((p) => p.values.lastName === "Beispiel-Muster")!.values.extra.deceased).toMatchObject({ date: "2026-10-01" });
    // Leistungen: gelöschte nicht, Dauer aus der Regelbehandlungszeit
    expect(plan.servicesCreate.map((s) => s.code)).toEqual(["DFa2 priv.", "PKB", "NAG"]);
    expect(plan.servicesCreate[2]).toMatchObject({ priceCents: 2000, vatRate: 19, durationMin: 20 });
    // Termine: vergangen → erledigt, Zukunft → geplant, Absage → abgesagt; Quelle-ID je Termin
    const byId = new Map(plan.appointments.map((a) => [a.externalId, a]));
    expect(byId.get("pododesk:101")).toMatchObject({ status: "done", therapistId: "u1", serviceCodes: ["DFa2 priv."], homeVisit: false });
    expect(byId.get("pododesk:101")!.notes).toMatch(/Kassenleistung Nr\. 5/);
    expect(byId.get("pododesk:102")).toMatchObject({ status: "done", therapistId: null, homeVisit: true, serviceCodes: ["PKB"] });
    expect(byId.get("pododesk:103")).toMatchObject({ status: "planned", serviceCodes: ["NAG"] });
    expect(byId.get("pododesk:104")).toMatchObject({ status: "cancelled", serviceCodes: [] });
    expect(byId.get("pododesk:104")!.notes).toMatch(/Abgesagt in Pododesk am 04\.05\.2026: Termin verschoben/);
    expect(byId.get("pododesk:107")!.notes).toMatch(/1 Produkt am Termin verkauft/);
    expect(byId.has("pododesk:105")).toBe(false); // organisatorisch
    expect(byId.has("pododesk:106")).toBe(false); // künftiger Termin einer verstorbenen Person
    // Team: Farbe nur für die zugeordnete Person ohne Farbe; keine Nutzerkonten
    expect(plan.therapistColors).toEqual([{ userId: "u1", color: "teal" }]);
    const w = plan.warnings.map((x) => x.message).join("\n");
    expect(w).toMatch(/1 organisatorischer Termin .* nicht übernommen – davon 1 in der Zukunft/);
    expect(w).toMatch(/Kassenleistungen/);
    expect(w).toMatch(/Behandler:in ohne gleichnamiges Teammitglied: Clara Beispiel-Team/);
    expect(w).toMatch(/1 in Pododesk gelöschte Leistung wird nicht übernommen/);
    expect(w).toMatch(/verstorben/);
    expect(w).toMatch(/Produkte verkauft/);
    expect(plan.practiceHints.join("\n")).toMatch(/Terminraster in Pododesk: 15 Minuten/);
    expect(plan.practiceHints.join("\n")).toMatch(/Standard-Behandlungsdauer in Pododesk: 30 Minuten/);
    // Beispiele pseudonymisiert
    expect(JSON.stringify(plan.samples)).not.toMatch(/Beispiel(mann)?\b|Paula/);
  });

  it("zweiter Lauf: vorhandene Quell-IDs, Termine und Kürzel → nichts Neues; Farbe nur wenn leer", async () => {
    // dieselben Personen (Name + Geburtsdatum wie im Export); eine andere Person unter derselben ID wird nicht
    // automatisch als vorhanden gewertet (B1, pododesk-runde2.test.ts)
    const people = [
      ["1", "Paula", "Beispiel", "1953-04-15"],
      ["2", "Bruno", "Beispielmann", "1947-10-05"],
      ["3", "Greta", "Beispiel-Muster", "1939-06-20"],
    ];
    const existing = empty({
      patients: people.map(([id, firstName, lastName, birthDate], i) => ({ id: `p${id}`, number: i + 1, firstName, lastName, birthDate, email: null, phoneMobile: null, externalIds: { pododesk: id } })),
      appointmentRefs: new Set(["101", "102", "103", "104", "107"].map((x) => `pododesk:${x}`)),
      services: [
        { id: "s1", code: "dfa2 priv.", name: "Hornhaut", active: true },
        { id: "s2", code: "PKB", name: "Komplex", active: false },
        { id: "s3", code: "NAG", name: "Nagel" },
      ],
      therapists: [{ id: "u1", name: "Therapeutin Eins", color: "rose" }],
    });
    const plan = buildPlan(await pododeskUpload(), existing, { prescriptionMode: "billed", now: NOW });
    expect(plan.totals).toMatchObject({ patientsNew: 0, patientsExisting: 3, appointmentsNew: 0, appointmentsExisting: 5, servicesNew: 0, servicesExisting: 3 });
    expect(plan.therapistColors).toEqual([]);
    expect(plan.hasWork).toBe(false);
  });

  it("Bestandsperson mit gleichem Namen + Geburtsdatum → Verknüpfung als Standard; Art. 17 gelöschte Person wird nie neu angelegt", async () => {
    const existing = empty({
      patients: [
        { id: "a", number: 7, firstName: "Paula", lastName: "Beispiel", birthDate: "1953-04-15", email: null, phoneMobile: null, externalIds: {} },
        { id: "b", number: 8, firstName: "Bruno", lastName: "Beispielmann", birthDate: "1947-10-05", email: null, phoneMobile: null, externalIds: {}, erased: true },
      ],
    });
    const plan = buildPlan(await pododeskUpload(), existing, { prescriptionMode: "billed", now: NOW });
    expect(plan.patientsLink).toEqual([{ patientId: "a", key: "pododesk", externalId: "1" }]);
    expect(plan.decisions[0]).toMatchObject({ key: "pododesk:1", defaultChoice: "a", sourceLabel: "Pododesk" });
    expect(plan.totals).toMatchObject({ patientsNew: 1, patientsLinked: 1, patientsErased: 1 });
    // Termine der gelöschten Person (102, 104) nicht übernommen
    expect(plan.appointments.map((a) => a.externalId).sort()).toEqual(["pododesk:101", "pododesk:103", "pododesk:107"]);
    // mit der Auswahl „neu anlegen“ wird nicht verknüpft
    const neu = buildPlan(await pododeskUpload(), existing, { prescriptionMode: "billed", now: NOW, choices: { "pododesk:1": "new" } });
    expect(neu.patientsLink).toEqual([]);
    expect(neu.totals.patientsNew).toBe(2);
  });

  it("Termine ohne patienten.csv werden nicht übernommen; mit patienten.csv nur deren Personen (R4-A), Wiederholungslauf bleibt gleich", async () => {
    const bestandP1 = empty({ patients: [{ id: "p1", number: 1, firstName: "P", lastName: "B", birthDate: null, email: null, phoneMobile: null, externalIds: { pododesk: "1" } }] });
    const only = await collectFiles([{ name: "termine.csv", data: fx("termine.csv") }]);
    expect(only[0]).toMatchObject({ status: "rejected", note: expect.stringMatching(/nur zusammen mit patienten\.csv/) });
    const plan0 = buildPlan(only, bestandP1, { prescriptionMode: "billed", now: NOW });
    expect(plan0.appointments).toEqual([]);
    expect(plan0.hasWork).toBe(false);

    // beide Dateien: Bestandsperson Nr. 1 (anderer Name, ohne Geburtsdatum) ist nicht sicher Pododesk-ID 1 → Entscheidung
    const both = await collectFiles([
      { name: "patienten.csv", data: fx("patienten.csv") },
      { name: "termine.csv", data: fx("termine.csv") },
    ]);
    const plan = buildPlan(both, bestandP1, { prescriptionMode: "billed", now: NOW });
    expect(plan.decisions.map((d) => [d.key, d.defaultChoice])).toEqual([["pododesk:1", "new"]]);
    expect(plan.appointments.some((a) => "existingId" in a.patient)).toBe(false);
    const w = plan.warnings.map((x) => x.message).join("\n");
    expect(w).toMatch(/3 Termine gehören zu Pododesk-IDs, deren Bestandsperson nicht sicher dieselbe ist/);
    expect(w).toMatch(/nicht in users\.csv/);
  });
});
