import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signPreviewToken, verifyPreviewToken, type PreviewBinding } from "./preview-token";
import { safeEqual } from "./safe-equal";

const key = randomBytes(32);
const b: PreviewBinding = { hash: "abc", organizationId: "org-1", userId: "u-1", type: "excel" };

describe("Vorschau-Token", () => {
  it("ist an Datei, Praxis, Benutzer und Art gebunden", () => {
    const t = signPreviewToken(b, 1_000, key);
    expect(verifyPreviewToken(t, b, 2_000, key)).toBe(true);
    expect(verifyPreviewToken(t, { ...b, hash: "def" }, 2_000, key)).toBe(false);
    expect(verifyPreviewToken(t, { ...b, organizationId: "org-2" }, 2_000, key)).toBe(false);
    expect(verifyPreviewToken(t, { ...b, userId: "u-2" }, 2_000, key)).toBe(false);
    expect(verifyPreviewToken(t, { ...b, type: "doctolib" }, 2_000, key)).toBe(false);
    expect(verifyPreviewToken(t, b, 2_000, randomBytes(32))).toBe(false);
  });
  it("läuft nach 15 Minuten ab und lehnt Unsinn ab", () => {
    const t = signPreviewToken(b, 0, key);
    expect(verifyPreviewToken(t, b, 15 * 60_000 + 1, key)).toBe(false);
    expect(verifyPreviewToken("", b, 0, key)).toBe(false);
    expect(verifyPreviewToken("abc.def", b, 0, key)).toBe(false);
    // Ein selbst berechneter Datei-Hash reicht nicht
    expect(verifyPreviewToken("abc", b, 0, key)).toBe(false);
  });
  it("safeEqual", () => {
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "b")).toBe(false);
    expect(safeEqual("", "")).toBe(false);
    expect(safeEqual(null, "a")).toBe(false);
  });
});
