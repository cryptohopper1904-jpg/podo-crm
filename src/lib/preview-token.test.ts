import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalPreviewToken, PREVIEW_TOKEN_RE, signPreviewToken, verifyPreviewToken, type PreviewBinding } from "./preview-token";
import { safeEqual } from "./safe-equal";

const key = randomBytes(32);
const b: PreviewBinding = { hash: "abc", organizationId: "org-1", userId: "u-1", type: "excel" };
/** realistischer Zeitpunkt (13-stellige Millisekunden) */
const T0 = 1_800_000_000_000;

describe("Vorschau-Token", () => {
  it("ist an Datei, Praxis, Benutzer und Art gebunden", () => {
    const t = signPreviewToken(b, T0, key);
    expect(verifyPreviewToken(t, b, T0 + 1_000, key)).toBe(true);
    expect(verifyPreviewToken(t, { ...b, hash: "def" }, T0 + 1_000, key)).toBe(false);
    expect(verifyPreviewToken(t, { ...b, organizationId: "org-2" }, T0 + 1_000, key)).toBe(false);
    expect(verifyPreviewToken(t, { ...b, userId: "u-2" }, T0 + 1_000, key)).toBe(false);
    expect(verifyPreviewToken(t, { ...b, type: "doctolib" }, T0 + 1_000, key)).toBe(false);
    expect(verifyPreviewToken(t, b, T0 + 1_000, randomBytes(32))).toBe(false);
  });
  it("läuft nach 15 Minuten ab und lehnt Unsinn ab", () => {
    const t = signPreviewToken(b, T0, key);
    expect(verifyPreviewToken(t, b, T0 + 15 * 60_000 + 1, key)).toBe(false);
    expect(verifyPreviewToken("", b, 0, key)).toBe(false);
    expect(verifyPreviewToken("abc.def", b, 0, key)).toBe(false);
    // Ein selbst berechneter Datei-Hash reicht nicht
    expect(verifyPreviewToken("abc", b, 0, key)).toBe(false);
  });
  it("A-H1: nur die kanonische Form ist gültig – Schreibvarianten derselben Signatur werden abgelehnt", () => {
    const t = signPreviewToken(b, T0, key);
    expect(t).toMatch(PREVIEW_TOKEN_RE);
    expect(canonicalPreviewToken(t)).toBe(t);
    const [exp, sig] = t.split(".");
    for (const v of [
      `${t}.x`, // Zusatzteil
      `${t}.`,
      ` ${t}`,
      `${t} `,
      `${t}\n`,
      `+${exp}.${sig}`, // Vorzeichen
      `0${exp}.${sig}`, // führende Null
      `${exp}.0.${sig}`,
      `${Number(exp) / 1000}e3.${sig}`, // Exponent
      `${exp}.${sig}=`, // Padding
      `${exp}.${sig.slice(0, 42)}`,
      `${exp}..${sig}`,
    ]) {
      expect(verifyPreviewToken(v, b, T0 + 1_000, key), v).toBe(false);
    }
  });
  it("safeEqual", () => {
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "b")).toBe(false);
    expect(safeEqual("", "")).toBe(false);
    expect(safeEqual(null, "a")).toBe(false);
  });
});
