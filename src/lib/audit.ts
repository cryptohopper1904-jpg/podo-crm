import "server-only";
import { db, type Tx } from "@/db";
import { auditLog } from "@/db/schema";
import { requestMeta } from "@/lib/auth/session";

/**
 * Audit-Log: protokolliert Zugriffe auf Gesundheitsdaten (Lesen und Schreiben),
 * Logins, Exporte und Einstellungsänderungen. Die Tabelle ist per Trigger unveränderbar.
 * Bewusst im API-Layer (nicht per DB-Trigger), damit auch Lesezugriffe erfasst werden.
 * Mit `tx` wird der Eintrag in derselben Transaktion geschrieben (z. B. Kasse: Fiskaldaten nie ohne Audit-Eintrag).
 */
export async function audit(entry: {
  organizationId?: string | null;
  userId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
}, tx?: Tx) {
  let ip: string | null = null;
  try {
    ip = (await requestMeta()).ip;
  } catch {
    // außerhalb eines Requests (Skripte, Jobs)
  }
  await (tx ?? db).insert(auditLog).values({
    organizationId: entry.organizationId ?? null,
    userId: entry.userId ?? null,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    meta: entry.meta,
    ip,
  });
}
