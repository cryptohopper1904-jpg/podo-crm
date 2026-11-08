import { describe, expect, it } from "vitest";
import { PORTAL_SESSION_SECONDS, signPortalSession, verifyPortalSession } from "./portal-session";

const key = Buffer.alloc(32, 7);
const other = Buffer.alloc(32, 8);
const linkId = "0b9c2f3e-1d2a-4c5b-8e9f-0a1b2c3d4e5f";

describe("Portal-Sitzung (signiertes Cookie)", () => {
  it("gültig bis Ablauf, höchstens 2 h und nie länger als der Link", () => {
    const now = Date.UTC(2026, 10, 8, 10);
    const s = signPortalSession(linkId, new Date(now + 30 * 86400_000), { now, key });
    expect(s.expires.getTime()).toBe(now + PORTAL_SESSION_SECONDS * 1000);
    expect(verifyPortalSession(s.value, { now, key })).toBe(linkId);
    expect(verifyPortalSession(s.value, { now: now + PORTAL_SESSION_SECONDS * 1000 + 1, key })).toBeNull();
    const short = signPortalSession(linkId, new Date(now + 60_000), { now, key });
    expect(short.expires.getTime()).toBe(now + 60_000);
  });

  it("lehnt manipulierte oder fremd signierte Werte ab", () => {
    const now = Date.now();
    const s = signPortalSession(linkId, new Date(now + 86400_000), { now, key }).value;
    const [id, exp, sig] = s.split(".");
    expect(verifyPortalSession(s, { now, key: other })).toBeNull();
    expect(verifyPortalSession(`${id}.${Number(exp) + 3600}.${sig}`, { now, key })).toBeNull();
    expect(verifyPortalSession(`${"1b9c2f3e-1d2a-4c5b-8e9f-0a1b2c3d4e5f"}.${exp}.${sig}`, { now, key })).toBeNull();
    expect(verifyPortalSession(`${s}.x`, { now, key })).toBeNull();
    expect(verifyPortalSession("", { now, key })).toBeNull();
    expect(verifyPortalSession(undefined, { now, key })).toBeNull();
  });
});
