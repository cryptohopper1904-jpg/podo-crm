import "server-only";
import { and, count, eq, isNull } from "drizzle-orm";
import type { Tx } from "@/db";
import { organizations, patients } from "@/db/schema";
import { patientLimit, patientLimitProblem } from "@/lib/plans";

/** Grenze des Tarifs überschritten (Kostenlos: höchstens 20 aktive Patient:innen). Meldung ist für die Oberfläche gedacht. */
export class PatientLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatientLimitError";
  }
}

/**
 * Anzahl Patient:innen für die Tarif-Grenze: auch archivierte (sonst ließe sich die Grenze durch Archivieren umgehen),
 * nur gelöschte (Kontaktdaten gelöscht, src/server/patient-deletion.ts) zählen nicht.
 */
export async function countedPatients(tx: Tx, org: string): Promise<number> {
  const [r] = await tx.select({ n: count() }).from(patients).where(and(eq(patients.organizationId, org), isNull(patients.contactErasedAt)));
  return Number(r?.n ?? 0);
}

/**
 * Prüft vor dem Anlegen von `adding` Patient:innen die Tarif-Grenze. Aufrufen INNERHALB der Transaktion und NACH der
 * Sperre für Patientennummern (pg_advisory_xact_lock „pnum:“), damit parallele Anlagen die Grenze nicht umgehen.
 */
export async function assertPatientCapacity(tx: Tx, org: string, adding = 1): Promise<void> {
  if (adding <= 0) return;
  const [o] = await tx.select({ plan: organizations.plan }).from(organizations).where(eq(organizations.id, org));
  if (!o || !Number.isFinite(patientLimit(o))) return;
  const problem = patientLimitProblem(o, await countedPatients(tx, org), adding);
  if (problem) throw new PatientLimitError(problem);
}

/** Kurzinfo für Oberflächen (z. B. Patientenliste): null bei unbegrenztem Tarif */
export async function patientQuota(tx: Tx, org: string): Promise<{ used: number; limit: number } | null> {
  const [o] = await tx.select({ plan: organizations.plan }).from(organizations).where(eq(organizations.id, org));
  if (!o) return null;
  const limit = patientLimit(o);
  if (!Number.isFinite(limit)) return null;
  return { used: await countedPatients(tx, org), limit };
}
