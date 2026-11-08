/** Sicherheits-Header aus next.config.ts headers() – gelten für alle Pfade. */
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

type Rule = { source: string; headers: { key: string; value: string }[] };

describe("Sicherheits-Header (next.config.ts)", async () => {
  const rules = ((await nextConfig.headers?.()) ?? []) as Rule[];
  const all = rules.find((r) => r.source === "/:path*");
  const h = (k: string) => all?.headers.find((x) => x.key.toLowerCase() === k.toLowerCase())?.value ?? "";

  it("gibt es eine Regel für alle Pfade", () => expect(all).toBeTruthy());

  it("CSP verbietet Einbetten (frame-ancestors 'none'), object-src/base-uri eingeschränkt", () => {
    const csp = h("Content-Security-Policy");
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/object-src 'none'/);
    expect(csp).toMatch(/base-uri 'self'/);
    expect(h("X-Frame-Options")).toBe("DENY");
  });

  it("nosniff, HSTS ≥ 1 Jahr inkl. Subdomains, Referrer-Policy", () => {
    expect(h("X-Content-Type-Options")).toBe("nosniff");
    const hsts = h("Strict-Transport-Security");
    expect(Number(hsts.match(/max-age=(\d+)/)?.[1] ?? 0)).toBeGreaterThanOrEqual(31536000);
    expect(hsts).toMatch(/includeSubDomains/);
    expect(h("Referrer-Policy")).toMatch(/same-origin|no-referrer|strict-origin/);
  });

  it("Permissions-Policy: Kamera/Mikrofon nur eigene Seite, keine Geolocation", () => {
    const pp = h("Permissions-Policy");
    expect(pp).toMatch(/camera=\(self\)/);
    expect(pp).toMatch(/microphone=\(self\)/);
    expect(pp).toMatch(/geolocation=\(\)/);
  });

  it("spätere Regeln schwächen die Schutz-Header nicht ab", () => {
    const guarded = ["content-security-policy", "x-frame-options", "x-content-type-options", "strict-transport-security", "permissions-policy"];
    const overrides = rules.filter((r) => r !== all).flatMap((r) => r.headers.filter((x) => guarded.includes(x.key.toLowerCase())).map((x) => `${r.source}: ${x.key}`));
    expect(overrides).toEqual([]);
  });

  it("kein X-Powered-By", () => expect(nextConfig.poweredByHeader).toBe(false));
});
