import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  DEFAULT_DUNNING_SETTINGS,
  DEFAULT_DUNNING_TEXT,
  daysBetween,
  dunningState,
  fillTemplate,
  isDunnable,
  readDunningSettings,
  salutationLine,
} from "./dunning";
import { renderDunningPdf, dunningPdfFilename, type DunningPdfData } from "./dunning-pdf";

const S = DEFAULT_DUNNING_SETTINGS;
const inv = (p: Partial<{ kind: string; status: string; dueAt: string | null; totalCents: number; paidCents: number }> = {}) => ({
  kind: "invoice",
  status: "issued",
  dueAt: "2026-11-01",
  totalCents: 6500,
  paidCents: 0,
  ...p,
});

describe("Mahnwesen: Einstellungen", () => {
  it("Standardwerte 7 / 14 / 14 Tage, Gebühren 0 €", () => {
    const s = readDunningSettings({});
    expect([s.stages.reminder.days, s.stages.dunning1.days, s.stages.dunning2.days]).toEqual([7, 14, 14]);
    expect([s.stages.reminder.feeCents, s.stages.dunning1.feeCents, s.stages.dunning2.feeCents]).toEqual([0, 0, 0]);
    expect(s.stages.dunning2.text).toBe(DEFAULT_DUNNING_TEXT.dunning2);
  });

  it("ungültige Werte fallen auf Standard zurück; Gebühren vorerst überall 0 €", () => {
    const s = readDunningSettings({
      dunning: { payDays: 0, stages: { reminder: { days: 3, feeCents: 500, text: "Hallo {anrede}" }, dunning1: { days: -1, feeCents: 99999 }, dunning2: { days: 21, feeCents: 250, text: " " } } },
    });
    expect(s.payDays).toBe(10);
    expect(s.stages.reminder).toEqual({ days: 3, feeCents: 0, text: "Hallo {anrede}" });
    expect(s.stages.dunning1.days).toBe(14);
    expect(s.stages.dunning1.feeCents).toBe(0);
    // Mahngebühren erst mit Buchungsweg (MAX_FEE_CENTS = 0)
    expect(s.stages.dunning2).toMatchObject({ days: 21, feeCents: 0, text: DEFAULT_DUNNING_TEXT.dunning2 });
  });
});

describe("Mahnwesen: Stufenberechnung", () => {
  it("nur Rechnung, Sammelrechnung, Ausfallhonorar – nie Quittung, Anzahlung, Storno, bezahlt, storniert, Entwurf", () => {
    for (const kind of ["invoice", "collective", "no_show_fee"]) expect(isDunnable({ kind, status: "issued" })).toBe(true);
    for (const kind of ["receipt", "deposit", "credit_note"]) expect(dunningState(inv({ kind }), [], S, "2026-12-01").state).toBe("not_dunnable");
    for (const status of ["paid", "cancelled", "draft"]) expect(dunningState(inv({ status }), [], S, "2026-12-01").state).toBe("not_dunnable");
    expect(dunningState(inv({ dueAt: null }), [], S, "2026-12-01").state).toBe("not_dunnable");
    // Teilzahlung bis auf 0 € offen → nichts zu mahnen
    expect(dunningState(inv({ status: "partially_paid", paidCents: 6500 }), [], S, "2026-12-01").state).toBe("not_dunnable");
  });

  it("Zahlungserinnerung 7 Tage nach dem Zahlungsziel", () => {
    expect(dunningState(inv(), [], S, "2026-11-01")).toEqual({ state: "not_overdue", daysOverdue: 0 });
    expect(dunningState(inv(), [], S, "2026-11-07")).toMatchObject({ state: "waiting", next: "reminder", dueOn: "2026-11-08", daysOverdue: 6 });
    expect(dunningState(inv(), [], S, "2026-11-08")).toMatchObject({ state: "due", next: "reminder", daysOverdue: 7, last: null });
    // Teilzahlung: weiterhin mahnbar
    expect(dunningState(inv({ status: "partially_paid", paidCents: 2000 }), [], S, "2026-11-20").state).toBe("due");
  });

  it("weitere Stufen jeweils 14 Tage nach dem vorigen Schreiben, danach erschöpft", () => {
    const r = [{ stage: "reminder", letterDate: "2026-11-10", payBy: "2026-11-20" }];
    expect(dunningState(inv(), r, S, "2026-11-23")).toMatchObject({ state: "waiting", next: "dunning1", dueOn: "2026-11-24", last: "reminder" });
    expect(dunningState(inv(), r, S, "2026-11-24")).toMatchObject({ state: "due", next: "dunning1" });
    const r2 = [...r, { stage: "dunning1", letterDate: "2026-11-30", payBy: "2026-12-10" }];
    expect(dunningState(inv(), r2, S, "2026-12-14")).toMatchObject({ state: "due", next: "dunning2", dueOn: "2026-12-14" });
    const r3 = [...r2, { stage: "dunning2", letterDate: "2026-12-20", payBy: "2026-12-30" }];
    expect(dunningState(inv(), r3, S, "2027-02-01")).toMatchObject({ state: "exhausted", last: "dunning2" });
  });

  it("nächste Stufe nie vor Ablauf der Zahlungsfrist des vorigen Schreibens", () => {
    // Frist im Schreiben (30 Tage) länger als der Abstand der Stufen (14 Tage) → erst am Tag nach der Frist
    const r = [{ stage: "reminder", letterDate: "2026-11-10", payBy: "2026-12-10" }];
    expect(dunningState(inv(), r, S, "2026-11-24")).toMatchObject({ state: "waiting", next: "dunning1", dueOn: "2026-12-11" });
    expect(dunningState(inv(), r, S, "2026-12-10").state).toBe("waiting");
    expect(dunningState(inv(), r, S, "2026-12-11").state).toBe("due");
    // kurze Frist: Abstand der Stufen gilt
    const short = [{ stage: "reminder", letterDate: "2026-11-10", payBy: "2026-11-12" }];
    expect(dunningState(inv(), short, S, "2026-11-23")).toMatchObject({ state: "waiting", dueOn: "2026-11-24" });
  });

  it("über Monats-/Jahresgrenzen und mit eigenen Fristen", () => {
    expect(daysBetween("2026-12-28", "2027-01-04")).toBe(7);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2); // Zeitumstellung
    const custom = readDunningSettings({ dunning: { stages: { reminder: { days: 3 }, dunning1: { days: 10 }, dunning2: { days: 5 } } } });
    expect(dunningState(inv({ dueAt: "2026-12-30" }), [], custom, "2027-01-02")).toMatchObject({ state: "due", dueOn: "2027-01-02", daysOverdue: 3 });
  });
});

describe("Mahnwesen: Texte", () => {
  it("Anrede nach Person bzw. Rechnungsempfänger", () => {
    expect(salutationLine({ salutation: "Frau", lastName: "Muster", firstName: "Erika" })).toBe("Sehr geehrte Frau Muster");
    expect(salutationLine({ salutation: "Herr", title: "Dr.", lastName: "Beispiel" })).toBe("Sehr geehrter Herr Dr. Beispiel");
    expect(salutationLine({ salutation: null, firstName: "Alex", lastName: "Muster" })).toBe("Guten Tag Alex Muster");
    expect(salutationLine({ lastName: "Muster" }, "Haus Sonnenschein")).toBe("Sehr geehrte Damen und Herren");
  });

  it("Platzhalter ersetzen, unbekannte bleiben stehen", () => {
    expect(fillTemplate("{anrede}, offen {offener_betrag} – {unbekannt}", { anrede: "Hallo", offener_betrag: "65,00 €" })).toBe("Hallo, offen 65,00 € – {unbekannt}");
    expect(fillTemplate("{constructor}", {})).toBe("{constructor}");
  });
});

describe("Mahnung als PDF", () => {
  const data = (patch: Partial<DunningPdfData["dunning"]> = {}): DunningPdfData => ({
    dunning: { id: "d1", stage: "dunning1", letterDate: "2026-11-30", payBy: "2026-12-10", openCents: 4500, feesTotalCents: 250, body: "Sehr geehrte Frau Muster,\n\nleider ist … ✓ offen.", fees: [{ stage: "reminder", feeCents: 0 }, { stage: "dunning1", feeCents: 250 }], ...patch },
    invoice: { number: "R2026-0042", issuedAt: "2026-10-20", dueAt: "2026-11-03", totalCents: 6500 },
    organization: { name: "Praxis Fußwohl", legalName: "Fußwohl Podologie GmbH", street: "Musterweg 1", zip: "14467", city: "Potsdam", phone: "0331 123456", email: "info@example.org", taxNumber: "046/123/45678", vatId: null, iban: "DE02120300000000202051", qualification: "staatlich anerkannte Podologin" },
    patient: { number: 17, salutation: "Frau", firstName: "Erika", lastName: "Muster", street: "Beispielstraße 5", zip: "14469", city: "Potsdam" },
    billingContact: null,
  });

  it("erzeugt ein gültiges einseitiges PDF mit Titel und Dateiname", async () => {
    const bytes = await renderDunningPdf(data());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe("1. Mahnung zur Rechnung R2026-0042");
    expect(dunningPdfFilename({ stage: "dunning2" }, { number: "R2026/0042", id: "x" })).toBe("Mahnung-2_R2026_0042.pdf");
  });

  it("langer Text bricht auf eine weitere Seite um, ohne IBAN kein GiroCode", async () => {
    const bytes = await renderDunningPdf({ ...data({ body: "Text ".repeat(1500), stage: "dunning2" }), organization: { ...data().organization, iban: null } });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
  });
});
