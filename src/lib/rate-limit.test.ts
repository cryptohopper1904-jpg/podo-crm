import { describe, expect, it } from "vitest";
import { clientKey, createRateLimiter, ipKey } from "./rate-limit";

describe("Rate-Limit", () => {
  it("sperrt nach max Aufrufen im Fenster", () => {
    const l = createRateLimiter({ windowMs: 1000, max: 3 });
    expect([1, 2, 3].map(() => l.limited("a", 0))).toEqual([false, false, false]);
    expect(l.limited("a", 10)).toBe(true);
    expect(l.exceeded("a", 10)).toBe(true);
    expect(l.limited("a", 2000)).toBe(false);
  });

  it("viele fremde Schlüssel setzen eine bestehende Sperre nicht zurück (LRU statt clear)", () => {
    const l = createRateLimiter({ windowMs: 60_000, max: 2, maxKeys: 100 });
    l.limited("angreifer", 0);
    l.limited("angreifer", 0);
    l.limited("angreifer", 0);
    for (let i = 0; i < 99; i++) l.limited(`x${i}`, 1);
    l.limited("angreifer", 2); // zuletzt benutzt → bleibt erhalten
    for (let i = 99; i < 180; i++) l.limited(`x${i}`, 3);
    expect(l.size()).toBeLessThanOrEqual(100);
    expect(l.exceeded("angreifer", 4)).toBe(true);
  });

  it("ohne IP: eigener, strengerer Eimer je User-Agent statt gemeinsamem „unbekannt“", () => {
    const a = clientKey({ ip: null, userAgent: "Browser A" });
    const b = clientKey({ ip: null, userAgent: "Browser B" });
    expect(a).not.toBe(b);
    expect(a.startsWith("noip:")).toBe(true);
    expect(clientKey({ ip: "203.0.113.5" })).toBe("203.0.113.5");
    const l = createRateLimiter({ windowMs: 60_000, max: 4 });
    expect([1, 2].map(() => l.limited(`view:${a}`, 0))).toEqual([false, false]);
    expect(l.limited(`view:${a}`, 0)).toBe(true); // halbes Limit
  });
});

describe("Drosselung: IPv6 je /64", () => {
  it("Adressen desselben /64 teilen einen Schlüssel, IPv4 bleibt", () => {
    expect(ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:0db8:0001:0002::1")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:DB8:1:2::ffff")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
    expect(ipKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(ipKey("::ffff:cb00:7105")).toBe("203.0.113.5");
    expect(ipKey("0:0:0:0:0:ffff:c000:201")).toBe("192.0.2.1");
    expect(ipKey("203.0.113.5")).toBe("203.0.113.5");
    expect(ipKey("kaputt:::x")).toBe("kaputt:::x");
    expect(clientKey({ ip: "2001:db8:1:2::7" })).toBe(clientKey({ ip: "2001:db8:1:2:ffff::9" }));
  });
});
