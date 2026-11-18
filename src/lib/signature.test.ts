import { describe, expect, it } from "vitest";
import { MAX_SIGNATURE_BYTES } from "./signature";
import { checkSignaturePng } from "./signature-png";
import { testPng } from "./__tests__/png-fixture";

describe("Unterschrift (PNG) prüfen – nur das Format der Zeichenfläche", () => {
  it("gültiges PNG 900×300, 8 Bit RGBA", () => {
    expect(checkSignaturePng(testPng())).toEqual({ ok: true, width: 900, height: 300 });
  });
  it("kein PNG, leer, zu groß", () => {
    expect(checkSignaturePng(new Uint8Array())).toMatchObject({ ok: false });
    expect(checkSignaturePng(Buffer.from("<svg onload=alert(1)>"))).toMatchObject({ ok: false, error: expect.stringMatching(/kein gültiges Bild/) });
    expect(checkSignaturePng(new Uint8Array(MAX_SIGNATURE_BYTES + 1))).toMatchObject({ ok: false, error: expect.stringMatching(/zu groß/) });
  });
  it("andere Abmessungen, 16 Bit, anderer Farbtyp → abgelehnt", () => {
    expect(checkSignaturePng(testPng({ width: 1000 }))).toMatchObject({ ok: false });
    expect(checkSignaturePng(testPng({ height: 200 }))).toMatchObject({ ok: false });
    expect(checkSignaturePng(testPng({ bitDepth: 16 }))).toMatchObject({ ok: false });
    expect(checkSignaturePng(testPng({ colorType: 0 }))).toMatchObject({ ok: false });
  });
  it("APNG (acTL/fdAT) und unbekannte Chunks → abgelehnt", () => {
    expect(checkSignaturePng(testPng({ extraChunks: [["acTL", Buffer.alloc(8)]] }))).toMatchObject({ ok: false });
    expect(checkSignaturePng(testPng({ extraChunks: [["tEXt", Buffer.from("Comment\0x")]] }))).toMatchObject({ ok: false });
  });
  it("Dekompressionsbombe: IDAT entpackt mehr als 900×300 RGBA → abgelehnt", () => {
    expect(checkSignaturePng(testPng({ rawBytes: (900 * 4 + 1) * 300 * 20 }))).toMatchObject({ ok: false });
    expect(checkSignaturePng(testPng({ rawBytes: 100 }))).toMatchObject({ ok: false });
  });
});
