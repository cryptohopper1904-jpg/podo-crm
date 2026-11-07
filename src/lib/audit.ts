import "server-only";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { requestMeta } from "@/lib/auth/session";

/**
 * Audit-Log: protokolliert Zugriffe auf Gesundheitsdaten (Lesen und Schreiben),
 * Logins, Exporte und Einstellungsänderungen. Die Tabelle ist per Trigger unveränderbar.
 * Bewusst im API-Layer (nicht per DB-Trigger), damit auch Lesezugriffe erfasst werden.
 */
export async function audit(entry: {
  organizationId?: string | null;
  userId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
}) {
  let ip: string | null = null;
  try {
    ip = (await requestMeta()).ip;
  } catch {
    // außerhalb eines Requests (Skripte, Jobs)
  }
  await db.insert(auditLog).values({
    organizationId: entry.organizationId ?? null,
    userId: entry.userId ?? null,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    meta: entry.meta,
    ip,
  });
}
