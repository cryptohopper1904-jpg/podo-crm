/**
 * Pododesk-Gesamtexport, Review-Runde 4 (PR #108):
 *  R4-A Termine nur über die mitgeladene patienten.csv zuordnen (termine.csv allein → abgelehnt; Patient-ID nicht in
 *       patienten.csv → nicht zugeordnet, Sammelhinweis).
 *  R4-B Bestandsperson mit derselben Pododesk-ID nur bei gleichem Namen UND gleichem Geburtsdatum automatisch; jeder
 *       unsichere Fall ist eine Entscheidung in der Vorschau mit Standard „nicht verknüpfen“ (Matrix wie praxis3.mts).
 * Unit-Tests ohne Datenbank, ausschließlich erfundene Daten.
 */
import { describe, expect, it } from "vitest";
import { collectFiles } from "./collect";
import { buildPlan, type ExistingPatient, type ExistingSnapshot } from "./plan";
import { PODODESK_HEADERS } from "./pododesk";
import { toPreview } from "./preview-safety";

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
const bestand = (firstName: string, lastName: string, birthDate: string | null, id = "e1", pododesk = "1"): ExistingPatient => ({
  id,
  number: 7,
  firstName,
  lastName,
  birthDate,
  email: null,
  phoneMobile: null,
  externalIds: { pododesk },
});
const termin = (id: string, patient: string) => ({ id, beginn: "2027-03-01T08:00:00.000Z", ende: "2027-03-01T08:30:00.000Z", patient, notizen: "Befund" });
const patientenCsv = (rows: Record<string, string>[]) => ({ name: "patienten.csv", data: enc(csv("patienten", rows)) });
const termineCsv = (rows: Record<string, string>[]) => ({ name: "termine.csv", data: enc(csv("termine", rows)) });

describe("R4-A: Termine nur zusammen mit patienten.csv", () => {
  it("termine.csv ohne patienten.csv → ganze Datei nicht übernommen, Hinweis; keine Zuordnung über Bestands-IDs", async () => {
    const files = await collectFiles([termineCsv([termin("t1", "1")])]);
    expect(files[0].status).toBe("rejected");
    expect(files[0].note).toMatch(/termine\.csv nur zusammen mit patienten\.csv aus demselben Pododesk-Export/);
    const plan = buildPlan(files, empty({ patients: [bestand("Hans", "Meier", "1940-01-01")] }), { prescriptionMode: "billed", now: NOW });
    expect(plan.appointments).toEqual([]);
    expect(plan.hasWork).toBe(false);
  });

  it("patienten.csv abgelehnt (zwei Praxen) → termine.csv ebenfalls abgelehnt", async () => {
    const files = await collectFiles([
      patientenCsv([{ id: "1", vorname: "Erika", nachname: "Muster", geburtsdatum: "1950-01-01" }]),
      { name: "patienten2.csv", data: enc(csv("patienten", [{ id: "1", vorname: "Hans", nachname: "Meier", geburtsdatum: "1940-01-01" }])) },
      termineCsv([termin("t1", "1")]),
    ]);
    expect(files.map((f) => f.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(files[2].note).toMatch(/zusammen mit patienten\.csv/);
  });

  it("Patient-ID nicht in der hochgeladenen patienten.csv → nicht zugeordnet (auch nicht zur Bestandsperson mit dieser ID), Sammelhinweis mit Anzahl", async () => {
    // praxis5.mts: Bestand Nr. 7 trägt Pododesk-ID 1, patienten.csv enthält nur ID 2
    const files = await collectFiles([patientenCsv([{ id: "2", vorname: "Erika", nachname: "Muster", geburtsdatum: "1950-01-01" }]), termineCsv([termin("t1", "1"), termin("t2", "1"), termin("t3", "2")])]);
    const plan = buildPlan(files, empty({ patients: [bestand("Hans", "Meier", "1940-01-01")] }), { prescriptionMode: "billed", now: NOW });
    expect(plan.appointments.map((a) => [a.externalId, a.patient])).toEqual([["pododesk:t3", { ref: "pododesk:2" }]]);
    expect(plan.totals.appointmentsUnassigned).toBe(2);
    const w = warningsOf(plan);
    expect(w).toMatch(/2 Termine verweisen auf Patient:innen, die nicht in der hochgeladenen patienten\.csv stehen – nicht übernommen/);
    // Sammelhinweis statt einer Meldung je Termin
    expect(w.match(/patienten\.csv stehen/g)).toHaveLength(1);
  });
});

/** Upload: Person mit Pododesk-ID 1 und ein künftiger Termin t1 (wie praxis3.mts) */
async function planFor(existing: ExistingPatient, upload: { vorname: string; nachname: string; geburtsdatum: string }, over: Partial<ExistingSnapshot> = {}, choices?: Record<string, string>) {
  const files = await collectFiles([patientenCsv([{ id: "1", ...upload }]), termineCsv([termin("t1", "1")])]);
  return buildPlan(files, empty({ patients: [existing], ...over }), { prescriptionMode: "billed", now: NOW, choices });
}

describe("R4-B: Pododesk-ID im Bestand – automatisch nur bei gleichem Namen UND gleichem Geburtsdatum", () => {
  const NAMES = [
    { fn: "Hans", ln: "Meier" },
    { fn: "Erika", ln: "Muster" },
  ] as const;
  const BD = [null, "1950-01-01", "1940-02-02"] as const;
  const cases = NAMES.flatMap((up) => BD.flatMap((eb) => BD.map((ub) => ({ up, eb, ub }))));

  it.each(cases)("Bestand Hans Meier/$eb, Upload $up.fn $up.ln/$ub", async ({ up, eb, ub }) => {
    const sure = up.fn === "Hans" && eb !== null && eb === ub;
    const plan = await planFor(bestand("Hans", "Meier", eb), { vorname: up.fn, nachname: up.ln, geburtsdatum: ub ?? "" });
    expect(plan.patientsCreate).toEqual([]);
    expect(plan.patientsLink).toEqual([]);
    if (sure) {
      expect(plan.decisions).toEqual([]);
      expect(plan.totals.patientsExisting).toBe(1);
      expect(plan.appointments.map((a) => a.patient)).toEqual([{ existingId: "e1" }]);
      return;
    }
    // unsicher: Entscheidung, Standard „nicht verknüpfen“ → weder Person noch Termin übernommen
    expect(plan.decisions).toHaveLength(1);
    expect(plan.decisions[0]).toMatchObject({ key: "pododesk:1", defaultChoice: "new", choice: "new", sourceLabel: "Pododesk" });
    expect(plan.decisions[0].candidates).toEqual([expect.objectContaining({ id: "e1", number: 7, reason: expect.stringMatching(/^gleiche Pododesk-ID/) })]);
    expect(plan.decisions[0].newLabel).toMatch(/nicht verknüpfen/);
    expect(plan.totals.patientsExisting).toBe(0);
    expect(plan.appointments).toEqual([]);
    expect(plan.totals.appointmentsUnassigned).toBe(1);
    expect(warningsOf(plan)).toMatch(/Pododesk-ID 1: Nr\. 7 im Bestand ist nicht sicher dieselbe Person .* nicht verknüpft/);
    expect(warningsOf(plan)).toMatch(/1 Termin gehört zu Pododesk-IDs, deren Bestandsperson nicht sicher dieselbe ist – nicht übernommen/);

    // Auswahl „verknüpfen mit Nr. 7“ → Termin wird der Bestandsperson zugeordnet, nichts neu angelegt
    const linked = await planFor(bestand("Hans", "Meier", eb), { vorname: up.fn, nachname: up.ln, geburtsdatum: ub ?? "" }, {}, { "pododesk:1": "e1" });
    expect(linked.decisions[0]).toMatchObject({ defaultChoice: "new", choice: "e1" });
    expect(linked.appointments.map((a) => a.patient)).toEqual([{ existingId: "e1" }]);
    expect(linked.totals.patientsExisting).toBe(1);
    expect(linked.patientsCreate).toEqual([]);
    expect(linked.patientsLink).toEqual([]);
    expect(linked.conflicts).toEqual([]);
  });

  it("Termin-ID schon im Bestand: nach „verknüpfen“ bereits übernommen bzw. Kollision mit anderer Person (R3-2 bleibt)", async () => {
    const up = { vorname: "Erika", nachname: "Muster", geburtsdatum: "1950-01-01" };
    const own = await planFor(bestand("Hans", "Meier", "1950-01-01"), up, { appointmentRefs: new Set(["pododesk:t1"]), appointmentPatients: new Map([["pododesk:t1", "e1"]]) }, { "pododesk:1": "e1" });
    expect(own.totals).toMatchObject({ appointmentsExisting: 1, appointmentsUnassigned: 0 });
    const other = await planFor(bestand("Hans", "Meier", "1950-01-01"), up, { appointmentRefs: new Set(["pododesk:t1"]), appointmentPatients: new Map([["pododesk:t1", "e2"]]) }, { "pododesk:1": "e1" });
    expect(other.totals).toMatchObject({ appointmentsExisting: 0, appointmentsUnassigned: 1 });
    expect(warningsOf(other)).toMatch(/kollidiert mit einem bereits übernommenen Termin einer anderen Person/);
    // ohne Auswahl: nicht übernommen, auch nicht als „bereits übernommen“ gezählt
    const dflt = await planFor(bestand("Hans", "Meier", "1950-01-01"), up, { appointmentRefs: new Set(["pododesk:t1"]), appointmentPatients: new Map([["pododesk:t1", "e1"]]) });
    expect(dflt.totals).toMatchObject({ appointmentsExisting: 0, appointmentsUnassigned: 1 });
  });

  it("praxis4.mts: Groß-/Kleinschreibung und Leerzeichen gleich, Geburtsdatum fehlt → Entscheidung statt still verknüpft", async () => {
    const plan = await planFor(bestand("Maria", "Müller", null), { vorname: "maria", nachname: "MÜLLER ", geburtsdatum: "" });
    expect(plan.decisions[0]?.candidates[0].reason).toBe("gleiche Pododesk-ID, gleicher Name, Geburtsdatum fehlt");
    expect(plan.appointments).toEqual([]);
    const marriage = await planFor(bestand("Hans", "Meier", "1950-01-01"), { vorname: "Erika", nachname: "Muster", geburtsdatum: "1950-01-01" });
    expect(marriage.decisions[0]?.candidates[0].reason).toBe("gleiche Pododesk-ID, anderer Name, gleiches Geburtsdatum");
  });

  it("ungültige Auswahl (andere Person) fällt auf „nicht verknüpfen“ zurück", async () => {
    const plan = await planFor(bestand("Hans", "Meier", null), { vorname: "Hans", nachname: "Meier", geburtsdatum: "" }, {}, { "pododesk:1": "00000000-0000-0000-0000-000000000000" });
    expect(plan.decisions[0].choice).toBe("new");
    expect(plan.appointments).toEqual([]);
  });

  it("Vorschau zeigt die Auswahl „nicht verknüpfen“ statt „neu anlegen“", async () => {
    const plan = await planFor(bestand("Hans", "Meier", null), { vorname: "Hans", nachname: "Meier", geburtsdatum: "" });
    const p = toPreview(plan);
    expect(p.decisions[0]).toMatchObject({ key: "pododesk:1", defaultChoice: "new", newLabel: expect.stringMatching(/nicht verknüpfen/) });
  });

  it("normaler Wiederholungslauf (gleicher Name + Geburtsdatum, Termin schon übernommen) → nichts Neues, keine Entscheidung", async () => {
    const plan = await planFor(bestand("Erika", "Muster", "1950-01-01"), { vorname: "Erika", nachname: "Muster", geburtsdatum: "1950-01-01" }, { appointmentRefs: new Set(["pododesk:t1"]), appointmentPatients: new Map([["pododesk:t1", "e1"]]) });
    expect(plan.decisions).toEqual([]);
    expect(plan.totals).toMatchObject({ patientsExisting: 1, appointmentsExisting: 1, appointmentsNew: 0, appointmentsUnassigned: 0 });
    expect(plan.hasWork).toBe(false);
  });
});
