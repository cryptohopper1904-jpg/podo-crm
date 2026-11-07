import ExcelJS from "exceljs";
import { getTableName, type Table } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Tx } from "@/db";
import { parsePayment, parseWorkbook } from "./parse";
import { persistImport } from "./persist";

/** Synthetische Arbeitsmappe im Format „Podologie Rechnungsmanager V0.9.2“ – nur erfundene Daten. */
export async function buildWorkbook(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();

  const p = wb.addWorksheet("Patienten");
  p.addRow(["ID", "Anrede", "Titel", "Nachname", "Vorname", "Straße", "PLZ", "Ort", "Route", "Geburtsdatum", "Mobil", "Festznetz", "E-Mail", "bev. Kanal", "Hinweis", "offener Betrag", "Umsatz", "Behandlungen", "letzte Behandung", "Status"]);
  // Zeile 2: ID als Formel OHNE gecachtes Ergebnis, Ort als Formel MIT Ergebnis
  p.addRow([
    { formula: "ROW()-1" },
    "Frau",
    null,
    "Beispiel",
    "Erika",
    "Musterweg 1",
    1234,
    { formula: "VLOOKUP(G2,PLZ!A:B,2,FALSE)", result: "Musterstadt" },
    "Tour A",
    new Date(Date.UTC(1950, 1, 1)),
    "0171 1234567",
    "030 1234567",
    "Erika@Example.org",
    "WhatsApp",
    "Diabetikerin",
    { formula: "SUMIFS(...)", result: 0 },
    { formula: "SUMIFS(...)", result: 130 },
    2,
    new Date(Date.UTC(2026, 2, 2)),
    "aktiv",
  ]);
  p.addRow([{ formula: "ROW()-1", result: 2 }, "Herr", "Dr.", "Mustermann", "Max", "Probeweg 2", "12345", "Musterstadt", null, "15.06.1960", 1601234567, null, null, "E-Mail", null, 0, 65, 1, null, "inaktiv"]);
  p.addRow([]); // Leerzeile
  p.addRow([{ formula: "ROW()-1" }]); // nur ID-Formel → leer
  // Duplikat: gleicher Name + Geburtsdatum wie Zeile 2
  p.addRow([5, "Frau", null, "Beispiel", "Erika", null, null, null, null, "01.02.1950", null, null, null, "Telefon", null, null, null, null, null, null]);
  p.addRow([6, "Fräulein", null, null, "OhneNachname", null, null, null, null, null, null, null, null, "Brieftaube", null, null, null, null, null, null]);

  const l = wb.addWorksheet("Leistungen");
  l.addRow(["ID", "Code", "Bezeichnung", "Preis", "Steuer", "Dauer"]);
  l.addRow([1, "PK", "Podologische Komplexbehandlung", 65, 0, 40]);
  l.addRow([2, "NS", "Nagelspange", 30, "19%", "0:20"]);
  l.addRow([3, "FP", "Fußpflege kosmetisch", "35,00 €", 0.19, null]);

  const g = wb.addWorksheet("Gutscheine");
  g.addRow(["ID", "Gutscheinnummer", "Datum", "Gültig bis", "Betrag", "Restbetrag", "Hinweis"]);
  g.addRow([1, "G2026-0007", new Date(Date.UTC(2026, 0, 5)), null, 50, { formula: "E2-SUMIFS(...)", result: 30 }, "Weihnachten"]);

  const r = wb.addWorksheet("Rechnungen");
  const head = ["ID", "Rechnungsnummer", "Datum", "Typ", "SR-ID", "Patienten-ID", "Nachname", "Vorname", "Bezahlung", "GS-ID", "A-B", "A-EC", "A-Ü", "A-GS", "Summe", "Summe SR"];
  for (let n = 1; n <= 10; n++) head.push(`L${n}`, `A${n}`, `F${n}`);
  head.push("Status Quittung", "Status SR");
  r.addRow(head);
  const line = (codes: [string, number, number][]) => {
    const cells: (string | number | null)[] = [];
    for (let n = 0; n < 10; n++) cells.push(...(codes[n] ?? [null, null, null]));
    return cells;
  };
  // 1: Bar bezahlt
  r.addRow([1, "R2026-0001", new Date(Date.UTC(2026, 2, 2)), "R", null, 1, "Beispiel", "Erika", "Bar (bezahlt)", null, null, null, null, null, 65, null, ...line([["PK", 1, 1]]), null, null]);
  // 2: Gemischt: 20 bar + 25 EC + 20 Gutschein (=65 PK) + NS 30 → Summe 95, offen 30
  r.addRow([2, "Q2026-0002", new Date(Date.UTC(2026, 2, 9)), "Q", null, 1, "Beispiel", "Erika", "Gemischt", 1, 20, 25, null, 20, 95, null, ...line([["PK", 1, 1], ["NS", 1, 1]]), "gedruckt", null]);
  // 3: offen, Patient 2
  r.addRow([3, "R2026-0003", new Date(Date.UTC(2026, 2, 10)), "R", null, 2, "Mustermann", "Max", "Überweisung (offen)", null, null, null, null, null, { formula: "SUM(...)", result: 65 }, null, ...line([["PK", 1, 1]]), null, null]);
  // 4+5: Teile einer Sammelrechnung 6
  r.addRow([4, "R2026-0004", new Date(Date.UTC(2026, 3, 1)), "R", 6, 2, "Mustermann", "Max", null, null, null, null, null, null, 65, null, ...line([["PK", 1, 1]]), null, "in SR"]);
  r.addRow([5, "R2026-0005", new Date(Date.UTC(2026, 3, 8)), "R", 6, 2, "Mustermann", "Max", null, null, null, null, null, null, 65, null, ...line([["PK", 1, 1]]), null, "in SR"]);
  r.addRow([6, "SR2026-0001", new Date(Date.UTC(2026, 3, 30)), "SR", null, 2, "Mustermann", "Max", "Überweisung (bezahlt)", null, null, null, null, null, null, 130, ...line([]), null, "bezahlt"]);
  r.addRow([]);

  const k = wb.addWorksheet("Kalkulation");
  k.addRow(["Fixkosten Kategorie", "Betrag", "Intervall", "Anteil mtl.", "Startdatum"]);
  k.addRow(["Miete", 900, "monatlich", 900, new Date(Date.UTC(2025, 0, 1))]);
  k.addRow(["Versicherung", 300, "quartalsweise", 100, null]);
  k.addRow(["Kammerbeitrag", 240, "jährlich", 20, new Date(Date.UTC(2025, 0, 1))]);
  k.addRow(["Summe", 1440, null, 1020, null]);

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}

describe("parseWorkbook", () => {
  it("liest alle Blätter und erstellt Bericht", async () => {
    const res = await parseWorkbook(await buildWorkbook(), { today: "2026-11-07" });
    const { report } = res;

    // Patienten
    expect(res.patients).toHaveLength(3);
    const erika = res.patients[0];
    expect(erika).toMatchObject({
      legacyId: 1, // =ROW()-1 nachgerechnet
      salutation: "Frau",
      lastName: "Beispiel",
      zip: "01234",
      city: "Musterstadt", // Formel-Ergebnis
      route: "Tour A",
      birthDate: "1950-02-01",
      email: "erika@example.org",
      preferredChannel: "whatsapp",
    });
    expect(erika.legacy.revenueCents).toBe(13000);
    const max = res.patients[1];
    expect(max).toMatchObject({ legacyId: 2, title: "Dr.", birthDate: "1960-06-15", phoneMobile: "01601234567", preferredChannel: "email" });
    expect(report.counts.Patienten).toMatchObject({ imported: 3, skippedEmpty: 2, skippedInvalid: 1 });
    expect(report.duplicates).toEqual([expect.objectContaining({ reason: "name_birthdate", rows: [2, 6], legacyIds: [1, 5] })]);
    expect(report.warnings.some((w) => w.sheet === "Patienten" && w.row === 7 && /Nachname fehlt/.test(w.message))).toBe(true);

    // Leistungen
    expect(res.services.map((s) => [s.code, s.priceCents, s.vatRate, s.durationMin])).toEqual([
      ["PK", 6500, 0, 40],
      ["NS", 3000, 19, 20],
      ["FP", 3500, 19, 30],
    ]);

    // Gutscheine
    expect(res.vouchers[0]).toMatchObject({ code: "G2026-0007", issuedAt: "2026-01-05", validUntil: "2029-12-31", amountCents: 5000, remainingCents: 3000 });

    // Rechnungen
    expect(res.invoices.map((i) => i.number)).toEqual(["R2026-0001", "Q2026-0002", "R2026-0003", "SR2026-0001"]);
    const [inv1, mixed, open, sr] = res.invoices;
    expect(inv1).toMatchObject({ kind: "invoice", status: "paid", totalCents: 6500, vatCents: 0, payments: [{ method: "cash", amountCents: 6500 }] });
    expect(mixed.kind).toBe("receipt");
    expect(mixed.payments).toEqual([
      { method: "cash", amountCents: 2000 },
      { method: "card", amountCents: 2500 },
      { method: "voucher", amountCents: 2000, voucherLegacyId: 1 },
    ]);
    expect(mixed.status).toBe("partially_paid");
    expect(mixed.vatCents).toBe(479); // 30 € brutto mit 19 %
    expect(mixed.netCents).toBe(9500 - 479);
    expect(open).toMatchObject({ status: "issued", payments: [], totalCents: 6500 });
    expect(sr).toMatchObject({ kind: "collective", totalCents: 13000, status: "paid", collectedLegacyIds: [4, 5] });
    expect(sr.lines).toHaveLength(2);
    expect(sr.payments).toEqual([{ method: "transfer", amountCents: 13000 }]);
    expect(report.collectiveParts).toBe(2);

    // Fixkosten
    expect(res.fixedCosts.map((f) => [f.category, f.interval, f.monthlyShareCents, f.startDate])).toEqual([
      ["Miete", "monthly", 90000, "2025-01-01"],
      ["Versicherung", "quarterly", 10000, "2026-01-01"],
      ["Kammerbeitrag", "yearly", 2000, "2025-01-01"],
    ]);
    expect(report.skippedEmptyRows).toBe(3);
  });

  it("meldet unlesbare Dateien statt zu werfen", async () => {
    const res = await parseWorkbook(new Uint8Array([1, 2, 3]));
    expect(res.patients).toEqual([]);
    expect(res.report.warnings[0].sheet).toBe("Arbeitsmappe");
  });

  it("parsePayment: Gutschein und unklare Angaben", () => {
    const none = { cash: null, card: null, transfer: null, voucher: null };
    expect(parsePayment("Gutschein", 5000, none, 3).payments).toEqual([{ method: "voucher", amountCents: 5000, voucherLegacyId: 3 }]);
    expect(parsePayment("EC (bezahlt)", 6500, none, null).payments).toEqual([{ method: "card", amountCents: 6500 }]);
    expect(parsePayment("Bar (offen)", 6500, none, null).payments).toEqual([]);
    expect(parsePayment("Bitcoin", 6500, none, null).warnings[0]).toMatch(/Unbekannte/);
  });
});

// ───────────── Fake-Transaktion für persistImport ─────────────
type Op = { kind: "insert" | "update" | "select"; table: string; values?: unknown; set?: unknown };

function fakeTx() {
  const ops: Op[] = [];
  let seq = 0;
  const thenable = <T>(value: () => T) => ({
    then: (res: (v: T) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve().then(value).then(res, rej),
  });
  const tx = {
    execute: async () => ({ rows: [] }),
    select: () => ({
      from: (table: Table) => ({
        where: () => {
          ops.push({ kind: "select", table: getTableName(table) });
          return thenable(() => [] as unknown[]);
        },
      }),
    }),
    insert: (table: Table) => ({
      values: (input: Record<string, unknown>[] | Record<string, unknown>) => {
        const name = getTableName(table);
        ops.push({ kind: "insert", table: name, values: input });
        const values = Array.isArray(input) ? input : [input];
        const rows = () => values.map((v) => ({ id: `${name}-${++seq}`, number: v.number, code: v.code }));
        const ret = { returning: () => thenable(rows) };
        return { ...thenable(() => undefined), ...ret, onConflictDoUpdate: () => ret };
      },
    }),
    update: (table: Table) => ({
      set: (set: unknown) => ({
        where: () => {
          ops.push({ kind: "update", table: getTableName(table), set });
          return thenable(() => undefined);
        },
      }),
    }),
  };
  return { tx: tx as unknown as Tx, ops };
}

describe("persistImport", () => {
  it("legt Rechnungen als Entwurf an, fügt Positionen ein und setzt danach den Status", async () => {
    const res = await parseWorkbook(await buildWorkbook(), { today: "2026-11-07" });
    const { tx, ops } = fakeTx();
    const sum = await persistImport(tx, "org-1", res, "user-1");

    expect(sum).toMatchObject({ patients: 3, services: 3, vouchers: 1, fixedCosts: 3, invoices: 4, invoiceLines: 6, payments: 5 });
    // Patientennummern = Legacy-IDs
    const patientInsert = ops.find((o) => o.kind === "insert" && o.table === "patients")!;
    expect((patientInsert.values as { number: number }[]).map((p) => p.number)).toEqual([1, 2, 5]);
    expect(Object.keys(sum.patientIdByLegacyId)).toEqual(["1", "2", "5"]);

    const idx = (pred: (o: Op) => boolean) => ops.findIndex(pred);
    const invInsert = idx((o) => o.kind === "insert" && o.table === "invoices");
    const lineInsert = idx((o) => o.kind === "insert" && o.table === "invoice_lines");
    const firstUpdate = idx((o) => o.kind === "update" && o.table === "invoices");
    expect(invInsert).toBeLessThan(lineInsert);
    expect(lineInsert).toBeLessThan(firstUpdate);
    expect((ops[invInsert].values as { status: string }[]).every((v) => v.status === "draft")).toBe(true);
    const statuses = ops.filter((o) => o.kind === "update").map((o) => (o.set as { status: string }).status);
    expect(statuses).toEqual(["paid", "partially_paid", "issued", "paid"]);

    const pay = ops.find((o) => o.kind === "insert" && o.table === "payments")!.values as { method: string; voucherId: string | null }[];
    expect(pay.find((p) => p.method === "voucher")?.voucherId).toMatch(/^vouchers-/);
    const seq = ops.filter((o) => o.kind === "insert" && o.table === "number_sequences").map((o) => o.values);
    expect(seq).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "invoice", year: 2026, next: 6 }),
        expect.objectContaining({ key: "receipt", year: 2026, next: 3 }),
        expect.objectContaining({ key: "collective", year: 2026, next: 2 }),
        expect.objectContaining({ key: "voucher", year: 2026, next: 8 }),
      ]),
    );
    const pIns = patientInsert.values as { route: string | null; externalIds: unknown }[];
    expect(pIns[0]).toMatchObject({ route: "Tour A", externalIds: { legacyExcel: 1 } });
    const vIns = ops.find((o) => o.kind === "insert" && o.table === "vouchers")!.values as { openingRedeemedCents: number }[];
    expect(vIns[0].openingRedeemedCents).toBe(2000);
    expect((ops[invInsert].values as { source: string }[]).every((v) => v.source === "excel-import")).toBe(true);
    expect(ops.every((o) => o.kind !== "insert" || [o.values].flat().every((v) => (v as { organizationId: string }).organizationId === "org-1"))).toBe(true);
  });
});
