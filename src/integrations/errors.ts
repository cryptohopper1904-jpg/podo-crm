import type { ProviderId } from "./types";

/** Integration ist nicht eingerichtet (fehlender Schlüssel/Config) oder noch nicht implementiert. */
export class IntegrationNotConfiguredError extends Error {
  constructor(
    public readonly provider: ProviderId,
    detail?: string,
    public readonly docs?: string,
  ) {
    super(
      `Integration „${provider}“ ist nicht konfiguriert${detail ? `: ${detail}` : "."}${docs ? ` Doku: ${docs}` : ""}`,
    );
    this.name = "IntegrationNotConfiguredError";
  }
}

/** HTTP-Fehler eines Fremdsystems (Antworttext gekürzt, ohne Geheimnisse). */
export class IntegrationHttpError extends Error {
  constructor(
    public readonly provider: ProviderId,
    public readonly status: number,
    public readonly body: string,
    method: string,
    path: string,
  ) {
    super(`${provider}: ${method} ${path} fehlgeschlagen (HTTP ${status}): ${body.slice(0, 300)}`);
    this.name = "IntegrationHttpError";
  }
}
