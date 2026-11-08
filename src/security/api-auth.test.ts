/**
 * Jede Route-Handler-Datei (src/app/**\/route.ts) muss getAuth/requireAuth verwenden ODER in der
 * expliziten Liste öffentlicher Handler stehen – mit einem Nachweis der eigenen Absicherung
 * (Signatur, Token, Secret). Neue ungeschützte Handler lassen diesen Test fehlschlagen.
 */
import { describe, expect, it } from "vitest";
import { appRoutes, read, ROOT } from "./app-files";
import path from "node:path";

const AUTH = /\b(getAuth|requireAuth)\s*\(/;

/** Datei → [Begründung, Muster, das die eigene Absicherung belegt] */
export const PUBLIC_HANDLERS: Record<string, [string, RegExp]> = {
  "src/app/api/webhooks/[provider]/route.ts": ["Webhooks: HMAC-Signatur bzw. Token je Praxis", /verifyHmacSignature[\s\S]*safeEqual/],
  "src/app/api/voice/[provider]/route.ts": ["KI-Telefonagent: x-vapi-secret je Praxis", /\.verify\(/],
  "src/app/api/billing/webhook/route.ts": ["Stripe-Webhook: Stripe-Signature", /verifyWebhook\(/],
  "src/app/api/cron/reminders/route.ts": ["Cron: Bearer CRON_SECRET", /safeEqual\([^)]*secret/],
  "src/app/api/cron/kim/route.ts": ["Cron KIM-Abruf: Bearer CRON_SECRET", /safeEqual\([^)]*secret/],
  "src/app/api/health/route.ts": ["Health-Check ohne Daten", /./],
  "src/app/api/calendar/[token]/route.ts": ["iCal-Feed: signiertes Token", /verifyCalendarToken\(/],
  "src/app/portal/[token]/route.ts": ["Portal-Einstieg: Token + Rate-Limit", /resolvePortalLink\(/],
  "src/app/portal/rechnung/[id]/route.ts": ["Portal-Rechnung: Portal-Sitzung (Cookie)", /currentPortalLink\(/],
};

describe("API-Routen: Authentisierung", () => {
  const handlers = appRoutes().filter((r) => r.kind === "route");

  it("jeder Handler nutzt getAuth/requireAuth oder ist bewusst öffentlich", () => {
    const unprotected = handlers.filter((h) => !AUTH.test(read(path.join(ROOT, h.file))) && !(h.file in PUBLIC_HANDLERS)).map((h) => h.file);
    expect(unprotected).toEqual([]);
  });

  it("öffentliche Handler belegen ihre eigene Absicherung", () => {
    const missing = Object.entries(PUBLIC_HANDLERS)
      .filter(([f]) => handlers.some((h) => h.file === f))
      .filter(([f, [, proof]]) => !proof.test(read(path.join(ROOT, f))))
      .map(([f]) => f);
    expect(missing).toEqual([]);
  });

  it("Allowlist enthält keine Leichen", () => {
    const stale = Object.keys(PUBLIC_HANDLERS).filter((f) => !handlers.some((h) => h.file === f) && f !== "src/app/api/billing/webhook/route.ts");
    expect(stale).toEqual([]);
  });

  it("öffentliche Handler antworten bei fehlender Prüfung nicht mit Daten (fail closed: 401/503 im Code)", () => {
    for (const f of ["src/app/api/webhooks/[provider]/route.ts", "src/app/api/voice/[provider]/route.ts", "src/app/api/cron/reminders/route.ts", "src/app/api/cron/kim/route.ts"]) {
      expect(read(path.join(ROOT, f)), f).toMatch(/status:\s*(401|503)/);
    }
  });
});
