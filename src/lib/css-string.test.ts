import { describe, expect, it } from "vitest";
import { cssString } from "./css-string";

describe("cssString (Allowlist-Escaping für CSS-Zeichenketten)", () => {
  it("lässt Buchstaben, Ziffern und . , / _ – - stehen", () => {
    expect(cssString("Rechnung Nr. R2026-0042")).toBe('"Rechnung Nr. R2026-0042"');
    expect(cssString("Quittung – Entwurf, Fußpflege 1/2_ä")).toBe('"Quittung – Entwurf, Fußpflege 1/2_ä"');
  });

  it("maskiert Anführungszeichen, Backslash, </style>, Form-Feed, Klammern, Zeilenumbruch und Emoji", () => {
    expect(cssString('a"b')).toBe('"a\\22 b"');
    expect(cssString("a\\b")).toBe('"a\\5c b"');
    expect(cssString("</style><script>")).toBe('"\\3c /style\\3e \\3c script\\3e "');
    expect(cssString("R\f1")).toBe('"R\\c 1"');
    expect(cssString("a}b{")).toBe('"a\\7d b\\7b "');
    expect(cssString("a\nb\r")).toBe('"a\\a b\\d "');
    expect(cssString("Öl")).toBe('"Öl"');
    expect(cssString("🦶")).toBe('"\\1f9b6 "');
  });

  it("Ergebnis enthält außer den Begrenzern nur erlaubte Zeichen und Escapes", () => {
    const nasty = 'X"\\\f\n\r\t<>{};:()@*\u0000\u2028🦶';
    const inner = cssString(nasty).slice(1, -1);
    expect(inner).not.toMatch(/["<>{}\f\n\r\t;\u0000\u2028]/);
    expect(inner.replace(/\\[0-9a-f]+ /g, "")).toMatch(/^[\p{L}\p{N} .,/_–-]*$/u);
  });
});
