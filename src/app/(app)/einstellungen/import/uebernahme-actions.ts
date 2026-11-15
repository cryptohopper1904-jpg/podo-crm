"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { withOrg } from "@/db";
import { audit } from "@/lib/audit";
import { denyAccess, requireAuth } from "@/lib/auth/session";
import { collectFiles, MAX_UPLOAD_FILES } from "@/lib/import/uebernahme/collect";
import { applyPlan, loadExisting, type ApplySummary } from "@/lib/import/uebernahme/persist";
import { buildPlan, type FileSummary, type ImportPlan, type PlanTotals } from "@/lib/import/uebernahme/plan";
import type { InputFile, PrescriptionMode } from "@/lib/import/uebernahme/types";
import { signPreviewToken, verifyPreviewToken } from "@/lib/preview-token";
import { discardStored, storeEncrypted } from "@/lib/storage";
import { PatientLimitError } from "@/server/patient-limit";

/**
 * Übernahme-Assistent (Einstellungen → Import → Daten übernehmen).
 * Dateien werden nur im Arbeitsspeicher verarbeitet; nur zugeordnete PDFs werden beim Import verschlüsselt abgelegt
 * (wie Uploads in der Akte). Ablauf wie die übrigen Importe: „Prüfen“ (Vorschau + signiertes Token, gebunden an genau
 * diese Dateien, Praxis, Person und Optionen) → „Import ausführen“ mit denselben Dateien.
 */
export interface UebernahmePreview {
  files: FileSummary[];
  totals: PlanTotals;
  warnings: { file?: string; row?: number; message: string }[];
  warningsTotal: number;
  samples: ImportPlan["samples"];
  cashbook: ImportPlan["cashbook"];
  hasWork: boolean;
}

export type UebernahmeState =
  | {
      error?: string;
      ok?: string;
      previewToken?: string;
      preview?: UebernahmePreview;
      result?: ApplySummary;
    }
  | undefined;

/** Server-Action-Grenze ist 25 MB (next.config.ts) – inkl. Formular-Overhead */
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const ALLOWED_EXT = /\.(csv|txt|xlsx|zip|pdf)$/i;

async function readFiles(form: FormData): Promise<{ files: InputFile[]; hash: string } | { error: string }> {
  const raw = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!raw.length) return { error: "Bitte mindestens eine Datei auswählen." };
  if (raw.length > MAX_UPLOAD_FILES) return { error: `Bitte höchstens ${MAX_UPLOAD_FILES} Dateien auf einmal hochladen (oder als ZIP).` };
  const total = raw.reduce((a, f) => a + f.size, 0);
  if (total > MAX_TOTAL_BYTES) return { error: "Die Dateien sind zusammen größer als 24 MB. Bitte in mehreren Durchgängen hochladen (z. B. Rechnungs-PDFs je Jahr)." };
  const bad = raw.find((f) => !ALLOWED_EXT.test(f.name));
  if (bad) return { error: `„${bad.name.slice(0, 80)}“: Bitte nur CSV-, Excel- (.xlsx), ZIP- oder PDF-Dateien hochladen.` };
  const files: InputFile[] = [];
  const parts: string[] = [];
  for (const f of raw) {
    const data = new Uint8Array(await f.arrayBuffer());
    // nur der Dateiname (ohne Pfad), auf eine vernünftige Länge begrenzt
    const name = f.name.replace(/^.*[\\/]/, "").slice(0, 160) || "datei";
    files.push({ name, data });
    parts.push(`${name}\u0000${createHash("sha256").update(data).digest("hex")}`);
  }
  return { files, hash: createHash("sha256").update(parts.sort().join("\n")).digest("hex") };
}

const modeOf = (form: FormData): PrescriptionMode => (form.get("prescriptionMode") === "active" ? "active" : "billed");

function toPreview(plan: ImportPlan): UebernahmePreview {
  return {
    files: plan.files,
    totals: plan.totals,
    warnings: plan.warnings.slice(0, 200),
    warningsTotal: plan.warnings.length,
    samples: plan.samples,
    cashbook: plan.cashbook,
    hasWork: plan.hasWork,
  };
}

export async function uebernahmeAction(_: UebernahmeState, form: FormData): Promise<UebernahmeState> {
  // nur Inhaber:in (import.run + settings.manage); Support-Zugriff und Nur-Lesen-Modus scheitern bereits an requireAuth
  const auth = await requireAuth("import.run");
  if (!auth.can("settings.manage") || auth.support) denyAccess(auth, "import.run");
  const org = auth.organization.id;
  const up = await readFiles(form);
  if ("error" in up) return { error: up.error };
  const mode = modeOf(form);
  const binding = { hash: createHash("sha256").update(`${up.hash}|${mode}`).digest("hex"), organizationId: org, userId: auth.user.id, type: "uebernahme" as const };
  const detected = await collectFiles(up.files);
  const shas = detected.filter((d) => d.kind === "pdf").map((d) => d.sha256);
  const sources = [...new Set(detected.map((d) => d.source).filter(Boolean))];

  if (form.get("intent") !== "run") {
    const existing = await withOrg(org, (tx) => loadExisting(tx, org, shas));
    const plan = buildPlan(detected, existing, { prescriptionMode: mode });
    await audit({ organizationId: org, userId: auth.user.id, action: "import.uebernahme.preview", meta: { sha256: up.hash, files: up.files.length, sources } });
    return { previewToken: plan.hasWork ? signPreviewToken(binding) : undefined, preview: toPreview(plan) };
  }

  if (!verifyPreviewToken(String(form.get("previewToken") ?? ""), binding)) {
    return { error: "Bitte zuerst genau diese Dateien prüfen (Vorschau, höchstens 15 Minuten gültig), dann importieren." };
  }
  const stored: string[] = [];
  let summary: ApplySummary;
  let plan: ImportPlan;
  try {
    ({ summary, plan } = await withOrg(org, async (tx) => {
      // Sperre VOR dem Bestandsabgleich: zwei gleichzeitige Läufe sehen sonst denselben Bestand und legen doppelt an
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"pnum:" + org}))`);
      const existing = await loadExisting(tx, org, shas);
      const p = buildPlan(detected, existing, { prescriptionMode: mode });
      const s = await applyPlan(tx, org, auth.user.id, p, async (data) => {
        const r = await storeEncrypted(org, data);
        stored.push(r.storageKey);
        return r;
      });
      return { summary: s, plan: p };
    }));
  } catch (e) {
    // keine verwaisten verschlüsselten Dateien ohne DB-Eintrag
    for (const k of stored) await discardStored(k).catch(() => {});
    await audit({ organizationId: org, userId: auth.user.id, action: "import.uebernahme.failed", meta: { sha256: up.hash, error: e instanceof Error ? e.name : "Error" } });
    if (e instanceof PatientLimitError) return { error: `${e.message} Es wurde nichts importiert.` };
    console.error("[import.uebernahme]", e instanceof Error ? e.message : e);
    return { error: "Import abgebrochen, es wurde nichts gespeichert. Bitte die Dateien prüfen oder den Support kontaktieren." };
  }
  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: "import.uebernahme.run",
    meta: {
      sha256: up.hash,
      sources,
      prescriptionMode: mode,
      patientsCreated: summary.patientsCreated,
      patientsLinked: summary.patientsLinked,
      appointments: summary.appointments,
      prescriptions: summary.prescriptions,
      documents: summary.documents,
      excel: summary.excel,
      skipped: {
        patients: plan.totals.patientsExisting,
        appointments: plan.totals.appointmentsExisting + plan.totals.appointmentsUnassigned,
        prescriptions: plan.totals.prescriptionsExisting + plan.totals.prescriptionsUnassigned,
        documents: plan.totals.documentsExisting + plan.totals.documentsUnassigned,
      },
    },
  });
  revalidatePath("/kunden");
  revalidatePath("/kalender");
  revalidatePath("/verordnungen");
  if (summary.excel?.invoices) revalidatePath("/rechnungen");
  return { ok: "Übernahme abgeschlossen.", result: summary };
}
