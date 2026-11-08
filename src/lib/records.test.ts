import { describe, expect, it } from "vitest";
import { chainHash, treatmentContent, verifyChain } from "./records";

describe("Hash-Kette", () => {
  it("erkennt Manipulation", () => {
    const a = { findings: "Hyperkeratose Ferse li" };
    const b = { findings: "Kontrolle, unauffällig" };
    const h1 = chainHash(null, a);
    const h2 = chainHash(h1, b);
    const chain = [
      { prevHash: null, hash: h1, content: a },
      { prevHash: h1, hash: h2, content: b },
    ];
    expect(verifyChain(chain)).toBe(-1);
    chain[0].content = { findings: "geändert" };
    expect(verifyChain(chain)).toBe(0);
  });
  it("ist unabhängig von der Schlüsselreihenfolge", () => {
    expect(chainHash(null, { a: 1, b: 2 })).toBe(chainHash(null, { b: 2, a: 1 }));
  });
});

describe("treatmentContent", () => {
  const base = {
    patientId: "p", authorId: "a", treatedAt: "2026-11-08T10:00:00.000Z", findings: "Befund", servicesText: null, material: null,
    sterileBatchCode: null, reaction: null, recommendation: null, footPoints: [], structured: {}, appointmentId: null,
    missingPhotoReason: null, aiAssisted: false, countersignRequired: false,
  };
  it("lässt prescriptionId weg, wenn leer (alte Hashes bleiben gültig)", () => {
    expect(chainHash(null, treatmentContent({ ...base, prescriptionId: null }))).toBe(chainHash(null, base));
  });
  it("nimmt prescriptionId in den Hash auf", () => {
    const withVo = chainHash(null, treatmentContent({ ...base, prescriptionId: "vo-1" }));
    expect(withVo).not.toBe(chainHash(null, base));
    expect(withVo).not.toBe(chainHash(null, treatmentContent({ ...base, prescriptionId: "vo-2" })));
  });
});
