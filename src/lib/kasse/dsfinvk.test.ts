import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildDsfinvkFiles, buildDsfinvkZip, dateTime, decimal, indexXml, quote, splitCsvLine, TABLES, tableByFile, toCsv } from "./dsfinvk";
import { computeClosing, parseTseRef, type KasseMovement, type KassePayment } from "./model";

const org = { name: 'Praxis "Fußglück"; Berlin', street: "Hauptstr. 1", zip: "10115", city: "Berlin", taxNumber: "11/222/33333", vatId: null };
const reg = { kasseId: "PODOCRM-test", brand: "PodoCRM", model: "Cloud", serial: "S-1", swBrand: "PodoCRM", swVersion: "0.1.0" };
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 6, h, m));
const pay = (id: string, method: KassePayment["method"], amountCents: number, extra: Partial<KassePayment> = {}): KassePayment => ({
  tse: parseTseRef(extra.externalRef ?? null),
  id,
  method,
  amountCents,
  paidAt: at(9, Number(id.slice(-1)) || 0),
  invoiceNumber: `R2026-000${id.slice(-1)}`,
  vatGroups: [{ rate: 0, grossCents: amountCents }],
  voucher: null,
  soldVoucher: null,
  externalRef: null,
  createdBy: { id: "u1", name: "Anna" },
  ...extra,
});

function sample() {
  const payments = [
    pay("p1", "cash", 6500, { externalRef: "tse:SER-1:41:77" }),
    pay("p2", "card", 11900, { vatGroups: [{ rate: 19, grossCents: 5950 }, { rate: 0, grossCents: 5950 }] }),
    pay("p3", "voucher", 3000, { voucher: { code: "G2026-0001", purpose: "multi" } }),
    pay("p4", "transfer", 4000),
    pay("p5", "cash", 5000, { soldVoucher: { code: "G2026-0002", purpose: "multi" } }),
    pay("p6", "cash", -1000, { vatGroups: [{ rate: 7, grossCents: -1000 }] }),
  ];
  const movements: KasseMovement[] = [{ id: "m1", kind: "payout", amountCents: -480, reason: 'Porto "Brief"; Post', occurredAt: at(12), createdBy: { id: "u1", name: "Anna" } }];
  const calc = computeClosing({
    zNumber: 1,
    firstBonNr: 1,
    closedAt: at(17),
    openingCents: 10000,
    openingIsNew: true,
    denominations: { "10000": 2, "200": 1 },
    differenceReason: "Wechselgeld",
    payments,
    movements,
  });
  return { payments, movements, calc };
}

describe("DSFinV-K: Feldformate", () => {
  it("Dezimalkomma ohne Tausendertrennung, negative Beträge", () => {
    expect(decimal(0)).toBe("0,00");
    expect(decimal(5)).toBe("0,05");
    expect(decimal(123456789)).toBe("1234567,89");
    expect(decimal(-50)).toBe("-0,50");
    expect(decimal(-123456)).toBe("-1234,56");
    expect(() => decimal(1.5)).toThrow();
  });
  it("Text in Anführungszeichen, innere verdoppelt, Steuerzeichen entfernt, Länge begrenzt", () => {
    expect(quote('a "b"; c')).toBe('"a ""b""; c"');
    expect(quote("Zeile1\r\nZeile2")).toBe('"Zeile1 Zeile2"');
    expect(quote(null)).toBe('""');
    expect(quote("äöüß€", 3)).toBe('"äöü"');
  });
  it("Zeitpunkte in Ortszeit ohne Millisekunden", () => {
    expect(dateTime(new Date("2026-11-06T09:05:07.123Z"))).toBe("2026-11-06T10:05:07");
    expect(dateTime(new Date("2026-07-01T22:30:00Z"))).toBe("2026-07-02T00:30:00");
  });
  it("CSV-Parser für Tests versteht Anführungszeichen", () => {
    expect(splitCsvLine('"a;b";1,00;"x""y"')).toEqual(["a;b", "1,00", 'x"y']);
  });
  it("toCsv: Kopfzeile, CRLF, unbekannte Spalten werden abgewiesen", () => {
    const t = tableByFile("payment.csv");
    const csv = toCsv(t, [{ Z_KASSE_ID: "K", Z_ERSTELLUNG: "2026-11-06T18:00:00", Z_NR: 1, ZAHLART_TYP: "Bar", ZAHLART_NAME: "Bar", Z_ZAHLART_BETRAG: 1234 }]);
    expect(csv).toBe('Z_KASSE_ID;Z_ERSTELLUNG;Z_NR;ZAHLART_TYP;ZAHLART_NAME;Z_ZAHLART_BETRAG\r\n"K";2026-11-06T18:00:00;1;"Bar";"Bar";12,34\r\n');
    expect(() => toCsv(t, [{ FOO: 1 }])).toThrow(/unbekannte Spalte/);
  });
});

describe("DSFinV-K: Dateien", () => {
  const { calc } = sample();
  const files = buildDsfinvkFiles(org, reg, [{ number: 1, businessDate: "2026-11-06", createdAt: at(17, 5), bons: calc.bons, tseSerials: ["SER-1"] }]);
  const parse = (file: string) => {
    const text = files[file];
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.includes("\n") && !/[^\r]\n/.test(text)).toBe(true);
    const lines = text.slice(0, -2).split("\r\n");
    const header = lines[0].split(";");
    const rows = lines.slice(1).map((l) => {
      const f = splitCsvLine(l);
      return Object.fromEntries(header.map((h, i) => [h, f[i]]));
    });
    return { header, lines, rows };
  };
  const num = (s: string) => Math.round(Number(s.replace(",", ".")) * 100);

  it("enthält alle geforderten Tabellen mit Kopfzeile nach Spezifikation", () => {
    for (const f of [
      "cashpointclosing.csv",
      "cashregister.csv",
      "location.csv",
      "vat.csv",
      "businesscases.csv",
      "payment.csv",
      "transactions.csv",
      "lines.csv",
      "lines_vat.csv",
      "transactions_vat.csv",
      "tse.csv",
      "cash_per_currency.csv",
    ]) {
      expect(files[f], f).toBeDefined();
      expect(parse(f).header).toEqual(tableByFile(f).columns.map((c) => c.name));
    }
    expect(parse("cashpointclosing.csv").header.slice(0, 3)).toEqual(["Z_KASSE_ID", "Z_ERSTELLUNG", "Z_NR"]);
    expect(parse("transactions.csv").header).toContain("BON_ID");
  });

  it("jede Zeile hat genau so viele Felder wie die Kopfzeile", () => {
    for (const t of TABLES) {
      const { header, lines } = parse(t.file);
      for (const l of lines.slice(1)) expect(splitCsvLine(l).length, `${t.file}: ${l}`).toBe(header.length);
    }
  });

  it("Beträge mit Dezimalkomma und zwei Nachkommastellen", () => {
    for (const r of parse("lines_vat.csv").rows) for (const k of ["POS_BRUTTO", "POS_NETTO", "POS_UST"]) expect(r[k]).toMatch(/^-?\d+,\d{2}$/);
    for (const r of parse("payment.csv").rows) expect(r.Z_ZAHLART_BETRAG).toMatch(/^-?\d+,\d{2}$/);
    expect(parse("vat.csv").rows.find((r) => r.UST_SCHLUESSEL === "1")?.UST_SATZ).toBe("19,00");
  });

  it("Summen sind konsistent: Bons = Geschäftsvorfälle = Zahlarten; Bargeld je Währung = Bar", () => {
    const tx = parse("transactions.csv").rows;
    const bons = tx.reduce((s, r) => s + num(r.UMS_BRUTTO), 0);
    const gv = parse("businesscases.csv").rows.reduce((s, r) => s + num(r.Z_UMS_BRUTTO), 0);
    const payRows = parse("payment.csv").rows;
    const payments = payRows.reduce((s, r) => s + num(r.Z_ZAHLART_BETRAG), 0);
    expect(bons).toBe(gv);
    expect(bons).toBe(payments);
    const cash = payRows.filter((r) => r.ZAHLART_TYP === "Bar").reduce((s, r) => s + num(r.Z_ZAHLART_BETRAG), 0);
    expect(num(parse("cash_per_currency.csv").rows[0].ZAHLART_BETRAG_WAEH)).toBe(cash);
    const z = parse("cashpointclosing.csv").rows[0];
    expect(num(z.Z_SE_ZAHLUNGEN)).toBe(payments);
    expect(num(z.Z_SE_BARZAHLUNGEN)).toBe(cash);
    // Bar: Anfangsbestand 100 + 65 + 50 − 10 − 4,80 + Differenz → gezählt 202,00
    expect(cash).toBe(20200);
    // Positionen je Bon = Bonkopf; USt je Bon = Positionen
    const lv = parse("lines_vat.csv").rows;
    const tv = parse("transactions_vat.csv").rows;
    for (const r of tx) {
      const sumLines = lv.filter((l) => l.BON_ID === r.BON_ID).reduce((s, l) => s + num(l.POS_BRUTTO), 0);
      const sumVat = tv.filter((l) => l.BON_ID === r.BON_ID).reduce((s, l) => s + num(l.BON_BRUTTO), 0);
      expect(sumLines, r.BON_ID).toBe(num(r.UMS_BRUTTO));
      expect(sumVat, r.BON_ID).toBe(num(r.UMS_BRUTTO));
    }
    for (const l of lv) expect(num(l.POS_NETTO) + num(l.POS_UST)).toBe(num(l.POS_BRUTTO));
  });

  it("Belegnummern fortlaufend, Überweisung nicht als Kassenvorgang, Start/Ende-ID im Abschluss", () => {
    const tx = parse("transactions.csv").rows;
    expect(tx.map((r) => Number(r.BON_NR))).toEqual(tx.map((_, i) => i + 1));
    expect(tx.some((r) => r.BON_ID === "p4")).toBe(false);
    expect(tx[0].BON_ID).toBe("Z1-AB");
    expect(tx[tx.length - 1].BON_ID).toBe("Z1-DIFF");
    const z = parse("cashpointclosing.csv").rows[0];
    expect(z.Z_START_ID).toBe("Z1-AB");
    expect(z.Z_ENDE_ID).toBe("Z1-DIFF");
    expect(z.Z_BUCHUNGSTAG).toBe("2026-11-06");
    expect(z.NAME).toBe('Praxis "Fußglück"; Berlin');
  });

  it("Gutscheine, Kassenbuch und TSE werden abgebildet", () => {
    const lines = parse("lines.csv").rows;
    expect(lines.filter((l) => l.BON_ID === "p3").map((l) => l.GV_TYP)).toEqual(["Umsatz", "MehrzweckgutscheinEinloesung"]);
    expect(lines.find((l) => l.BON_ID === "p5")?.GV_TYP).toBe("MehrzweckgutscheinKauf");
    expect(lines.find((l) => l.BON_ID === "m1")?.GV_TYP).toBe("Auszahlung");
    expect(parse("datapayment.csv").rows.some((r) => r.BON_ID === "p3")).toBe(false);
    const tse = parse("transactions_tse.csv").rows;
    expect(tse).toHaveLength(1);
    expect(tse[0]).toMatchObject({ BON_ID: "p1", TSE_TANR: "41", TSE_TA_SIGZ: "77", TSE_ID: "1" });
    expect(parse("tse.csv").rows[0].TSE_SERIAL).toBe("SER-1");
    expect(parse("references.csv").rows.find((r) => r.BON_ID === "p1")?.REF_NAME).toBe("R2026-0001");
    expect(parse("transactions.csv").rows.find((r) => r.BON_ID === "m1")?.BON_NOTIZ).toBe('Porto "Brief"; Post');
  });

  it("index.xml beschreibt jede Tabelle (GDPdU, UTF-8, Semikolon, Dezimalkomma, Kopfzeile überspringen)", () => {
    const xml = indexXml({ supplier: "A & B", location: "Berlin", from: "2026-11-01", to: "2026-11-30" });
    expect(xml).toContain('<!DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004.dtd">');
    expect(xml).toContain("<Name>A &amp; B</Name>");
    for (const t of TABLES) expect(xml).toContain(`<URL>${t.file}</URL>`);
    expect((xml.match(/<Table>/g) ?? []).length).toBe(TABLES.length);
    expect((xml.match(/<UTF8\/>/g) ?? []).length).toBe(TABLES.length);
    expect(xml).toContain("<ColumnDelimiter>;</ColumnDelimiter>");
    expect(xml).toContain("<DecimalSymbol>,</DecimalSymbol>");
    expect(xml).toContain("<Range><From>2</From></Range>");
    // jede Spalte genau einmal je Tabelle beschrieben
    for (const t of TABLES) {
      const block = xml.slice(xml.indexOf(`<URL>${t.file}</URL>`)).split("</Table>")[0];
      for (const c of t.columns) expect(block, `${t.file}:${c.name}`).toContain(`<Name>${c.name}</Name>`);
    }
  });

  it("ZIP enthält CSV-Dateien und index.xml", async () => {
    const bytes = await buildDsfinvkZip(org, reg, [{ number: 1, businessDate: "2026-11-06", createdAt: at(17, 5), bons: calc.bons, tseSerials: [] }], { from: "2026-11-06", to: "2026-11-06" });
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files);
    expect(names).toContain("index.xml");
    for (const t of TABLES) expect(names).toContain(t.file);
    expect(await zip.file("vat.csv")!.async("string")).toMatch(/^Z_KASSE_ID;/);
  });
});
