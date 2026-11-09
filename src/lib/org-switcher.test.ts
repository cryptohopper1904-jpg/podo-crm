import { describe, expect, it } from "vitest";
import { PLATFORM_TARGET, switcherModel } from "./org-switcher";

const demo = { organizationId: "11111111-1111-4111-8111-111111111111", name: "Demo-Praxis (Beispieldaten)", demo: true };
const real = { organizationId: "22222222-2222-4222-8222-222222222222", name: "Podologie Beispiel", demo: false };
const base = { memberships: [], currentOrgId: null, isPlatformAdmin: false, totpEnabled: true, support: false };

describe("Praxis-/Plattform-Wechsel", () => {
  it("Plattform-Admin mit 2FA und Demo-Mitgliedschaft: Auswahl Plattform + Demo-Praxis, Konsolen-Link", () => {
    const m = switcherModel({ ...base, isPlatformAdmin: true, memberships: [demo], currentOrgId: demo.organizationId });
    expect(m.show).toBe(true);
    expect(m.platformLink).toBe(true);
    expect(m.demoOrgId).toBe(demo.organizationId);
    expect(m.options.map((o) => [o.value, o.current, o.demo])).toEqual([
      [PLATFORM_TARGET, false, false],
      [demo.organizationId, true, true],
    ]);
  });
  it("in der Plattform-Sitzung ist „Plattform“ aktiv", () => {
    const m = switcherModel({ ...base, isPlatformAdmin: true, memberships: [demo] });
    expect(m.options.find((o) => o.current)?.value).toBe(PLATFORM_TARGET);
  });
  it("Plattform-Admin ohne 2FA: kein Konsolen-Link, keine Plattform-Option", () => {
    const m = switcherModel({ ...base, isPlatformAdmin: true, totpEnabled: false, memberships: [demo], currentOrgId: demo.organizationId });
    expect(m.platformLink).toBe(false);
    expect(m.show).toBe(false);
  });
  it("Plattform-Admin ohne Mitgliedschaft: nur Konsolen-Link, keine Auswahl", () => {
    const m = switcherModel({ ...base, isPlatformAdmin: true });
    expect(m).toMatchObject({ show: false, platformLink: true, demoOrgId: null });
  });
  it("normale Nutzer:in: Auswahl nur bei mehreren Praxen, nie Plattform", () => {
    expect(switcherModel({ ...base, memberships: [real], currentOrgId: real.organizationId })).toMatchObject({ show: false, platformLink: false });
    const m = switcherModel({ ...base, memberships: [real, { ...real, organizationId: "33333333-3333-4333-8333-333333333333", name: "Zweite" }], currentOrgId: real.organizationId });
    expect(m.show).toBe(true);
    expect(m.options.some((o) => o.value === PLATFORM_TARGET)).toBe(false);
  });
  it("Support-Modus: kein Wechsel und kein Konsolen-Link im Kopf", () => {
    const m = switcherModel({ ...base, isPlatformAdmin: true, memberships: [demo, real], currentOrgId: "44444444-4444-4444-8444-444444444444", support: true });
    expect(m).toMatchObject({ show: false, platformLink: false });
  });
});
