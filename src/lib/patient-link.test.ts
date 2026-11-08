import { describe, expect, it } from "vitest";
import { generateLinkToken, hashLinkToken, isWellFormedToken, linkExpiry, linkState } from "./patient-link";
import { createRateLimiter } from "./rate-limit";

describe("Einmal-Link-Token", () => {
  it("32 Bytes base64url, nur Hash wird gespeichert", () => {
    const { token, tokenHash } = generateLinkToken();
    expect(token).toHaveLength(43);
    expect(isWellFormedToken(token)).toBe(true);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(hashLinkToken(token));
    expect(tokenHash).not.toContain(token);
    expect(generateLinkToken().token).not.toBe(token);
  });
  it("weist kaputte Token ohne DB-Abfrage ab", () => {
    expect(isWellFormedToken("")).toBe(false);
    expect(isWellFormedToken("a".repeat(42))).toBe(false);
    expect(isWellFormedToken("a".repeat(42) + "=")).toBe(false);
    expect(isWellFormedToken("../../etc/passwd")).toBe(false);
    expect(isWellFormedToken(undefined)).toBe(false);
  });
  it("Status: gültig, benutzt, widerrufen, abgelaufen", () => {
    const now = new Date("2026-11-08T10:00:00Z");
    const exp = linkExpiry(now);
    expect(exp.toISOString()).toBe("2026-11-15T10:00:00.000Z");
    expect(linkState({ usedAt: null, revokedAt: null, expiresAt: exp }, now)).toBe("valid");
    expect(linkState({ usedAt: now, revokedAt: null, expiresAt: exp }, now)).toBe("used");
    expect(linkState({ usedAt: null, revokedAt: now, expiresAt: exp }, now)).toBe("revoked");
    expect(linkState({ usedAt: null, revokedAt: null, expiresAt: exp }, new Date("2026-11-15T10:00:00Z"))).toBe("expired");
  });
});

describe("Drosselung", () => {
  it("lässt max Anfragen je Fenster zu", () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 2 });
    expect(rl.limited("ip", 0)).toBe(false);
    expect(rl.limited("ip", 10)).toBe(false);
    expect(rl.limited("ip", 20)).toBe(true);
    expect(rl.limited("other", 20)).toBe(false);
    expect(rl.limited("ip", 2000)).toBe(false);
  });
});
