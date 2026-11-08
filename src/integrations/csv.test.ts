import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv, parseCsvObjects, writeCsv } from "./csv";

describe("CSV", () => {
  it("erkennt Trennzeichen", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(detectDelimiter('"x;y",b,c')).toBe(",");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
  });

  it("parst Anführungszeichen, Zeilenumbrüche, BOM und CRLF", () => {
    const text = '﻿name;notiz\r\n"Beispiel; Erika";"Zeile 1\nZeile ""2"""\r\n\r\nMuster;\r\n';
    expect(parseCsv(text)).toEqual([
      ["name", "notiz"],
      ["Beispiel; Erika", 'Zeile 1\nZeile "2"'],
      ["Muster", ""],
    ]);
  });

  it("liefert Objekte mit Zeilennummern", () => {
    const { headers, records } = parseCsvObjects("a,b\n1,2\n3");
    expect(headers).toEqual(["a", "b"]);
    expect(records).toEqual([
      { row: 2, values: { a: "1", b: "2" } },
      { row: 3, values: { a: "3", b: "" } },
    ]);
  });

  it("Round-Trip über writeCsv", () => {
    const rows = [
      ["id", "text"],
      ["1", 'mit "Zitat"; und Semikolon'],
      ["2", null],
    ];
    const out = writeCsv(rows);
    expect(out.startsWith("﻿")).toBe(true);
    expect(parseCsv(out)).toEqual([
      ["id", "text"],
      ["1", 'mit "Zitat"; und Semikolon'],
      ["2", ""],
    ]);
  });
});
