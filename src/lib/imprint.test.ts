import { describe, expect, it } from "vitest";
import { DEFAULT_REGULATIONS, imprintSettings, missingImprintFields, requiresRegister } from "./imprint";

const base = { name: "Praxis", street: "Weg 1", zip: "12345", city: "Ort", phone: "030 1", email: "a@example.org" };

describe("Impressum (§ 5 DDG)", () => {
  it("registerpflichtige Rechtsformen verlangen Registergericht und -nummer", () => {
    for (const f of ["GmbH", "UG (haftungsbeschränkt)", "PartG", "PartG mbB", "e. K.", "KG", "OHG", "GmbH & Co. KG"]) expect(requiresRegister(f), f).toBe(true);
    for (const f of ["", "Einzelpraxis", "GbR"]) expect(requiresRegister(f), f).toBe(false);
    const s = (i: Record<string, unknown>) => ({ imprint: { owner: "A", profession: "Podologin", ...i } });
    expect(missingImprintFields(base, s({ legalForm: "GmbH" }))).toEqual(["register"]);
    expect(missingImprintFields(base, s({ legalForm: "GmbH", registerCourt: "AG X" }))).toEqual(["register"]);
    expect(missingImprintFields(base, s({ legalForm: "GmbH", registerCourt: "AG X", registerNumber: "HRB 1" }))).toEqual([]);
    expect(missingImprintFields(base, s({ legalForm: "Einzelpraxis" }))).toEqual([]);
  });

  it("unbekannte Rechtsform wird verworfen; PodG-Standardtext nur bei Podologin/Podologe", () => {
    expect(imprintSettings({ imprint: { legalForm: "AG" } }).legalForm).toBe("");
    expect(imprintSettings({ imprint: { profession: "Podologe" } }).regulations).toBe(DEFAULT_REGULATIONS);
    expect(imprintSettings({ imprint: { profession: "Fußpflegerin" } }).regulations).toBe("");
    expect(imprintSettings({ imprint: { profession: "Fußpflegerin", regulations: DEFAULT_REGULATIONS } }).regulations).toBe("");
    expect(imprintSettings({ imprint: { profession: "Fußpflegerin", regulations: "eigene Regelung" } }).regulations).toBe("eigene Regelung");
  });
});
