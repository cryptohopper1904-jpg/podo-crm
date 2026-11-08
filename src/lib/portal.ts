/**
 * Kundenportal (light) – reine Hilfsfunktionen (testbar, ohne DB).
 * Der Link ist ein zufälliges Token (32 Byte, base64url); gespeichert wird nur der SHA-256-Hash.
 * Gültig bis zum Ablauf (30 Tage), nicht einmalig; Widerruf über revoked_at.
 */
import { createHash, randomBytes } from "node:crypto";

export const PORTAL_PURPOSE = "portal";
export const PORTAL_DAYS = 30;
export const PORTAL_CANCEL_HOURS = 24;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const isPortalToken = (t: unknown): t is string => typeof t === "string" && TOKEN_RE.test(t);
export const hashPortalToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const newPortalToken = () => randomBytes(32).toString("base64url");

export type PortalLink = { organizationId: string; patientId: string; purpose: string; expiresAt: Date; revokedAt: Date | null };

export function portalLinkValid(link: PortalLink | null | undefined, now = new Date()): link is PortalLink {
  return !!link && link.purpose === PORTAL_PURPOSE && !link.revokedAt && link.expiresAt.getTime() > now.getTime();
}

/** Gehört die Rechnung zur Person des Links? (Mandant + Person, keine Entwürfe) */
export function invoiceVisibleInPortal(inv: { organizationId: string; patientId: string | null; status: string } | null | undefined, link: Pick<PortalLink, "organizationId" | "patientId">): boolean {
  return !!inv && inv.organizationId === link.organizationId && inv.patientId === link.patientId && inv.status !== "draft";
}

/** Online-Absage nur bis 24 h vor Terminbeginn. */
export function canCancelOnline(startsAt: Date, now = new Date()) {
  return startsAt.getTime() - now.getTime() >= PORTAL_CANCEL_HOURS * 3600_000;
}
