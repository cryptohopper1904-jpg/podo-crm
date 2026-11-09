import { describe, expect, it } from "vitest";
import { isPublicDomain, resolveDemoPassword, WELL_KNOWN_DEMO_PASSWORD } from "./demo-seed";

describe("Demo-Seed: kein bekanntes Passwort auf öffentlichen Domains (Gesamt-Review K1)", () => {
  it("erkennt öffentliche Domains", () => {
    expect(isPublicDomain("https://podo.algoverdict.com")).toBe(true);
    expect(isPublicDomain("crm.praxis.de")).toBe(true);
    for (const u of [undefined, "", "http://localhost:3000", "https://203.0.113.7", "http://[::1]:3000", "http://app.localhost", "http://podo.local", "nonsense url"]) {
      expect(isPublicDomain(u), String(u)).toBe(false);
    }
  });
  it("öffentliche Domain ohne SEED_DEMO_PASSWORD → Zufallspasswort", () => {
    const r = resolveDemoPassword({ PUBLIC_URL: "https://podo.algoverdict.com" });
    expect(r.source).toBe("generated");
    expect(r.password).not.toBe(WELL_KNOWN_DEMO_PASSWORD);
    expect(r.password.length).toBeGreaterThanOrEqual(20);
    expect(resolveDemoPassword({ PUBLIC_URL: "https://podo.algoverdict.com" }).password).not.toBe(r.password);
  });
  it("SEED_DEMO_PASSWORD hat Vorrang, muss aber stark genug sein", () => {
    expect(resolveDemoPassword({ PUBLIC_URL: "https://x.de", SEED_DEMO_PASSWORD: "ein-langes-geheimnis" })).toEqual({ password: "ein-langes-geheimnis", source: "env" });
    expect(() => resolveDemoPassword({ SEED_DEMO_PASSWORD: "kurz" })).toThrow(/zu kurz/);
    expect(() => resolveDemoPassword({ PUBLIC_URL: "https://x.de", SEED_DEMO_PASSWORD: WELL_KNOWN_DEMO_PASSWORD })).toThrow();
  });
  it("lokal bzw. IP-Installation: bekanntes Demo-Passwort (Entwicklung, E2E)", () => {
    expect(resolveDemoPassword({ PUBLIC_URL: "http://localhost:3000" }).source).toBe("well-known");
    expect(resolveDemoPassword({ PUBLIC_URL: "https://203.0.113.7" }).password).toBe(WELL_KNOWN_DEMO_PASSWORD);
    expect(resolveDemoPassword({}).source).toBe("well-known");
  });
});
