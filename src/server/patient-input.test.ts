/** Versichertennummer im Personenformular (PR #111 C4): KVNR-Normalisierung nur bei GKV, sonst bisherige Regel. */
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { patientInput } from "./patients";

describe("patientInput – Versichertennummer", () => {
  it("GKV: Leerzeichen raus, Großbuchstaben; zu lang → deutsche Meldung", () => {
    const ok = patientInput.safeParse({ lastName: "Muster", insuranceType: "gkv", insuranceNumber: "a 123 456 780" });
    expect(ok.success && ok.data.insuranceNumber).toBe("A123456780");
    const long = patientInput.safeParse({ lastName: "Muster", insuranceType: "gkv", insuranceNumber: "A".repeat(21) });
    expect(long.success).toBe(false);
    expect(long.error?.issues[0]?.message).toMatch(/KVNR hat 10 Zeichen/);
  });
  it("Privat/Selbstzahler: unverändert, bis 500 Zeichen", () => {
    const pkv = patientInput.safeParse({ lastName: "Muster", insuranceType: "pkv", insuranceNumber: "Vertrag 12-345 / b" });
    expect(pkv.success && pkv.data.insuranceNumber).toBe("Vertrag 12-345 / b");
    expect(patientInput.safeParse({ lastName: "Muster", insuranceType: "pkv", insuranceNumber: "x".repeat(400) }).success).toBe(true);
  });
});
