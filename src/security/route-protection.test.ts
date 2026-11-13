/**
 * Routen-Schutz im Proxy (src/proxy.ts) – ohne Next-Start:
 *  - jede Seite/API-Route unter src/app wird aufgezählt,
 *  - ohne Sitzungs-Cookie muss jede nicht-öffentliche Route nach /login umleiten,
 *  - die PUBLIC-Liste des Proxys darf nur bewusst freigegebene Präfixe enthalten.
 * Neue öffentliche Präfixe → hier in INTENDED_PUBLIC mit Begründung eintragen (Review!).
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import path from "node:path";
import { config, proxy } from "@/proxy";
import { appRoutes, read, SRC } from "./app-files";

/** Bewusst öffentlich (ohne Sitzung) – jeweils mit eigener Absicherung. */
export const INTENDED_PUBLIC: Record<string, string> = {
  "/login": "Anmeldung",
  "/login/passwort-vergessen": "Passwort vergessen: neutrale Antwort, Rate-Limit je IP und E-Mail",
  "/login/passwort-neu": "Neues Passwort per Einmal-Token (30 min, nur sha256 gespeichert)",
  "/einrichtung": "Ersteinrichtung (SETUP_TOKEN / ALLOW_SIGNUP)",
  "/kein-zugriff": "Hinweisseite ohne Daten",
  "/buchen": "Online-Buchung (Rate-Limit, nie Aktenzuordnung)",
  "/anamnese": "Anamnese-Link (Einmal-Token)",
  "/portal": "Patientenportal (Token → signierte Cookie-Sitzung)",
  "/api/webhooks": "Webhooks (HMAC-Signatur bzw. Token je Praxis)",
  "/api/voice": "KI-Telefonagent (x-vapi-secret bzw. x-retell-signature je Praxis)",
  "/api/billing/webhook": "Stripe-Webhook (Stripe-Signature)",
  "/api/calendar": "iCal-Feed (signiertes Token)",
  "/api/health": "Health-Check ohne Daten",
  "/api/cron": "Cron (Bearer CRON_SECRET)",
  "/abmelden": "Abmeldung von Vertriebsmails (HMAC-signierte Lead-ID, Antwort ohne Daten des Eintrags)",
  "/p": "Praxis-Website (Zusatzmodul): nur veröffentlichte Geschäftsangaben der Praxis, ohne Cookies/Tracking",
  // öffentliche Website und Rechtstexte (src/app/(public)) – statisch, ohne Praxisdaten
  "/agb": "Website",
  "/avv": "Website",
  "/datenschutz": "Website",
  "/impressum": "Website",
  "/preise": "Website",
  "/funktionen": "Website",
  "/sicherheit": "Website",
  "/unterauftragnehmer": "Website",
  "/vergleich": "Website: Software-Vergleich (statisch)",
  "/wechseln": "Website: Wechsel-Ratgeber (statisch)",
  "/wissen": "Website: Wissensartikel (statisch)",
  "/robots.txt": "robots.txt (keine Daten)",
  "/sitemap.xml": "Sitemap der öffentlichen Website (keine Praxisdaten)",
};

const isIntendedPublic = (p: string) => p === "/" || Object.keys(INTENDED_PUBLIC).some((x) => p === x || p.startsWith(x + "/"));

function proxyPublicList(): string[] {
  const src = read(path.join(SRC, "proxy.ts"));
  const m = src.match(/const\s+PUBLIC\s*(?::[^=]+)?=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error("PUBLIC-Liste in src/proxy.ts nicht gefunden");
  return [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]);
}

const call = (p: string, cookie?: string) => {
  const req = new NextRequest(new URL(p, "https://praxis.example"), cookie ? { headers: { cookie } } : undefined);
  return proxy(req);
};
const redirectsToLogin = (res: Response) => res.status >= 300 && res.status < 400 && new URL(res.headers.get("location") ?? "", "https://x").pathname === "/login";

describe("Proxy: Routen-Schutz", () => {
  const routes = appRoutes();

  it("findet Seiten und API-Routen", () => {
    expect(routes.filter((r) => r.kind === "page").length).toBeGreaterThan(20);
    expect(routes.filter((r) => r.kind === "route").length).toBeGreaterThan(5);
    expect(routes.map((r) => r.file)).toContain("src/app/api/voice/[provider]/route.ts");
  });

  it("jede nicht-öffentliche Route leitet ohne Cookie zu /login um", async () => {
    const leaks: string[] = [];
    for (const r of routes.filter((x) => !isIntendedPublic(x.path))) {
      const res = await call(r.path);
      if (!redirectsToLogin(res)) leaks.push(`${r.path} (${r.file})`);
      // auch mit Anhängseln, die einen naiven startsWith-Vergleich austricksen würden
      const tricky = await call(`${r.path}?next=/login`);
      if (!redirectsToLogin(tricky)) leaks.push(`${r.path}?next=… (${r.file})`);
    }
    expect(leaks).toEqual([]);
  });

  it("Präfix-Freigaben gelten nicht für ähnlich benannte Pfade", async () => {
    for (const p of ["/loginx", "/portalx", "/api/webhooksx/a", "/api/voicex", "/buchenx", "/plattform", "/px", "/preisex", "/abmeldenx", "/plattform/vertrieb", "/vergleichx", "/wissenx", "/wechselnx", "/screenshotsx"]) expect(redirectsToLogin(await call(p)), p).toBe(true);
  });

  it("mit Sitzungs-Cookie wird eine geschützte Route durchgelassen (echte Prüfung danach in requireAuth)", async () => {
    const res = await call("/kunden", "podo_session=abc");
    expect(redirectsToLogin(res)).toBe(false);
    expect(redirectsToLogin(await call("/kunden", "__Host-podo_session=abc"))).toBe(false);
  });

  it("Produktion: nur das __Host-Cookie zählt (altes podo_session → Login)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(redirectsToLogin(await call("/kunden", "podo_session=abc"))).toBe(true);
      expect(redirectsToLogin(await call("/kunden", "__Host-podo_session=abc"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("die PUBLIC-Liste des Proxys enthält nur bewusst freigegebene Präfixe", () => {
    const unexpected = proxyPublicList().filter((p) => !(p in INTENDED_PUBLIC));
    expect(unexpected).toEqual([]);
  });

  it("öffentliche Endpunkte (Webhooks, Telefonagent, Buchung …) sind ohne Cookie erreichbar", async () => {
    const blocked: string[] = [];
    for (const r of routes.filter((x) => isIntendedPublic(x.path))) {
      if (redirectsToLogin(await call(r.path))) blocked.push(`${r.path} (${r.file})`);
    }
    expect(blocked).toEqual([]);
  });

  it("Matcher: nur public/screenshots/* ist vom Proxy ausgenommen, ähnlich benannte Pfade nicht", () => {
    // Next wertet den Matcher als Pfad-Regex aus; hier wie dort vollständig verankert
    const runsProxy = (p: string) => config.matcher.some((m) => new RegExp(`^${m}$`).test(p));
    expect(runsProxy("/screenshots/a.webp")).toBe(false);
    expect(runsProxy("/screenshots/og-podohero.jpg")).toBe(false);
    expect(runsProxy("/screenshotsx")).toBe(true);
    expect(runsProxy("/screenshots")).toBe(true);
    expect(runsProxy("/kunden")).toBe(true);
    expect(runsProxy("/_next/static/chunk.js")).toBe(false);
  });
});
