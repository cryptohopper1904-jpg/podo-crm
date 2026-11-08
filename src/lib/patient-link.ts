import { createHash, randomBytes } from "node:crypto";

/**
 * Einmal-Links für Patienten (Online-Anamnese, später Kundenportal).
 * Der Klartext-Token (32 Zufallsbytes, base64url) steht NUR im Link; gespeichert wird der SHA-256-Hash.
 */
export const LINK_TTL_DAYS = 7;
export const LINK_PURPOSES = ["anamnesis", "portal"] as const;
export type LinkPurpose = (typeof LINK_PURPOSES)[number];

export function hashLinkToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateLinkToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashLinkToken(token) };
}

/** 32 Bytes base64url = 43 Zeichen. Alles andere wird ohne DB-Abfrage abgewiesen. */
export function isWellFormedToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export type LinkState = "valid" | "used" | "revoked" | "expired";

export function linkState(link: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now = new Date()): LinkState {
  if (link.revokedAt) return "revoked";
  if (link.usedAt) return "used";
  if (link.expiresAt.getTime() <= now.getTime()) return "expired";
  return "valid";
}

export function linkExpiry(now = new Date(), days = LINK_TTL_DAYS): Date {
  return new Date(now.getTime() + days * 86_400_000);
}
