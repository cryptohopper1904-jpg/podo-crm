/**
 * „Verbindung testen“: baut den Adapter über die Registry und führt – wo möglich – einen
 * harmlosen Lese-Aufruf aus (keine Patientendaten).
 * `message` ist für die Oberfläche (generisch), `detail` nur fürs Sync-Protokoll (ohne Antwort-Bodies).
 */
import { IntegrationHttpError, IntegrationNotConfiguredError } from "./errors";
import { LexofficeAdapter } from "./lexoffice/lexoffice";
import { UnsafeTargetError } from "./net-guard";
import { KIM_CONNECTION_PROVIDER } from "./kim/provider";
import { Pop3Error } from "./kim/pop3";
import { getAdapter, getKimAdapter, type RegistryOptions } from "./registry";
import { SumupAdapter } from "./sumup/sumup";
import type { IntegrationConnection, ProviderId, SupportedProvider } from "./types";

export interface TestResult {
  ok: boolean;
  message: string;
  detail: string;
}

/** Fehler → kurze Beschreibung ohne Upstream-Inhalte oder Geheimnisse. */
export function describeError(e: unknown): string {
  if (e instanceof IntegrationHttpError) return `${e.provider}: HTTP ${e.status}`;
  if (e instanceof IntegrationNotConfiguredError || e instanceof UnsafeTargetError) return e.message.slice(0, 200);
  // POP3/SMTP: eigene, geheimnisfreie Meldung (Serverantwort wird nicht übernommen)
  if (e instanceof Pop3Error || (e instanceof Error && e.name === "SmtpError")) return `${e.name}: ${e.message}`.slice(0, 200);
  if (e instanceof Error) {
    const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
    return `${e.name}${code ? ` (${code})` : ""}`;
  }
  return "Unbekannter Fehler";
}

export async function testConnection(
  provider: ProviderId,
  connection: IntegrationConnection | null,
  opts: RegistryOptions = {},
): Promise<TestResult> {
  try {
    if (provider === KIM_CONNECTION_PROVIDER) {
      // KIM: Anmeldung am POP3-Postfach des Clientmoduls, Nachrichten werden nur gezählt
      const kim = getKimAdapter(connection, opts);
      if (kim.isMock) return { ok: true, message: "KIM im Testmodus – es werden Beispielnachrichten verwendet, keine Verbindung zur TI.", detail: "Testmodus" };
      const { messages } = await kim.ping();
      return { ok: true, message: `KIM-Postfach erreichbar (${messages} Nachricht(en) auf dem Server).`, detail: "POP3-Anmeldung erfolgreich" };
    }
    const adapter = getAdapter(provider as SupportedProvider, connection, opts);
    if (adapter.isMock) return { ok: true, message: "Testmodus aktiv – es werden keine echten Daten übertragen.", detail: "Testmodus" };
    if (adapter instanceof LexofficeAdapter || adapter instanceof SumupAdapter) {
      await adapter.ping();
      return { ok: true, message: "Verbindung erfolgreich.", detail: "Lese-Test erfolgreich" };
    }
    if (provider === "llm") {
      await getAdapter("llm", connection, opts).suggestReply("Verbindungstest, bitte mit „OK“ antworten.");
      return { ok: true, message: "Verbindung erfolgreich.", detail: "LLM antwortet" };
    }
    return { ok: true, message: "Konfiguration vollständig (für diesen Anbieter gibt es noch keinen Live-Test).", detail: "nur Konfiguration geprüft" };
  } catch (e) {
    const detail = describeError(e);
    const message =
      e instanceof IntegrationNotConfiguredError
        ? "Nicht vollständig konfiguriert."
        : e instanceof UnsafeTargetError
          ? "Ziel-Adresse nicht erlaubt."
          : "Verbindung fehlgeschlagen.";
    return { ok: false, message: `${message} Details im Synchronisationsprotokoll.`, detail };
  }
}
