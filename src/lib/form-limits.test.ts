import { describe, expect, it } from "vitest";
import { MAX_FORM_CHARS, MAX_FORM_ENTRIES, formWithinLimits } from "./form-limits";

const fd = (entries: [string, string | Blob][]) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};

describe("Formular-Obergrenzen (öffentliche Anamnese)", () => {
  it("akzeptiert normale Formulare", () => {
    expect(formWithinLimits(fd([["diabetes", "on"], ["medications", "x".repeat(2000)]]))).toBe(true);
  });
  it("lehnt zu viele Felder, zu viel Text und Dateien ab", () => {
    expect(formWithinLimits(fd(Array.from({ length: MAX_FORM_ENTRIES + 1 }, (_, i) => [`f${i}`, "1"] as [string, string])))).toBe(false);
    expect(formWithinLimits(fd([["notes", "x".repeat(MAX_FORM_CHARS + 1)]]))).toBe(false);
    expect(formWithinLimits(fd([["file", new Blob(["x"])]]))).toBe(false);
  });
});
