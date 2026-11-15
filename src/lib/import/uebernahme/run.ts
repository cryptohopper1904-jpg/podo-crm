/**
 * Ablauf eines Übernahme-Laufs mit Datenbank (ohne Next.js-Abhängigkeiten, damit testbar):
 *
 *  - Je Praxis nur ein Lauf gleichzeitig: pg_try_advisory_xact_lock („uebernahme:<org>“) – ein zweiter Lauf
 *    (Vorschau oder Import) bricht sofort mit ImportBusyError ab, statt Speicher und CPU doppelt zu belegen (AppSec B1).
 *  - Import in zwei Schritten: (1) unter der Sperre Dateien lesen und planen, (2) die zuzuordnenden PDFs VOR der
 *    Transaktion verschlüsselt ablegen (Code-Review CR6), (3) unter der Sperre Bestand neu laden, neu planen und in
 *    EINER Transaktion schreiben. Schlägt (3) fehl, werden alle abgelegten Dateien wieder entfernt; nicht benötigte
 *    Vorab-Ablagen ebenfalls.
 *  - Vorschau-Token nur einmal einlösbar: der Lauf schreibt seinen Audit-Eintrag (mit Token-Hash) in derselben
 *    Transaktion; ein zweiter Lauf mit demselben Token findet ihn und bricht mit TokenUsedError ab.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import * as s from "@/db/schema";
import { collectFiles } from "./collect";
import { applyPlan, loadExisting, type ApplySummary } from "./persist";
import { buildPlan, type ImportPlan, type PlanOptions } from "./plan";
import type { DetectedFile, InputFile } from "./types";

export class ImportBusyError extends Error {
  constructor() {
    super("Für diese Praxis läuft gerade schon eine Übernahme. Bitte warten Sie, bis sie abgeschlossen ist, und versuchen Sie es dann erneut.");
    this.name = "ImportBusyError";
  }
}

export class TokenUsedError extends Error {
  constructor() {
    super("Diese Vorschau wurde bereits importiert. Bitte die Dateien erneut prüfen.");
    this.name = "TokenUsedError";
  }
}

export type InOrg = <T>(org: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;
export interface Stored {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
}
export interface RunDeps {
  inOrg: InOrg;
  store: (org: string, data: Buffer) => Promise<Stored>;
  discard: (storageKey: string) => Promise<void>;
}

export const RUN_ACTION = "import.uebernahme.run";

async function lock(tx: Tx, org: string) {
  const r = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext(${"uebernahme:" + org})) as ok`);
  if (!r.rows[0]?.ok) throw new ImportBusyError();
}

/** Vorschau: Dateien lesen und gegen den Bestand planen – unter der Praxis-Sperre. */
export async function previewUebernahme(deps: Pick<RunDeps, "inOrg">, org: string, files: InputFile[], opts: PlanOptions): Promise<{ detected: DetectedFile[]; plan: ImportPlan }> {
  return deps.inOrg(org, async (tx) => {
    await lock(tx, org);
    const detected = await collectFiles(files);
    const existing = await loadExisting(tx, org, pdfShas(detected));
    return { detected, plan: buildPlan(detected, existing, opts) };
  });
}

export interface RunArgs {
  org: string;
  userId: string;
  files: InputFile[];
  opts: PlanOptions;
  /** SHA-256 des Vorschau-Tokens (einmal einlösbar) */
  tokenHash: string;
  /** zusätzliche Angaben für den Audit-Eintrag (Quellen, Upload-Hash …) */
  auditMeta: Record<string, unknown>;
  ip?: string | null;
}

export async function runUebernahme(deps: RunDeps, a: RunArgs): Promise<{ summary: ApplySummary; plan: ImportPlan }> {
  // (1) lesen und planen
  const { detected, plan: first } = await previewUebernahme(deps, a.org, a.files, a.opts);
  const stored: string[] = [];
  const bySha = new Map<string, Stored>();
  const used = new Set<string>();
  try {
    // (2) PDFs vor der Transaktion ablegen (je Inhalt einmal)
    for (const d of first.documents) {
      if (bySha.has(d.sha256)) continue;
      const r = await deps.store(a.org, Buffer.from(d.data));
      stored.push(r.storageKey);
      bySha.set(d.sha256, r);
    }
    // (3) neu planen und schreiben – eine Transaktion
    const result = await deps.inOrg(a.org, async (tx) => {
      await lock(tx, a.org);
      const done = await tx
        .select({ id: s.auditLog.id })
        .from(s.auditLog)
        .where(and(eq(s.auditLog.organizationId, a.org), eq(s.auditLog.action, RUN_ACTION), sql`${s.auditLog.meta}->>'token' = ${a.tokenHash}`))
        .limit(1);
      if (done.length) throw new TokenUsedError();
      // Patientennummern-Sperre VOR dem Bestandsabgleich (gleiche Sperre wie Neuanlage und die übrigen Importe)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"pnum:" + a.org}))`);
      const existing = await loadExisting(tx, a.org, pdfShas(detected));
      const plan = buildPlan(detected, existing, a.opts);
      const summary = await applyPlan(tx, a.org, a.userId, plan, async (data, sha256) => {
        const pre = bySha.get(sha256);
        if (pre) {
          used.add(pre.storageKey);
          return pre;
        }
        // nur falls sich der Bestand zwischen (1) und (3) geändert hat
        const r = await deps.store(a.org, data);
        stored.push(r.storageKey);
        used.add(r.storageKey);
        return r;
      });
      await tx.insert(s.auditLog).values({
        organizationId: a.org,
        userId: a.userId,
        action: RUN_ACTION,
        ip: a.ip ?? null,
        meta: {
          ...a.auditMeta,
          token: a.tokenHash,
          prescriptionMode: a.opts.prescriptionMode,
          patientsCreated: summary.patientsCreated,
          patientsLinked: summary.patientsLinked,
          appointments: summary.appointments,
          prescriptions: summary.prescriptions,
          documents: summary.documents,
          excel: summary.excel,
          skipped: {
            patients: plan.totals.patientsExisting,
            erased: plan.totals.patientsErased,
            appointments: plan.totals.appointmentsExisting + plan.totals.appointmentsUnassigned,
            prescriptions: plan.totals.prescriptionsExisting + plan.totals.prescriptionsUnassigned,
            documents: plan.totals.documentsExisting + plan.totals.documentsUnassigned,
          },
        },
      });
      return { summary, plan };
    });
    // nicht benötigte Vorab-Ablagen entfernen
    for (const k of stored) if (!used.has(k)) await deps.discard(k).catch(() => {});
    return result;
  } catch (e) {
    // keine verwaisten verschlüsselten Dateien ohne DB-Eintrag
    for (const k of stored) await deps.discard(k).catch(() => {});
    throw e;
  }
}

const pdfShas = (detected: DetectedFile[]) => detected.filter((d) => d.kind === "pdf").map((d) => d.sha256);
