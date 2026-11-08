import { describe, expect, it } from "vitest";
import { hasLops, parseAnamnesis, riskFlagsFromAnamnesis, suggestIwgdfRisk } from "./anamnesis";

describe("Anamnese – Datensparsamkeit", () => {
  it("verwirft den Diabetes-Block ohne Diabetes", () => {
    const r = parseAnamnesis({ diabetesType: "2", hba1c: "7,1", insulin: "on" }, "practice");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.diabetes).toBe(false);
    expect(r.data).not.toHaveProperty("diabetesType");
    expect(r.data).not.toHaveProperty("hba1c");
    expect(r.data).not.toHaveProperty("insulin");
  });
  it("übernimmt den Diabetes-Block mit Diabetes (HbA1c mit Komma)", () => {
    const r = parseAnamnesis({ diabetes: "on", diabetesType: "2", hba1c: "7,1", insulin: "on" }, "practice");
    expect(r.ok && r.data).toMatchObject({ diabetes: true, diabetesType: "2", hba1c: 7.1, insulin: true });
  });
  it("Sensibilitätsbefunde nur, wenn getestet", () => {
    const untested = parseAnamnesis({ monofilamentLeft: "absent", tuningForkLeft: "2" }, "practice");
    expect(untested.ok && untested.data).not.toHaveProperty("monofilamentLeft");
    const tested = parseAnamnesis({ sensTested: "on", monofilamentLeft: "absent", tuningForkLeft: "2" }, "practice");
    expect(tested.ok && tested.data).toMatchObject({ sensTested: true, monofilamentLeft: "absent", tuningForkLeft: 2 });
  });
  it("Online-Bogen nimmt keine Praxis-Felder an", () => {
    const r = parseAnamnesis({ diabetes: "on", sensTested: "on", monofilamentLeft: "absent", iwgdfRisk: "3" }, "online");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.source).toBe("online");
    expect(r.data).not.toHaveProperty("monofilamentLeft");
    expect(r.data).not.toHaveProperty("iwgdfRisk");
  });
  it("IWGDF-Klasse nur bei Diabetes", () => {
    const r = parseAnamnesis({ iwgdfRisk: "2" }, "practice");
    expect(r.ok && r.data).not.toHaveProperty("iwgdfRisk");
  });
  it("lehnt unplausible Werte ab", () => {
    expect(parseAnamnesis({ diabetes: "on", hba1c: "70" }, "practice").ok).toBe(false);
    expect(parseAnamnesis({ sensTested: "on", tuningForkLeft: "9" }, "practice").ok).toBe(false);
    expect(parseAnamnesis({ medications: "x".repeat(2001) }, "online").ok).toBe(false);
  });
});

describe("IWGDF-Helfer", () => {
  const none = { lops: false, pad: false, deformity: false, ulcerHistory: false, amputation: false, dialysis: false };
  it("stuft 0–3 ein", () => {
    expect(suggestIwgdfRisk(none)).toBe(0);
    expect(suggestIwgdfRisk({ ...none, deformity: true })).toBe(0);
    expect(suggestIwgdfRisk({ ...none, lops: true })).toBe(1);
    expect(suggestIwgdfRisk({ ...none, lops: true, pad: true })).toBe(2);
    expect(suggestIwgdfRisk({ ...none, pad: true, deformity: true })).toBe(2);
    expect(suggestIwgdfRisk({ ...none, lops: true, ulcerHistory: true })).toBe(3);
    expect(suggestIwgdfRisk({ ...none, pad: true, dialysis: true })).toBe(3);
    // Ulkus ohne LOPS/pAVK → laut Schema keine Klasse 3
    expect(suggestIwgdfRisk({ ...none, ulcerHistory: true })).toBe(0);
  });
  it("erkennt LOPS aus Testbefunden", () => {
    expect(hasLops({ neuropathy: false, sensTested: true, monofilamentRight: "reduced" })).toBe(true);
    expect(hasLops({ neuropathy: false, sensTested: true, tuningForkLeft: 4 })).toBe(true);
    expect(hasLops({ neuropathy: false, sensTested: true, tuningForkLeft: 6, monofilamentLeft: "normal" })).toBe(false);
  });
});

describe("Risiko-Flags", () => {
  it("leitet Flags ab und behält sonstige Angaben", () => {
    const r = parseAnamnesis({ diabetes: "on", diabetesType: "1", anticoagulation: "on", allergyLatex: "on", allergies: "Pflaster" }, "practice");
    if (!r.ok) throw new Error("parse");
    expect(riskFlagsFromAnamnesis(r.data, { other: "Sturzgefahr", mrsa: true })).toMatchObject({
      diabetes: true, diabetesType: "Typ 1", anticoagulation: true, mrsa: false, allergies: "Latex, Pflaster", other: "Sturzgefahr",
    });
  });
});

import { initialFromRiskFlags } from "./anamnesis";
describe("Vorbelegung aus Kundenakte", () => {
  it("übernimmt bekannte Risiken, damit sie nicht gelöscht werden", () => {
    const i = initialFromRiskFlags({ diabetes: true, diabetesType: "Typ 2", anticoagulation: true, allergies: "Latex" });
    expect(i.diabetes).toBe(true);
    expect(i.diabetesType).toBe("2");
    expect(i.anticoagulation).toBe(true);
    expect(i.allergies).toBe("Latex");
    expect(i.pavk).toBe(false);
  });
});
