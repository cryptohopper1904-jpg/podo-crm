/**
 * Pododesk-Gesamtexport, Review-Runde 3 (PR #108): R3-1 (ID-Abgleich), R3-2 (Termin-ID-Kollision), R3-3 (Kassenbücher),
 * R3-5 (Masken linear, Rohwerte gekürzt), R3-7 (errorForLog). Unit-Tests ohne Datenbank, ausschließlich erfundene Daten.
 */
import { describe, expect, it } from "vitest";
import { parseDoctolibPatientsCsv } from "@/integrations/doctolib/csv";
import { collectFiles } from "./collect";
import { buildPlan, type ExistingPatient, type ExistingSnapshot } from "./plan";
import { PODODESK_HEADERS } from "./pododesk";
import { errorForLog, maskPii, safeWarnings } from "./preview-safety";

const NOW = new Date("2026-11-16T10:00:00Z");
const enc = (s: string) => new TextEncoder().encode(s);
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
function csv(file: keyof typeof PODODESK_HEADERS, rows: Record<string, string>[]): string {
  const headers = PODODESK_HEADERS[file];
  return ["﻿" + headers.map(q).join(";"), ...rows.map((r) => headers.map((h) => q(r[h] ?? "")).join(";"))].join("\n");
}
const warningsOf = (p: { warnings: { message: string }[] }) => p.warnings.map((w) => w.message).join("\n");
const bestand = (firstName: string, lastName: string, birthDate: string | null, pododesk = "1"): ExistingPatient => ({
  id: "e1",
  number: 7,
  firstName,
  lastName,
  birthDate,
  email: null,
  phoneMobile: null,
  externalIds: { pododesk },
});

/** Upload: Person mit Pododesk-ID 1 und ein künftiger Termin t1 */
async function planFor(existing: ExistingPatient, upload: { vorname: string; nachname: string; geburtsdatum: string }) {
  const files = await collectFiles([
    { name: "patienten.csv", data: enc(csv("patienten", [{ id: "1", ...upload }])) },
    { name: "termine.csv", data: enc(csv("termine", [{ id: "t1", beginn: "2027-03-01T08:00:00.000Z", ende: "2027-03-01T08:30:00.000Z", patient: "1" }])) },
  ]);
  return buildPlan(files, empty({ patients: [existing] }), { prescriptionMode: "billed", now: NOW });
}
/** R4-B löst R3-1 ab: automatisch nur bei gleichem Namen UND gleichem Geburtsdatum, sonst Entscheidung (Standard „nicht verknüpfen“) */
const DOUBT = "Pododesk-ID 1: Nr. 7 im Bestand ist nicht sicher dieselbe Person";
const undecided = (plan: Awaited<ReturnType<typeof planFor>>) => {
  expect(warningsOf(plan)).toContain(DOUBT);
  expect(plan.decisions[0]).toMatchObject({ key: "pododesk:1", defaultChoice: "new", choice: "new" });
  expect(plan.appointments).toEqual([]);
  expect(plan.patientsCreate).toEqual([]);
  expect(plan.totals.patientsExisting).toBe(0);
};

describe("R3-1 (seit R4-B): Pododesk-ID-Abgleich", () => {
  it("anderer Name, beide ohne Geburtsdatum → Entscheidung, Termin nicht zugeordnet", async () => {
    undecided(await planFor(bestand("Hans", "Meier", null), { vorname: "Erika", nachname: "Muster", geburtsdatum: "" }));
  });

  it("anderer Name, gleiches Geburtsdatum (z. B. Heirat) → Entscheidung statt still verknüpft", async () => {
    undecided(await planFor(bestand("Hans", "Meier", "1950-01-01"), { vorname: "Erika", nachname: "Muster", geburtsdatum: "1950-01-01" }));
  });

  it("gleicher Name, anderes Geburtsdatum → Entscheidung", async () => {
    undecided(await planFor(bestand("Erika", "Muster", "1940-02-02"), { vorname: "Erika", nachname: "Muster", geburtsdatum: "1950-01-01" }));
  });

  it("gleicher Name, ein oder beide Geburtsdaten fehlen → Entscheidung (alle Richtungen)", async () => {
    for (const [ex, up] of [
      [null, "1950-01-01"],
      ["1950-01-01", ""],
      [null, ""],
    ] as const) {
      undecided(await planFor(bestand("Erika", "Muster", ex), { vorname: "Erika", nachname: "Muster", geburtsdatum: up }));
    }
  });

  it("gleicher Name und gleiches Geburtsdatum → verknüpft", async () => {
    const plan = await planFor(bestand("Erika", "Muster", "1950-01-01"), { vorname: "Erika", nachname: "Muster", geburtsdatum: "1950-01-01" });
    expect(plan.decisions).toEqual([]);
    expect(plan.appointments.map((a) => a.patient)).toEqual([{ existingId: "e1" }]);
  });

  it("alles verschieden → Entscheidung, Sammelhinweis zu den Terminen", async () => {
    const plan = await planFor(bestand("Hans", "Meier", "1940-02-02"), { vorname: "Erika", nachname: "Muster", geburtsdatum: "1950-01-01" });
    undecided(plan);
    expect(warningsOf(plan)).toMatch(/1 Termin gehört zu Pododesk-IDs, deren Bestandsperson nicht sicher dieselbe ist/);
  });
});

describe("R3-2: Termin-ID-Kollision mit einem Termin einer anderen Person", () => {
  const files = () =>
    collectFiles([
      { name: "patienten.csv", data: enc(csv("patienten", [{ id: "9", vorname: "Erika", nachname: "Muster", geburtsdatum: "1950-01-01" }])) },
      {
        name: "termine.csv",
        data: enc(
          csv("termine", [
            { id: "101", beginn: "2027-03-01T08:00:00.000Z", ende: "2027-03-01T08:30:00.000Z", patient: "9" },
            { id: "102", beginn: "2027-03-02T08:00:00.000Z", ende: "2027-03-02T08:30:00.000Z", patient: "9" },
          ]),
        ),
      },
    ]);

  it("neue Person, Termin-IDs gehören im Bestand einer anderen Person → nicht „bereits übernommen“, Sammelhinweis", async () => {
    const existing = empty({
      appointmentRefs: new Set(["pododesk:101", "pododesk:102"]),
      appointmentPatients: new Map([
        ["pododesk:101", "fremd"],
        ["pododesk:102", "fremd"],
      ]),
    });
    const plan = buildPlan(await files(), existing, { prescriptionMode: "billed", now: NOW });
    expect(plan.totals.appointmentsExisting).toBe(0);
    expect(plan.appointments).toEqual([]);
    expect(warningsOf(plan)).toContain("2 Pododesk-Termine kollidieren mit bereits übernommenen Terminen anderer Personen – nicht übernommen");
  });

  it("einzelne Kollision nennt die Termin-ID", async () => {
    const existing = empty({ appointmentRefs: new Set(["pododesk:101"]), appointmentPatients: new Map([["pododesk:101", "fremd"]]) });
    const plan = buildPlan(await files(), existing, { prescriptionMode: "billed", now: NOW });
    expect(warningsOf(plan)).toContain("Pododesk-Termin 101 kollidiert mit einem bereits übernommenen Termin einer anderen Person – nicht übernommen");
    expect(plan.appointments.map((a) => a.externalId)).toEqual(["pododesk:102"]);
  });

  it("Termin gehört derselben Bestandsperson → weiterhin „bereits übernommen“", async () => {
    const existing = empty({
      patients: [{ ...bestand("Erika", "Muster", "1950-01-01", "9") }],
      appointmentRefs: new Set(["pododesk:101"]),
      appointmentPatients: new Map([["pododesk:101", "e1"]]),
    });
    const plan = buildPlan(await files(), existing, { prescriptionMode: "billed", now: NOW });
    expect(plan.totals.appointmentsExisting).toBe(1);
    expect(warningsOf(plan)).not.toMatch(/kollidier/);
    expect(plan.appointments.map((a) => a.externalId)).toEqual(["pododesk:102"]);
  });
});

describe("R3-3: mehrere Kassenbücher sind kein Praxis-Konflikt", () => {
  it("zwei unterschiedliche Kassenbücher → beide akzeptiert", async () => {
    const book = (end: string) =>
      enc(
        [
          '\uFEFF"Buchungsnummer";"Belegnummer";"Datum";"Erfasst von";"Buchungstyp";"Betreff";"Betrag in €";"Kassenbestand in €"',
          '"1";"KB-0001";"02.01.2026";"Erika Muster";"Anfangsbestand";"Anfangsbestand Kasse";"150,00";"150,00"',
          `"2";"KB-0002";"03.01.2026";"Erika Muster";"Einnahme";"Termin";"24,00";"${end}"`,
        ].join("\n"),
      );
    const files = await collectFiles([
      { name: "Kassenbuch Musterpraxis 01.01.25 - 31.12.25.csv", data: book("174,00") },
      { name: "Kassenbuch Musterpraxis 01.01.26 - 31.12.26.csv", data: book("175,00") },
    ]);
    expect(files.map((f) => f.kind)).toEqual(["pododesk.cashbook", "pododesk.cashbook"]);
    expect(files.map((f) => f.status)).toEqual(["info", "info"]);
    expect(files.every((f) => !f.note?.includes("nur einen Export"))).toBe(true);
  });
});

describe("R3-5: Masken ohne Obergrenze, aber linear; Rohwerte gekürzt", () => {
  it("unbeendete und lange Anführungszeichen/Klammern werden maskiert, < 50 ms", () => {
    expect(maskPii(`Geburtsdatum nicht lesbar („${"9".repeat(300)}`)).toBe("Geburtsdatum nicht lesbar („***");
    expect(maskPii(`Telefon (${"1".repeat(300)})`)).toBe("Telefon (***)");
    expect(maskPii("Erika (Jg. 1950): Geburtsdatum „31.02.1950“")).toBe("Erika (Jg. 1950): Geburtsdatum „***“");
    for (const msg of [`Telefon ${"(".repeat(100_000)}`, `Telefon ${"(1".repeat(50_000)}`, `Telefon ${"„".repeat(100_000)}`, `E-Mail ${"(a".repeat(50_000)}`]) {
      const t0 = performance.now();
      maskPii(msg);
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });

  it("Doctolib-CSV: ungültiges Geburtsdatum nur gekürzt (40 Zeichen) in der Meldung", () => {
    const { issues } = parseDoctolibPatientsCsv(`last_name;first_name;birthdate\nN;E;Geheim-${"9".repeat(5_000)}`);
    expect(issues).toHaveLength(1);
    expect(issues[0].message.length).toBeLessThan(80);
  });

  it("safeWarnings: höchstens 200 Meldungen, je höchstens 500 Zeichen, maskiert", () => {
    const list = Array.from({ length: 300 }, (_, i) => ({ row: i, message: `E-Mail-Adresse wirkt ungültig („erika${i}@example.org“) ${"x".repeat(2_000)}` }));
    const out = safeWarnings(list);
    expect(out).toHaveLength(200);
    expect(out[0].row).toBe(0);
    expect(Math.max(...out.map((w) => w.message.length))).toBeLessThanOrEqual(501);
    expect(out.some((w) => w.message.includes("example.org"))).toBe(false);
  });
});

describe("R3-7: errorForLog übernimmt nur SQLSTATE- bzw. Node-Fehlercodes", () => {
  it.each([
    ["23505", "Error 23505"],
    ["22P02", "Error 22P02"],
    ["ERR_INVALID_ARG_TYPE", "Error ERR_INVALID_ARG_TYPE"],
    ["ErikaGeheim", "Error"],
    ["ERIKA", "Error ERIKA"],
    ["erika", "Error"],
    ["MEIER_ERIKA", "Error"],
  ])("code %s → %s", (code, out) => {
    const e = new Error("Erika Geheim") as Error & { code: string };
    e.code = code;
    expect(errorForLog(e)).toBe(out);
  });
});
