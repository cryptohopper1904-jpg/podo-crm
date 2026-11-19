import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { withOrg } from "@/db";
import { integrationConnections, syncLog } from "@/db/schema";
import { aiApprovalValid } from "@/integrations/ai-approval";
import { getAdapter } from "@/integrations/registry";
import type { IntegrationConnection, PortByProvider, ProviderId, SupportedProvider } from "@/integrations/types";

/** Lädt die Verbindung eines Mandanten (Geheimnis bleibt verschlüsselt; die Registry entschlüsselt mit AAD = Mandant). */
export async function loadConnection(organizationId: string, provider: ProviderId): Promise<IntegrationConnection | null> {
  const [row] = await withOrg(organizationId, (tx) =>
    tx
      .select()
      .from(integrationConnections)
      .where(and(eq(integrationConnections.organizationId, organizationId), eq(integrationConnections.provider, provider))),
  );
  if (!row) return null;
  return { provider: row.provider, status: row.status, config: row.config, secretEnc: row.secretEnc, organizationId };
}

/**
 * Adapter für den Mandanten (Mock bei INTEGRATIONS_MODE=mock oder Status „mock“).
 * E-Mail („email_imap“) läuft über den MailPort (SMTP der Praxis bzw. Plattform-SMTP, Drosselung, Audit),
 * siehe ./mail – dynamisch importiert, weil ./mail seinerseits loadConnection/logSync nutzt.
 */
export async function adapterFor<P extends SupportedProvider>(organizationId: string, provider: P): Promise<PortByProvider[P]> {
  if (provider === "email_imap") return (await (await import("./mail")).mailMessagingPort(organizationId)) as PortByProvider[P];
  return getAdapter(provider, await loadConnection(organizationId, provider));
}

export async function logSync(
  organizationId: string,
  provider: ProviderId,
  entry: { direction: "in" | "out" | "test"; ok: boolean; message?: string; entity?: string; entityId?: string },
) {
  await withOrg(organizationId, (tx) =>
    tx.insert(syncLog).values({
      organizationId,
      provider,
      direction: entry.direction,
      ok: entry.ok,
      message: entry.message?.slice(0, 500),
      entity: entry.entity,
      entityId: entry.entityId,
    }),
  );
}

export async function recentSyncLog(organizationId: string, limit = 20) {
  return withOrg(organizationId, (tx) =>
    tx.select().from(syncLog).where(eq(syncLog.organizationId, organizationId)).orderBy(desc(syncLog.at)).limit(limit),
  );
}

/**
 * Freigabe für Gesundheitsdaten: je Mandant als Bestätigung der Inhaber:in (Zeitpunkt, Benutzer, Ziel) in der
 * Verbindungs-Config (src/integrations/ai-approval.ts). Die env-Freigabe LLM_/TRANSCRIPTION_DATA_PROCESSING_APPROVED=true
 * ist eine Erklärung des Betreibers und gilt NUR für den env-konfigurierten Plattform-Anbieter – nicht, wenn die Praxis
 * eine eigene Basis-URL eingetragen hat (Verbindung nicht „aus“).
 */
export async function processingApproved(organizationId: string, provider: "llm" | "transcription"): Promise<boolean> {
  const conn = await loadConnection(organizationId, provider);
  if (aiApprovalValid(conn?.config) && conn?.status === "connected") return true;
  const env = provider === "llm" ? process.env.LLM_DATA_PROCESSING_APPROVED : process.env.TRANSCRIPTION_DATA_PROCESSING_APPROVED;
  const practiceTarget = !!conn && conn.status !== "disconnected" && typeof conn.config?.baseUrl === "string" && !!conn.config.baseUrl;
  return env === "true" && !practiceTarget;
}
