import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { withOrg } from "@/db";
import { integrationConnections, syncLog } from "@/db/schema";
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

/** Adapter für den Mandanten (Mock bei INTEGRATIONS_MODE=mock oder Status „mock“). */
export async function adapterFor<P extends SupportedProvider>(organizationId: string, provider: P): Promise<PortByProvider[P]> {
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
