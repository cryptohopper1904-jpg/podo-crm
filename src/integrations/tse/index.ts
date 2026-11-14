/**
 * Auswahl des TSE-Adapters. Solange kein zertifizierter TSE-Vertrag besteht, läuft immer der Mock
 * (Test-Signaturen, deutlich als „test“ markiert). fiskaly wird nur mit TSE_PROVIDER=fiskaly verwendet
 * und meldet ohne Zugangsdaten „TSE nicht konfiguriert“.
 *
 * Konfiguration (Umgebung, später pro Mandant in integration_connections – siehe docs/SCHEMA_REQUESTS.md):
 *   TSE_PROVIDER=mock|fiskaly, FISKALY_API_KEY, FISKALY_API_SECRET, FISKALY_TSS_ID, FISKALY_CLIENT_ID
 *   TSE_LIVE_FREIGABE_FORDERUNGSAUFLOESUNG=1 – Freigabe des Echtbetriebs (siehe fiscalLiveBlockedReason)
 */
import { FiskalyAdapter } from "./fiskaly";
import { FiscalMock } from "./mock";
import type { FiscalPort } from "./types";

export * from "./types";
export { FiscalMock } from "./mock";
export { FiskalyAdapter } from "./fiskaly";

/**
 * Riegel vor dem Echtbetrieb (Buchhaltungs-Review PR #81, H1): Zahlungen auf bereits ausgestellte Rechnungen werden in
 * TSE/DSFinV-K derzeit als „Umsatz“ mit Steuersatz erfasst, nicht als Forderungsauflösung (USt-Schlüssel 5). Bis das
 * mit der Steuerberatung geklärt und umgesetzt ist, bleibt die echte TSE (fiskaly) gesperrt – auch wenn
 * TSE_PROVIDER=fiskaly gesetzt ist –, solange die Freigabe nicht ausdrücklich erteilt ist.
 */
export const TSE_LIVE_RELEASE_ENV = "TSE_LIVE_FREIGABE_FORDERUNGSAUFLOESUNG";

type Env = Record<string, string | undefined>;

/** echte TSE angefordert (Konfiguration) */
const liveRequested = (env: Env) => env.TSE_PROVIDER === "fiskaly" && env.INTEGRATIONS_MODE !== "mock";

/** Grund, warum die angeforderte echte TSE nicht aktiviert wird (null = nicht angefordert oder freigegeben). */
export function fiscalLiveBlockedReason(env: Env = process.env): string | null {
  if (!liveRequested(env) || env[TSE_LIVE_RELEASE_ENV] === "1") return null;
  return (
    "Die echte TSE (fiskaly) ist konfiguriert, aber noch nicht freigegeben: Zahlungen auf bereits ausgestellte Rechnungen " +
    "werden derzeit als Umsatz erfasst (nicht als Forderungsauflösung). Vor dem Echtbetrieb mit der Steuerberatung abstimmen; " +
    `danach schaltet der Betreiber die Freigabe mit ${TSE_LIVE_RELEASE_ENV}=1 frei. Bis dahin läuft die Kasse im Testmodus.`
  );
}

const liveActive = (env: Env) => liveRequested(env) && !fiscalLiveBlockedReason(env);

export function getFiscalPort(env: Env = process.env): FiscalPort {
  if (liveActive(env)) {
    return new FiskalyAdapter({
      apiKey: env.FISKALY_API_KEY,
      apiSecret: env.FISKALY_API_SECRET,
      tssId: env.FISKALY_TSS_ID,
      clientId: env.FISKALY_CLIENT_ID,
    });
  }
  return new FiscalMock();
}

/** true, solange keine echte TSE angebunden (oder sie noch gesperrt) ist (UI-Warnung). */
export const fiscalIsTestMode = (env: Env = process.env) => !liveActive(env);
