import { describe, expect, it } from "vitest";
import { ROLES } from "./permissions";
import { securitySettingsOf, twoFactorPending, twoFactorRequired } from "./two-factor";

describe("2FA-Pflicht (Gesamt-Review H1)", () => {
  it("Inhaber:in und Plattform-Admin immer", () => {
    expect(twoFactorRequired({ role: "owner", isPlatformAdmin: false })).toBe(true);
    expect(twoFactorRequired({ role: "reception", isPlatformAdmin: true })).toBe(true);
    expect(twoFactorRequired({ role: null, isPlatformAdmin: true })).toBe(true);
    expect(twoFactorRequired({ role: "owner", isPlatformAdmin: false, orgSettings: { security: { require2faAllRoles: false } } })).toBe(true);
  });
  it("übrige Rollen nur, wenn die Praxis es festlegt", () => {
    for (const role of ROLES.filter((r) => r !== "owner")) {
      expect(twoFactorRequired({ role, isPlatformAdmin: false, orgSettings: {} })).toBe(false);
      expect(twoFactorRequired({ role, isPlatformAdmin: false, orgSettings: { security: { require2faAllRoles: true } } })).toBe(true);
    }
  });
  it("pending nur ohne aktive 2FA", () => {
    expect(twoFactorPending({ totpEnabled: false, role: "owner", isPlatformAdmin: false })).toBe(true);
    expect(twoFactorPending({ totpEnabled: true, role: "owner", isPlatformAdmin: false })).toBe(false);
    expect(twoFactorPending({ totpEnabled: false, role: "therapist", isPlatformAdmin: false })).toBe(false);
  });
  it("Einstellung ist streng boolesch", () => {
    expect(securitySettingsOf({ security: { require2faAllRoles: "true" } }).require2faAllRoles).toBe(false);
    expect(securitySettingsOf(null).require2faAllRoles).toBe(false);
  });
});
