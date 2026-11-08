/**
 * Auswahl des TSE-Adapters. Solange kein zertifizierter TSE-Vertrag besteht, läuft immer der Mock
 * (Test-Signaturen, deutlich als „test“ markiert). fiskaly wird nur mit TSE_PROVIDER=fiskaly verwendet
 * und meldet ohne Zugangsdaten „TSE nicht konfiguriert“.
 *
 * Konfiguration (Umgebung, später pro Mandant in integration_connections – siehe docs/SCHEMA_REQUESTS.md):
 *   TSE_PROVIDER=mock|fiskaly, FISKALY_API_KEY, FISKALY_API_SECRET, FISKALY_TSS_ID, FISKALY_CLIENT_ID
 */
import { FiskalyAdapter } from "./fiskaly";
import { FiscalMock } from "./mock";
import type { FiscalPort } from "./types";

export * from "./types";
export { FiscalMock } from "./mock";
export { FiskalyAdapter } from "./fiskaly";

export function getFiscalPort(env: Record<string, string | undefined> = process.env): FiscalPort {
  if (env.TSE_PROVIDER === "fiskaly" && env.INTEGRATIONS_MODE !== "mock") {
    return new FiskalyAdapter({
      apiKey: env.FISKALY_API_KEY,
      apiSecret: env.FISKALY_API_SECRET,
      tssId: env.FISKALY_TSS_ID,
      clientId: env.FISKALY_CLIENT_ID,
    });
  }
  return new FiscalMock();
}

/** true, solange keine echte TSE angebunden ist (UI-Warnung). */
export const fiscalIsTestMode = (env: Record<string, string | undefined> = process.env) => !(env.TSE_PROVIDER === "fiskaly" && env.INTEGRATIONS_MODE !== "mock");
