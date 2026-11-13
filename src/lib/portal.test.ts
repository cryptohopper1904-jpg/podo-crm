import { describe, expect, it } from "vitest";
import { canCancelOnline, hashPortalToken, invoiceVisibleInPortal, isPortalToken, newPortalToken, portalLinkValid } from "./portal";

const link = { organizationId: "org-a", patientId: "p-1", purpose: "portal", expiresAt: new Date(Date.now() + 86400_000), revokedAt: null };

describe("Patientenportal", () => {
  it("Token: 32 Byte base64url, nur Hash wird gespeichert", () => {
    const t = newPortalToken();
    expect(isPortalToken(t)).toBe(true);
    expect(isPortalToken("../../etc")).toBe(false);
    expect(hashPortalToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPortalToken(t)).not.toContain(t);
  });

  it("Link: abgelaufen, widerrufen oder anderer Zweck ist ungültig", () => {
    expect(portalLinkValid(link)).toBe(true);
    expect(portalLinkValid({ ...link, expiresAt: new Date(Date.now() - 1000) })).toBe(false);
    expect(portalLinkValid({ ...link, revokedAt: new Date() })).toBe(false);
    expect(portalLinkValid({ ...link, purpose: "anamnesis" })).toBe(false);
  });

  it("Rechnung nur sichtbar, wenn sie zur Person und Praxis des Links gehört", () => {
    expect(invoiceVisibleInPortal({ organizationId: "org-a", patientId: "p-1", status: "issued" }, link)).toBe(true);
    expect(invoiceVisibleInPortal({ organizationId: "org-a", patientId: "p-2", status: "issued" }, link)).toBe(false);
    expect(invoiceVisibleInPortal({ organizationId: "org-b", patientId: "p-1", status: "issued" }, link)).toBe(false);
    expect(invoiceVisibleInPortal({ organizationId: "org-a", patientId: null, status: "issued" }, link)).toBe(false);
    expect(invoiceVisibleInPortal({ organizationId: "org-a", patientId: "p-1", status: "draft" }, link)).toBe(false);
    expect(invoiceVisibleInPortal(null, link)).toBe(false);
  });

  it("Online-Absage nur bis 24 h vorher", () => {
    const now = new Date("2026-11-08T10:00:00Z");
    expect(canCancelOnline(new Date("2026-11-09T10:00:00Z"), now)).toBe(true);
    expect(canCancelOnline(new Date("2026-11-09T09:59:00Z"), now)).toBe(false);
  });
});
