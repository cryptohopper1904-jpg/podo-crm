/**
 * „Verbindung testen“: baut den Adapter über die Registry und führt – wo möglich – einen
 * harmlosen Lese-Aufruf aus (keine Patientendaten).
 */
import { IntegrationNotConfiguredError } from "./errors";
import { LexofficeAdapter } from "./lexoffice/lexoffice";
import { getAdapter, type RegistryOptions } from "./registry";
import { SumupAdapter } from "./sumup/sumup";
import type { IntegrationConnection, SupportedProvider } from "./types";

export async function testConnection(
  provider: SupportedProvider,
  connection: IntegrationConnection | null,
  opts: RegistryOptions = {},
): Promise<{ ok: boolean; message: string }> {
  try {
    const adapter = getAdapter(provider, connection, opts);
    if (adapter.isMock) return { ok: true, message: "Testmodus aktiv – es werden keine echten Daten übertragen." };
    if (adapter instanceof LexofficeAdapter) return { ok: true, message: `Verbunden mit „${await adapter.ping()}“.` };
    if (adapter instanceof SumupAdapter) return { ok: true, message: `Verbunden mit „${await adapter.ping()}“.` };
    if (provider === "llm") {
      await getAdapter("llm", connection, opts).suggestReply("Verbindungstest, bitte mit „OK“ antworten.");
      return { ok: true, message: "LLM antwortet." };
    }
    return { ok: true, message: "Konfiguration vollständig (für diesen Anbieter gibt es noch keinen Live-Test)." };
  } catch (e) {
    if (e instanceof IntegrationNotConfiguredError) return { ok: false, message: e.message };
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 300) : "Unbekannter Fehler" };
  }
}
