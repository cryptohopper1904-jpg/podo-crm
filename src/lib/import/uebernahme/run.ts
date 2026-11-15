/**
 * Ablauf eines Übernahme-Laufs mit Datenbank (ohne Next.js-Abhängigkeiten, damit testbar):
 *
 *  - Prozessweit nur ein Lauf gleichzeitig (Semaphore, AppSec Runde 2 A-B1): Entpacken, Parsen und Planen belegen
 *    Speicher und CPU – ein zweiter Lauf (auch einer anderen Praxis) bricht sofort mit ServerBusyError ab.
 *  - Je Praxis nur ein Lauf gleichzeitig: pg_try_advisory_xact_lock („uebernahme:<org>“) beim Laden des Bestands und
 *    beim Schreiben – ein zweiter Lauf bricht mit ImportBusyError ab.
 *  - Parsen und Planen laufen AUSSERHALB jeder DB-Transaktion (A-B1): Die Transaktionen laden nur den Bestand bzw.
 *    schreiben den fertigen Plan.
 *  - Import: (1) Dateien lesen, Bestand laden (kurze Transaktion), planen; (2) die zuzuordnenden PDFs VOR der
 *    Transaktion verschlüsselt ablegen (Code-Review CR6); (3) in EINER Transaktion: Sperre, Einmal-Token prüfen, Bestand
 *    neu laden und mit (1) vergleichen (Fingerabdruck) – hat er sich geändert, Abbruch mit „bitte erneut prüfen“ –,
 *    dann den Plan aus (1) schreiben. Schlägt (3) fehl, werden alle abgelegten Dateien wieder entfernt.
 *  - Vorschau-Token nur einmal einlösbar: der Lauf schreibt seinen Audit-Eintrag (mit Token-Hash) in derselben
 *    Transaktion; ein zweiter Lauf mit demselben Token findet ihn (Tokens gelten 15 Minuten, gesucht wird in den
 *    letzten 20 Minuten) und bricht mit TokenUsedError ab.
 *  - Dieselbe Bestandsperson für zwei Zeilen gewählt (S4): Import abgelehnt (ChoiceConflictError mit allen Nummern),
 *    nichts gespeichert.
 *  - Zeitgrenzen (AppSec H1): Schreib-Transaktion mit SET LOCAL lock_timeout/statement_timeout, jede Dokument-Ablage
 *    mit Zeitgrenze und alle Ablagen eines Laufs zusammen mit einer Gesamt-Zeitgrenze (StoreTimeoutError) – bei
 *    Überschreitung wird nichts gespeichert; eine verspätet doch fertige Ablage wird wieder entfernt.
 */
import { createHash } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import * as s from "@/db/schema";
import { collectFiles } from "./collect";
import { applyPlan, loadExisting, type ApplySummary } from "./persist";
import { buildPlan, choiceConflictsMessage, type ExistingSnapshot, type ImportPlan, type PlanOptions } from "./plan";
import type { DetectedFile, InputFile } from "./types";

export class ImportBusyError extends Error {
  constructor(message = "Für diese Praxis läuft gerade schon eine Übernahme. Bitte warten Sie, bis sie abgeschlossen ist, und versuchen Sie es dann erneut.") {
    super(message);
    this.name = "ImportBusyError";
  }
}

/** Prozessweite Grenze: ein Lauf gleichzeitig (Unterklasse von ImportBusyError, gleiche Behandlung in der Action) */
export class ServerBusyError extends ImportBusyError {
  constructor() {
    super("Gerade läuft bereits eine andere Datenübernahme. Bitte versuchen Sie es in einigen Minuten erneut.");
    this.name = "ServerBusyError";
  }
}

export class TokenUsedError extends Error {
  constructor() {
    super("Diese Vorschau wurde bereits importiert. Bitte die Dateien erneut prüfen.");
    this.name = "TokenUsedError";
  }
}

export class StaleSnapshotError extends Error {
  constructor() {
    super("Der Bestand hat sich seit der Prüfung geändert (z. B. neue Patient:innen). Es wurde nichts gespeichert – bitte erneut prüfen und importieren.");
    this.name = "StaleSnapshotError";
  }
}

export class ChoiceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChoiceConflictError";
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
  /** Zeitgrenze je Dokument-Ablage (Standard STORE_TIMEOUT_MS; Tests kürzer) */
  storeTimeoutMs?: number;
  /** Gesamt-Zeitgrenze für alle Ablagen eines Laufs (Standard STORE_TOTAL_TIMEOUT_MS; Tests kürzer) */
  storeTotalTimeoutMs?: number;
}

export const RUN_ACTION = "import.uebernahme.run";

/** Zeitgrenzen der Schreib-Transaktion (AppSec H1) und je Dokument-Ablage */
export const TX_LOCK_TIMEOUT = "10s";
export const TX_STATEMENT_TIMEOUT = "120s";
export const STORE_TIMEOUT_MS = 60_000;
export const STORE_TOTAL_TIMEOUT_MS = 10 * 60_000;

export class StoreTimeoutError extends Error {
  constructor() {
    super("Das Ablegen der Dokumente dauert zu lange. Es wurde nichts gespeichert – bitte versuchen Sie es später erneut.");
    this.name = "StoreTimeoutError";
  }
}

/** Zeitüberschreitung der Datenbank (lock_timeout 55P03, statement_timeout 57014) – auch in der Hülle von Drizzle */
export function isDbTimeout(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  const code = err?.code ?? err?.cause?.code;
  return code === "55P03" || code === "57014";
}
export const DB_TIMEOUT_MESSAGE = "Die Datenbank ist gerade ausgelastet. Es wurde nichts gespeichert – bitte versuchen Sie es in einigen Minuten erneut.";

/**
 * Promise mit Zeitgrenze; `onLate` räumt ein Ergebnis auf, das erst NACH der Zeitüberschreitung fertig wird (z. B.
 * verspätet doch abgelegte Datei wieder entfernen) – Fehler dabei werden verschluckt. Exportiert nur für Tests.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, onLate?: (late: T) => unknown): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      p,
      new Promise<never>(
        (_, reject) =>
          (timer = setTimeout(() => {
            timedOut = true;
            reject(new StoreTimeoutError());
          }, ms)),
      ),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut && onLate) p.then(onLate).catch(() => {});
  }
}

/** Prozessweite Semaphore (ein Lauf gleichzeitig). Exportiert nur für Tests. */
let running = false;
export async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (running) throw new ServerBusyError();
  running = true;
  try {
    return await fn();
  } finally {
    running = false;
  }
}

async function lock(tx: Tx, org: string) {
  const r = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext(${"uebernahme:" + org})) as ok`);
  if (!r.rows[0]?.ok) throw new ImportBusyError();
}

/** Fingerabdruck des Bestands (Reihenfolge-unabhängig) – erkennt Änderungen zwischen Planung und Schreiben. */
export function snapshotFingerprint(e: ExistingSnapshot): string {
  const h = createHash("sha256");
  const sorted = <T>(list: T[], key: (x: T) => string) => list.map((x) => [key(x), x] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [, p] of sorted(e.patients, (p) => p.id)) {
    h.update(JSON.stringify([p.id, p.number, p.firstName, p.lastName, p.birthDate, p.email, p.phoneMobile, !!p.erased, Object.entries(p.externalIds).sort()]));
    h.update("\n");
  }
  for (const set of [e.appointmentRefs, e.prescriptionRefs, e.documentHashes]) h.update(JSON.stringify([...set].sort()));
  for (const list of [e.therapists, e.locations, e.services] as { id: string }[][]) h.update(JSON.stringify(sorted(list, (x) => x.id).map(([, x]) => x)));
  return h.digest("hex");
}

/** Bestand in einer kurzen Transaktion laden (unter der Praxis-Sperre). */
function loadSnapshot(deps: Pick<RunDeps, "inOrg">, org: string, detected: DetectedFile[]) {
  return deps.inOrg(org, async (tx) => {
    await lock(tx, org);
    return loadExisting(tx, org, pdfShas(detected));
  });
}

async function previewInner(deps: Pick<RunDeps, "inOrg">, org: string, files: InputFile[], opts: PlanOptions) {
  const detected = await collectFiles(files);
  const existing = await loadSnapshot(deps, org, detected);
  return { detected, existing, plan: buildPlan(detected, existing, opts) };
}

/** Vorschau: Dateien lesen und gegen den Bestand planen (Parsen/Planen außerhalb der Transaktion). */
export async function previewUebernahme(deps: Pick<RunDeps, "inOrg">, org: string, files: InputFile[], opts: PlanOptions): Promise<{ detected: DetectedFile[]; plan: ImportPlan }> {
  return exclusive(async () => {
    const { detected, plan } = await previewInner(deps, org, files, opts);
    return { detected, plan };
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
  return exclusive(() => runInner(deps, a));
}

async function runInner(deps: RunDeps, a: RunArgs): Promise<{ summary: ApplySummary; plan: ImportPlan }> {
  // (1) lesen, Bestand laden, planen – außerhalb der Schreib-Transaktion
  const { detected, existing: first, plan } = await previewInner(deps, a.org, a.files, a.opts);
  if (plan.conflicts.length) throw new ChoiceConflictError(choiceConflictsMessage(plan.conflicts));
  const fingerprint = snapshotFingerprint(first);
  const stored: string[] = [];
  const bySha = new Map<string, Stored>();
  const used = new Set<string>();
  try {
    // (2) PDFs vor der Transaktion ablegen (je Inhalt einmal) – je Ablage und insgesamt mit Zeitgrenze
    const perStore = deps.storeTimeoutMs ?? STORE_TIMEOUT_MS;
    const deadline = Date.now() + (deps.storeTotalTimeoutMs ?? STORE_TOTAL_TIMEOUT_MS);
    for (const d of plan.documents) {
      if (bySha.has(d.sha256)) continue;
      const left = deadline - Date.now();
      if (left <= 0) throw new StoreTimeoutError();
      const r = await withTimeout(deps.store(a.org, Buffer.from(d.data)), Math.min(perStore, left), (late) => deps.discard(late.storageKey));
      stored.push(r.storageKey);
      bySha.set(d.sha256, r);
    }
    // (3) prüfen und schreiben – eine Transaktion, ohne Parsen/Planen
    const summary = await deps.inOrg(a.org, async (tx) => {
      // Zeitgrenzen nur für diese Transaktion (AppSec H1): nicht unbegrenzt auf Sperren warten bzw. schreiben
      await tx.execute(sql.raw(`set local lock_timeout = '${TX_LOCK_TIMEOUT}'`));
      await tx.execute(sql.raw(`set local statement_timeout = '${TX_STATEMENT_TIMEOUT}'`));
      await lock(tx, a.org);
      const done = await tx
        .select({ id: s.auditLog.id })
        .from(s.auditLog)
        .where(
          and(
            eq(s.auditLog.organizationId, a.org),
            eq(s.auditLog.action, RUN_ACTION),
            // Tokens gelten 15 Minuten – nur dieser Zeitraum (mit Puffer) muss durchsucht werden (A-H1, Index audit_org_time)
            gt(s.auditLog.at, sql`now() - interval '20 minutes'`),
            sql`${s.auditLog.meta}->>'token' = ${a.tokenHash}`,
          ),
        )
        .limit(1);
      if (done.length) throw new TokenUsedError();
      // Patientennummern-Sperre VOR dem Bestandsabgleich (gleiche Sperre wie Neuanlage und die übrigen Importe)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"pnum:" + a.org}))`);
      const now = await loadExisting(tx, a.org, pdfShas(detected));
      if (snapshotFingerprint(now) !== fingerprint) throw new StaleSnapshotError();
      const summary = await applyPlan(tx, a.org, a.userId, plan, async (_data, sha256) => {
        const pre = bySha.get(sha256);
        if (!pre) throw new Error("Dokument wurde nicht vorab abgelegt.");
        used.add(pre.storageKey);
        return pre;
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
      return summary;
    });
    // nicht benötigte Vorab-Ablagen entfernen
    for (const k of stored) if (!used.has(k)) await deps.discard(k).catch(() => {});
    return { summary, plan };
  } catch (e) {
    // keine verwaisten verschlüsselten Dateien ohne DB-Eintrag
    for (const k of stored) await deps.discard(k).catch(() => {});
    throw e;
  }
}

const pdfShas = (detected: DetectedFile[]) => detected.filter((d) => d.kind === "pdf").map((d) => d.sha256);
