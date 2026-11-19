/**
 * Rückmeldung des Abrechnungszentrums (GKV Paket E): strikte Prüfung des neutralen CSV-/JSON-Formats
 * (docs/GKV-ABRECHNUNGSZENTRUM.md). Nur erfundene Daten.
 */
import { describe, expect, it } from "vitest";
import { RUECKMELDUNG_MAX_BYTES, RUECKMELDUNG_MAX_ZEILEN, RUECKMELDUNG_SCHEMA, RUECKMELDUNG_SPALTEN, parseRueckmeldung } from "./rueckmeldung";

const VO1 = "11111111-1111-4111-8111-111111111111";
const VO2 = "22222222-2222-4222-8222-222222222222";
const LAUF = "33333333-3333-4333-8333-333333333333";
const kopf = RUECKMELDUNG_SPALTEN.join(";");
const csv = (...zeilen: string[]) => Buffer.from(`﻿${[kopf, ...zeilen].join("\r\n")}\r\n`, "utf8");

describe("parseRueckmeldung – CSV", () => {
  it("liest Zeilen mit Verordnungs-ID bzw. Versichertennummer + Ausstellungsdatum, Beträge in Cent", () => {
    const r = parseRueckmeldung(
      csv(
        `${VO1};${LAUF};;;123,45;10,00;R12;Unterschrift fehlt;2026-11-10;SR-2026-0815`,
        `;;A000500015;01.10.2026;50;;;;10.11.2026;SR-2026-0815`,
      ),
      "rueckmeldung.csv",
    );
    expect(r.fehler).toEqual([]);
    expect(r.format).toBe("csv");
    expect(r.auszahlungsdatum).toBe("2026-11-10");
    expect(r.sammelrechnungsnummer).toBe("SR-2026-0815");
    expect(r.zeilen).toEqual([
      { zeile: 2, verordnungId: VO1, laufId: LAUF, versichertennummer: null, ausstellungsdatum: null, ausgezahltCent: 12345, gebuehrCent: 0, absetzung: { betragCent: 1000, code: "R12", grund: "Unterschrift fehlt" } },
      { zeile: 3, verordnungId: null, laufId: null, versichertennummer: "A000500015", ausstellungsdatum: "2026-10-01", ausgezahltCent: 5000, gebuehrCent: 0, absetzung: null },
    ]);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("Komma als Trennzeichen (Excel-Export) und Punkt als Dezimaltrenner", () => {
    const text = `${RUECKMELDUNG_SPALTEN.join(",")}\n${VO1},,,,99.5,,,,2026-11-10,SR1\n`;
    const r = parseRueckmeldung(Buffer.from(text), "r.csv");
    expect(r.fehler).toEqual([]);
    expect(r.zeilen[0].ausgezahltCent).toBe(9950);
  });

  it("strikte Prüfung: Kopf, Beträge, Datum, Zuordnung, Grund, Doppelte – je Zeile mit Zeilennummer", () => {
    const r = parseRueckmeldung(
      csv(
        `${VO1};;;;-5,00;;;;2026-11-10;SR1`, // negativ
        `${VO2};;;;1.000,00;;;;2026-11-10;SR1`, // Tausenderpunkt
        `;;;;5;;;;2026-11-10;SR1`, // keine Zuordnung
        `${VO1};;;;5;3;;;2026-11-10;SR1`, // Absetzung ohne Grund (und VO1 doppelt)
        `${VO2};;;;=1+1;;;;2026-11-10;SR1`, // Formel statt Betrag
        `nicht-uuid;;;;5;;;;2026-11-10;SR1`,
        `;;A1;2026-02-30;5;;;;2026-11-10;SR1`, // kein echtes Datum
      ),
      "r.csv",
    );
    expect(r.zeilen).toEqual([]);
    const text = r.fehler.join("\n");
    expect(text).toMatch(/Zeile 2: .*Ausgezahlt EUR/);
    expect(text).toMatch(/Zeile 3: .*Ausgezahlt EUR/);
    expect(text).toMatch(/Zeile 4: .*Verordnung-ID oder Versichertennummer und Ausstellungsdatum/);
    expect(text).toMatch(/Zeile 5: .*Grund/);
    expect(text).toMatch(/Zeile 5: .*mehrfach/);
    expect(text).toMatch(/Zeile 6: .*Ausgezahlt EUR/);
    expect(text).toMatch(/Zeile 7: .*Verordnung-ID/);
    expect(text).toMatch(/Zeile 8: .*Ausstellungsdatum/);
  });

  it("Formel-Zeichen in Textfeldern bleiben Text (keine Auswertung), Steuerzeichen werden entfernt", () => {
    const r = parseRueckmeldung(csv(`${VO1};;;;5;1;=HYPERLINK("x");"@SUMME(A1)\tGrund";2026-11-10;SR1`), "r.csv");
    expect(r.fehler).toEqual([]);
    expect(r.zeilen[0].absetzung).toEqual({ betragCent: 100, code: '=HYPERLINK("x")', grund: "@SUMME(A1) Grund" });
  });

  it("fehlende Pflichtspalten und fremde Spalten werden abgelehnt", () => {
    expect(parseRueckmeldung(Buffer.from("Verordnung-ID;Betrag\nx;1\n"), "r.csv").fehler.join()).toMatch(/Spalte(n)? fehlt|fehlen/);
    expect(parseRueckmeldung(Buffer.from(`${kopf};Extra\n`), "r.csv").fehler.join()).toMatch(/Unbekannte Spalte/);
  });

  it("alle Zeilen einer Datei: gleiche Auszahlung (Datum und Sammelrechnungsnummer)", () => {
    const r = parseRueckmeldung(csv(`${VO1};;;;5;;;;2026-11-10;SR1`, `${VO2};;;;5;;;;2026-11-11;SR1`), "r.csv");
    expect(r.fehler.join()).toMatch(/eine Auszahlung je Datei/);
  });

  it("Grenzen: Dateigröße, Zeilenzahl, leere Datei, kein UTF-8", () => {
    expect(parseRueckmeldung(Buffer.alloc(RUECKMELDUNG_MAX_BYTES + 1, 65), "r.csv").fehler.join()).toMatch(/zu groß/);
    const viele = Array.from({ length: RUECKMELDUNG_MAX_ZEILEN + 1 }, () => `${VO1};;;;1;;;;2026-11-10;SR1`);
    expect(parseRueckmeldung(csv(...viele), "r.csv").fehler.join()).toMatch(/höchstens/);
    expect(parseRueckmeldung(Buffer.from(`${kopf}\n`), "r.csv").fehler.join()).toMatch(/keine Zeilen/);
    expect(parseRueckmeldung(Buffer.from([0xff, 0xfe, 0x00, 0x41]), "r.csv").fehler.join()).toMatch(/UTF-8/);
  });

  it("Auszahlungsdatum in der Zukunft oder unplausibel alt wird abgelehnt", () => {
    expect(parseRueckmeldung(csv(`${VO1};;;;5;;;;2099-01-01;SR1`), "r.csv", "2026-11-19").fehler.join()).toMatch(/Zukunft/);
    expect(parseRueckmeldung(csv(`${VO1};;;;5;;;;1999-01-01;SR1`), "r.csv", "2026-11-19").fehler.join()).toMatch(/Auszahlungsdatum/);
  });
});

describe("parseRueckmeldung – JSON", () => {
  const json = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8");
  it("liest das JSON-Format mit Schema-Version", () => {
    const r = parseRueckmeldung(
      json({
        schema: RUECKMELDUNG_SCHEMA,
        sammelrechnungsnummer: "SR-9",
        auszahlungsdatum: "2026-11-10",
        positionen: [
          { verordnung_id: VO1, lauf_id: LAUF, ausgezahlt_cent: 12345, absetzung: { betrag_cent: 500, code: "A1", grund: "Frist überschritten" } },
          { versichertennummer: "A000500015", ausstellungsdatum: "2026-10-01", ausgezahlt_cent: 0 },
        ],
      }),
      "r.json",
    );
    expect(r.fehler).toEqual([]);
    expect(r.format).toBe("json");
    expect(r.zeilen.map((z) => [z.zeile, z.ausgezahltCent, z.absetzung?.betragCent ?? null])).toEqual([
      [1, 12345, 500],
      [2, 0, null],
    ]);
  });

  it("falsches Schema, Gleitkomma-Cent, unbekannte Felder, zu tiefe/zu große Struktur → Fehler", () => {
    expect(parseRueckmeldung(json({ schema: "x/1", auszahlungsdatum: "2026-11-10", positionen: [] }), "r.json").fehler.join()).toMatch(/Schema/);
    const r = parseRueckmeldung(json({ schema: RUECKMELDUNG_SCHEMA, auszahlungsdatum: "2026-11-10", positionen: [{ verordnung_id: VO1, ausgezahlt_cent: 1.5, extra: 1 }] }), "r.json");
    expect(r.fehler.join("\n")).toMatch(/Position 1/);
    expect(parseRueckmeldung(Buffer.from("{kaputt"), "r.json").fehler.join()).toMatch(/JSON/);
  });
  it("Fehlerzeilen = echte Dateizeilen (Leerzeilen mitgezählt); optionale Spalte Gebühr EUR", () => {
    const text = `${kopf};Gebühr EUR\n\n${VO1};;;;5;;;;2026-11-10;SR1;1,50\n\n${VO2};;;;x;;;;2026-11-10;SR1;\n`;
    const r = parseRueckmeldung(Buffer.from(text), "r.csv");
    expect(r.fehler.join()).toMatch(/Zeile 5: /);
    const ok = parseRueckmeldung(Buffer.from(`${kopf};Gebühr EUR\n${VO1};;;;5;;;;2026-11-10;SR1;1,50\n`), "r.csv");
    expect(ok.fehler).toEqual([]);
    expect(ok.zeilen[0].gebuehrCent).toBe(150);
  });
});
