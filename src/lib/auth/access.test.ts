import { describe, expect, it } from "vitest";
import { effectiveCan, isGrantActive, mutationAllowedWithoutPermission, pickActiveGrant, type AccessState } from "./access";

const base: AccessState = { role: "owner", readOnly: false, mutating: true, support: null };
const now = new Date("2026-11-08T12:00:00Z");
const h = 3600_000;

describe("Nur-Lesen-Modus (Abo)", () => {
  it("schreibende Anfragen verlieren alle Schreibrechte, Lesen/Export bleibt", () => {
    const ro = { ...base, readOnly: true };
    expect(effectiveCan(ro, "patients.write")).toBe(false);
    expect(effectiveCan(ro, "settings.manage")).toBe(false);
    expect(effectiveCan(ro, "import.run")).toBe(false);
    expect(effectiveCan(ro, "patients.read")).toBe(true);
    expect(effectiveCan(ro, "medical.read")).toBe(true);
    expect(effectiveCan(ro, "audit.read")).toBe(true);
  });
  it("Seitenaufrufe (GET) behalten die Rollenrechte (Anzeige), Rollenmatrix gilt weiter", () => {
    expect(effectiveCan({ ...base, readOnly: true, mutating: false }, "patients.write")).toBe(true);
    expect(effectiveCan({ ...base, role: "accountant" }, "patients.read")).toBe(false);
    expect(effectiveCan({ ...base, role: "accountant", readOnly: true }, "invoices.read")).toBe(true);
  });
});

describe("Support-Modus (Break-Glass)", () => {
  const support = { grantId: "g", scope: "read" as const, expiresAt: new Date(now.getTime() + h) };
  it("nur Leserechte – auch bei GET keine Schreibrechte", () => {
    for (const mutating of [true, false]) {
      const s = { ...base, mutating, support };
      expect(effectiveCan(s, "patients.read")).toBe(true);
      expect(effectiveCan(s, "medical.read")).toBe(true);
      expect(effectiveCan(s, "patients.write")).toBe(false);
      expect(effectiveCan(s, "medical.write")).toBe(false);
      expect(effectiveCan(s, "users.manage")).toBe(false);
    // Review Phase 3: kein Import und keine Schreibaktionen ohne explizites Recht im Support-Modus
    expect(effectiveCan(s, "import.run")).toBe(false);
    expect(mutationAllowedWithoutPermission({ support: s.support, mutating: true })).toBe(false);
      expect(effectiveCan(s, "settings.manage")).toBe(false);
    }
    expect(mutationAllowedWithoutPermission({ support, mutating: true })).toBe(false);
    expect(mutationAllowedWithoutPermission({ support, mutating: false })).toBe(true);
    expect(mutationAllowedWithoutPermission({ support: null, mutating: true })).toBe(true);
  });
  it("Scope „write“: nur Konfiguration, nie Team/Patientendaten", () => {
    const s = { ...base, support: { ...support, scope: "write" as const } };
    expect(effectiveCan(s, "settings.manage")).toBe(true);
    expect(effectiveCan(s, "integrations.manage")).toBe(true);
    expect(effectiveCan(s, "users.manage")).toBe(false);
    expect(effectiveCan(s, "patients.write")).toBe(false);
    expect(effectiveCan(s, "medical.write")).toBe(false);
  });
  it("Freigabe: Ablauf, Widerruf, Empfänger", () => {
    const g = { id: "1", granteeUserId: null, scope: "read", expiresAt: new Date(now.getTime() + h), revokedAt: null };
    expect(isGrantActive(g, "u1", now)).toBe(true);
    expect(isGrantActive(g, "u1", new Date(now.getTime() + h))).toBe(false);
    expect(isGrantActive({ ...g, revokedAt: now }, "u1", now)).toBe(false);
    expect(isGrantActive({ ...g, granteeUserId: "u2" }, "u1", now)).toBe(false);
    expect(isGrantActive({ ...g, granteeUserId: "u1" }, "u1", now)).toBe(true);
  });
  it("pickActiveGrant: längste gültige Freigabe, unbekannter Scope = read", () => {
    const grants = [
      { id: "a", granteeUserId: null, scope: "read", expiresAt: new Date(now.getTime() + h), revokedAt: null },
      { id: "b", granteeUserId: null, scope: "admin", expiresAt: new Date(now.getTime() + 5 * h), revokedAt: null },
      { id: "c", granteeUserId: null, scope: "write", expiresAt: new Date(now.getTime() + 9 * h), revokedAt: now },
    ];
    expect(pickActiveGrant(grants, "u", now)).toEqual({ grantId: "b", scope: "read", expiresAt: grants[1].expiresAt });
    expect(pickActiveGrant(grants, "u", new Date(now.getTime() + 6 * h))).toBeNull();
  });
});
