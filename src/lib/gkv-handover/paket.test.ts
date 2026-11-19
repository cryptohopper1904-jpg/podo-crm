/**
 * Neutrales Übergabepaket (GKV Paket E): Behandlungen-CSV, JSON, Prüfsummen, Deckblatt – erfundene Daten.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { deckblattPdf } from "./deckblatt-pdf";
import { BEHANDLUNGEN_KOPF, PAKET_SCHEMA, behandlungenZeilen, csvBytes, kassenanteil, paketJson, pruefsummenDatei, sichererName, verordnungZusatz, type PaketMeta, type PaketVerordnung } from "./paket";

const vo = (o: Partial<PaketVerordnung> = {}): PaketVerordnung => ({
  id: "11111111-1111-4111-8111-111111111111",
  status: "billed",
  korrektur: "",
  person: { nummer: 17, nachname: "Musterfrau", vorname: "Erika", geburtsdatum: "1950-03-01", strasse: "Teststr. 1", plz: "12345", ort: "Musterstadt" },
  versicherung: { krankenkasse: "Test-BKK", kassenIk: "109911114", versichertennummer: "A000500015", versichertenstatus: "1" },
  arzt: { name: "Dr. Beispiel", lanr: "123456601", bsnr: "123456789" },
  ausstellungsdatum: "2026-10-01",
  verordnungsart: "03",
  besonderheit: null,
  genehmigung: null,
  diagnose: { gruppe: "DF", icd10: "E11.74", icd10Zweit: null, text: null, leitsymptomatik: "c" },
  heilmittel: null,
  hausbesuch: false,
  dringlich: false,
  unfallfolgen: false,
  bvg: false,
  therapieberichtAngefordert: false,
  einheitenVerordnet: 2,
  positionen: [{ nummer: "78020", bezeichnung: "groß", einheiten: 2 }],
  behandlungen: [
    { datum: "2026-10-05", unterschrift: "geraet", nachgetragen: false },
    { datum: "2026-10-19", unterschrift: "papier", nachgetragen: true },
  ],
  leistungen: [
    { datum: "2026-10-05", position: "78020", bezeichnung: "groß", einheiten: 1, einzelpreisCent: 4500, zuzahlungCent: 450, befreit: false, minderjaehrig: false, preisstand: "2025-07" },
    { datum: "2026-10-19", position: "78020", bezeichnung: "groß", einheiten: 1, einzelpreisCent: 4500, zuzahlungCent: 450, befreit: false, minderjaehrig: false, preisstand: "2025-07" },
  ],
  heilmittelkostenCent: 9000,
  zuzahlungCent: 1900,
  zuzahlungProzentCent: 900,
  verordnungsblattgebuehrCent: 1000,
  zuzahlungsbefreit: "nein",
  zuzahlungsfreiAngekreuzt: false,
  zuzahlungErhaltenAm: "2026-10-05",
  abbruchvermerk: null,
  regelwerk: "podo-2026-11",
  therapiebericht: null,
  dokumente: { leistungsnachweis: "dokumente/leistungsnachweis/x.pdf", therapiebericht: null },
  ...o,
});
const meta: PaketMeta = {
  erzeugt: "2026-11-19T08:00:00.000Z",
  praxis: { name: "Testpraxis", ik: "109911114", leistungserbringergruppe: "7100000", strasse: "Weg 2", plz: "12345", ort: "Musterstadt" },
  lauf: { id: "33333333-3333-4333-8333-333333333333", erstellt: "2026-11-18T10:00:00.000Z", frueherUebergeben: null, abrechnungszentrum: "anderes", notiz: null, anzahl: 1, heilmittelkostenCent: 9000, zuzahlungCent: 1900 },
};

describe("Übergabepaket – Inhalte", () => {
  it("Behandlungen: je Tag und Position, Beträge mit Komma, Unterschrift je Tag", () => {
    const rows = behandlungenZeilen(meta.lauf.id, [vo()]);
    expect(rows[0]).toEqual([...BEHANDLUNGEN_KOPF]);
    expect(rows[1]).toEqual([meta.lauf.id, vo().id, "A000500015", "2026-10-01", "2026-10-05", "78020", "groß", 1, "45,00", "45,00", "4,50", "nein", "nein", "2025-07", "elektronisch"]);
    expect(rows[2].at(-1)).toBe("Papier (nachgetragen)");
  });

  it("Zusatzspalten der Verordnungen-CSV: Status, Kassenanteil, Zuzahlungsanteile, fehlende Unterschriften", () => {
    const fehlt = vo({ status: "correction_needed", behandlungen: [{ datum: "2026-10-05", unterschrift: "fehlt", nachgetragen: false }] });
    expect(verordnungZusatz(fehlt)).toEqual(["Korrektur nötig", 17, "71,00", "9,00", "10,00", "", 1, "dokumente/leistungsnachweis/x.pdf", ""]);
    expect(kassenanteil(vo({ heilmittelkostenCent: null }))).toBeNull();
  });

  it("CSV: UTF-8 mit BOM, Semikolon, CRLF, Formel-Injection entschärft", () => {
    const b = csvBytes([["Name", "Wert"], ["=SUMME(A1)", "-12,50"], ["@x", "+1"]]);
    expect([...b.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(b.toString("utf8").slice(1)).toBe("Name;Wert\r\n'=SUMME(A1);-12,50\r\n'@x;'+1\r\n");
  });

  it("JSON: Schema-Version, Cent-Beträge, Summen", () => {
    const j = paketJson(meta, [vo()]);
    expect(j.schema).toBe(PAKET_SCHEMA);
    expect(j.summen_verordnungen).toEqual({ anzahl: 1, heilmittelkosten_cent: 9000, zuzahlung_cent: 1900, kassenanteil_cent: 7100 });
    expect(j.verordnungen[0].leistungen[0]).toMatchObject({ einzelpreis_cent: 4500, betrag_cent: 4500, zuzahlung_cent: 450 });
    expect(j.verordnungen[0].einheiten_erbracht).toBe(2);
    expect(JSON.parse(JSON.stringify(j))).toEqual(j);
  });

  it("Prüfsummen im sha256sum-Format, sortiert; sichere Dateinamen", () => {
    const a = Buffer.from("a");
    const t = pruefsummenDatei([{ name: "b.csv", bytes: Buffer.from("b") }, { name: "a.csv", bytes: a }]);
    expect(t).toBe(`${createHash("sha256").update(a).digest("hex")}  a.csv\n${createHash("sha256").update("b").digest("hex")}  b.csv\n`);
    expect(sichererName("../x y/ä.pdf")).toBe(".._x_y__.pdf");
  });

  it("Deckblatt-PDF: lesbar, mehrseitig bei vielen Verordnungen", async () => {
    const bytes = await deckblattPdf(meta, Array.from({ length: 60 }, () => vo()));
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    expect(pdf.getTitle()).toMatch(/Begleitzettel/);
  });
});
