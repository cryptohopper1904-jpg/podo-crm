/** Phase-4-Härtung: Cookie-Name, Client-IP hinter Proxys, Entprellung von support.view. */
import { describe, expect, it } from "vitest";
import { clientIpFrom, trustedProxyHops } from "./client-ip";
import { acceptedSessionCookieNames, readSessionToken, sessionCookieName, sessionCookieOptions } from "./cookie";
import { createSupportViewLog } from "./support-view";

const jar = (c: Record<string, string>) => ({ get: (n: string) => (n in c ? { value: c[n] } : undefined) });

describe("Sitzungs-Cookie", () => {
  it("Produktion: nur __Host-podo_session, secure, path=/, ohne Domain", () => {
    expect(sessionCookieName("production")).toBe("__Host-podo_session");
    expect(acceptedSessionCookieNames("production")).toEqual(["__Host-podo_session"]);
    const o = sessionCookieOptions(new Date(0), "production");
    expect(o).toMatchObject({ secure: true, path: "/", httpOnly: true, sameSite: "lax" });
    expect(o).not.toHaveProperty("domain");
    // altes Cookie wird in Produktion nicht mehr akzeptiert
    expect(readSessionToken(jar({ podo_session: "alt" }), "production")).toBeNull();
    expect(readSessionToken(jar({ "__Host-podo_session": "neu" }), "production")).toBe("neu");
  });

  it("Entwicklung: podo_session, während der Umstellung beide Namen", () => {
    expect(sessionCookieName("development")).toBe("podo_session");
    expect(sessionCookieOptions(new Date(0), "development").secure).toBe(false);
    expect(readSessionToken(jar({ podo_session: "a" }), "development")).toBe("a");
    expect(readSessionToken(jar({ "__Host-podo_session": "b" }), "development")).toBe("b");
    expect(readSessionToken(jar({}), "test")).toBeNull();
  });
});

describe("Client-IP (TRUSTED_PROXY_HOPS)", () => {
  it("Standard 1 Hop (Caddy): letzter Eintrag, vorangestellte Fälschungen zählen nicht", () => {
    expect(trustedProxyHops(undefined)).toBe(1);
    expect(clientIpFrom("6.6.6.6, 203.0.113.7", null, 1)).toBe("203.0.113.7");
    expect(clientIpFrom("203.0.113.7", null, 1)).toBe("203.0.113.7");
  });

  it("2 Hops (CDN + Caddy): zweiter von rechts", () => {
    expect(clientIpFrom("6.6.6.6, 203.0.113.7, 198.51.100.1", null, 2)).toBe("203.0.113.7");
    expect(clientIpFrom("203.0.113.7", null, 2)).toBe("203.0.113.7");
  });

  it("0 Hops: Header werden ignoriert; ungültige Werte → Standard", () => {
    expect(clientIpFrom("1.2.3.4", "1.2.3.4", 0)).toBeNull();
    expect(trustedProxyHops("0")).toBe(0);
    expect(trustedProxyHops("2")).toBe(2);
    expect(trustedProxyHops("abc")).toBe(1);
    expect(trustedProxyHops("-1")).toBe(1);
  });

  it("ohne X-Forwarded-For: X-Real-IP des Proxys", () => {
    expect(clientIpFrom(null, "203.0.113.9", 1)).toBe("203.0.113.9");
    expect(clientIpFrom(" , ", null, 1)).toBeNull();
  });
});

describe("support.view – nur echte Ansichten, entprellt", () => {
  const view = (path: string, o: Partial<{ mutating: boolean }> = {}) => ({ path, mutating: false, ...o });

  it("gleicher Pfad je Freigabe höchstens einmal je 60 s; andere Pfade/Freigaben unabhängig", () => {
    const log = createSupportViewLog();
    const t = 1_000_000;
    expect(log.shouldLog("g1", view("/kunden"), t)).toBe(true);
    expect(log.shouldLog("g1", view("/kunden"), t + 5_000)).toBe(false);
    expect(log.shouldLog("g1", view("/kunden/1"), t + 5_000)).toBe(true);
    expect(log.shouldLog("g2", view("/kunden"), t + 5_000)).toBe(true);
    expect(log.shouldLog("g1", view("/kunden"), t + 60_001)).toBe(true);
  });

  it("schreibende Anfragen immer; keine Ausnahme per Client-Header (H6: `Purpose: prefetch`)", () => {
    const log = createSupportViewLog();
    // Ein vom Client gesetzter Prefetch-Header darf das Audit nicht abschalten: die Anfrage enthält
    // diese Information gar nicht mehr, jeder Lesezugriff zählt.
    const forged = { ...view("/kunden"), prefetch: true } as ReturnType<typeof view>;
    expect(log.shouldLog("g", forged, 1)).toBe(true);
    expect(log.shouldLog("g", view("/kunden", { mutating: true }), 1)).toBe(true);
    expect(log.shouldLog("g", view("/kunden", { mutating: true }), 2)).toBe(true);
  });

  it("Speicher begrenzt (LRU)", () => {
    const log = createSupportViewLog({ maxKeys: 3 });
    for (let i = 0; i < 10; i++) log.shouldLog("g", view(`/p/${i}`), i);
    expect(log.size()).toBe(3);
  });
});
