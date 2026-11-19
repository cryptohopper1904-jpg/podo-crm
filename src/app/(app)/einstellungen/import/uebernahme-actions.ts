"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { withOrg } from "@/db";
import { audit } from "@/lib/audit";
import { denyAccess, requestMeta, requireAuth } from "@/lib/auth/session";
import { MAX_UPLOAD_FILES } from "@/lib/import/uebernahme/collect";
import type { ApplySummary } from "@/lib/import/uebernahme/persist";
import { errorForLog, toPreview, uebernahmeLimiter, type UebernahmePreview } from "@/lib/import/uebernahme/preview-safety";
import { ChoiceConflictError, DB_TIMEOUT_MESSAGE, ImportBusyError, isDbTimeout, previewUebernahme, runUebernahme, StaleSnapshotError, StoreTimeoutError, TokenUsedError } from "@/lib/import/uebernahme/run";
import type { InputFile, PrescriptionMode } from "@/lib/import/uebernahme/types";
import { canonicalPreviewToken, signPreviewToken, verifyPreviewToken } from "@/lib/preview-token";
import { discardStored, storeEncrypted } from "@/lib/storage";
import { PatientLimitError } from "@/server/patient-limit";

/**
 * Übernahme-Assistent (Einstellungen → Import → Daten übernehmen).
 * Dateien werden nur im Arbeitsspeicher verarbeitet; nur zugeordnete PDFs werden beim Import verschlüsselt abgelegt
 * (wie Uploads in der Akte). Ablauf wie die übrigen Importe: „Prüfen“ (Vorschau + signiertes Token, gebunden an genau
 * diese Dateien, Praxis, Person und Optionen) → „Import ausführen“ mit denselben Dateien. Das Token ist nur einmal
 * einlösbar; je Praxis läuft höchstens ein Lauf gleichzeitig, dazu eine Drosselung je Person (src/lib/import/uebernahme/run.ts).
 */
export type { UebernahmePreview };

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
  if (!raw.length) return { error: "Bitte wähle mindestens eine Datei aus." };
  if (raw.length > MAX_UPLOAD_FILES) return { error: `Bitte lade höchstens ${MAX_UPLOAD_FILES} Dateien auf einmal hoch (oder als ZIP).` };
  const total = raw.reduce((a, f) => a + f.size, 0);
  if (total > MAX_TOTAL_BYTES) return { error: "Die Dateien sind zusammen größer als 24 MB. Bitte lade sie in mehreren Durchgängen hoch (z. B. Rechnungs-PDFs je Jahr)." };
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

/** Auswahl zu möglichen Dubletten („dup:<Quell-Schlüssel>“ → "new" | Patienten-ID); plan.ts prüft gegen die Kandidaten. */
function choicesOf(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string" && k.startsWith("dup:") && k.length < 300 && /^(new|[0-9a-f-]{36})$/.test(v)) out[k.slice(4)] = v;
  }
  return out;
}

export async function uebernahmeAction(_: UebernahmeState, form: FormData): Promise<UebernahmeState> {
  // nur Inhaber:in (import.run + settings.manage); Support-Zugriff und Nur-Lesen-Modus scheitern bereits an requireAuth
  const auth = await requireAuth("import.run");
  if (!auth.can("settings.manage") || auth.support) denyAccess(auth, "import.run");
  const org = auth.organization.id;
  if (uebernahmeLimiter.limited(`${org}:${auth.user.id}`)) {
    return { error: "Zu viele Durchläufe in kurzer Zeit. Bitte warte einige Minuten und versuch es dann erneut." };
  }
  const up = await readFiles(form);
  if ("error" in up) return { error: up.error };
  const mode = modeOf(form);
  const binding = { hash: createHash("sha256").update(`${up.hash}|${mode}`).digest("hex"), organizationId: org, userId: auth.user.id, type: "uebernahme" as const };
  const opts = { prescriptionMode: mode, choices: choicesOf(form) };

  if (form.get("intent") !== "run") {
    try {
      const { detected, plan } = await previewUebernahme({ inOrg: withOrg }, org, up.files, opts);
      const sources = [...new Set(detected.map((d) => d.source).filter(Boolean))];
      await audit({ organizationId: org, userId: auth.user.id, action: "import.uebernahme.preview", meta: { sha256: up.hash, files: up.files.length, sources } });
      return { previewToken: plan.hasWork ? signPreviewToken(binding) : undefined, preview: toPreview(plan) };
    } catch (e) {
      if (e instanceof ImportBusyError) return { error: e.message };
      if (isDbTimeout(e)) return { error: DB_TIMEOUT_MESSAGE };
      // nicht weiterwerfen: die Fehlermeldung (z. B. aus der Datenbank) enthielte Klardaten im Log/Fehlerbericht (R3-6)
      console.error("[import.uebernahme.preview]", errorForLog(e));
      return { error: "Die Vorschau konnte nicht erstellt werden. Bitte prüfe die Dateien oder wende dich an den Support." };
    }
  }

  const token = String(form.get("previewToken") ?? "");
  if (!verifyPreviewToken(token, binding)) {
    return { error: "Bitte prüfe zuerst genau diese Dateien (Vorschau, höchstens 15 Minuten gültig) und importiere dann." };
  }
  let summary: ApplySummary;
  try {
    ({ summary } = await runUebernahme(
      { inOrg: withOrg, store: storeEncrypted, discard: discardStored },
      {
        org,
        userId: auth.user.id,
        files: up.files,
        opts,
        // kanonische Form hashen (A-H1): Schreibvarianten desselben Tokens ergeben denselben Hash
        tokenHash: createHash("sha256").update(canonicalPreviewToken(token)).digest("hex"),
        auditMeta: { sha256: up.hash },
        ip: (await requestMeta().catch(() => null))?.ip ?? null,
      },
    ));
  } catch (e) {
    await audit({ organizationId: org, userId: auth.user.id, action: "import.uebernahme.failed", meta: { sha256: up.hash, error: e instanceof Error ? e.name : "Error" } });
    if (e instanceof ImportBusyError || e instanceof TokenUsedError || e instanceof StaleSnapshotError || e instanceof ChoiceConflictError || e instanceof StoreTimeoutError) return { error: e.message };
    if (isDbTimeout(e)) return { error: DB_TIMEOUT_MESSAGE };
    if (e instanceof PatientLimitError) return { error: `${e.message} Es wurde nichts importiert.` };
    // nur Fehlerart + Code: DB-Fehlermeldungen enthalten die Abfrage samt Klardaten (AppSec A-B2)
    console.error("[import.uebernahme]", errorForLog(e));
    return { error: "Import abgebrochen, es wurde nichts gespeichert. Bitte prüfe die Dateien oder wende dich an den Support." };
  }
  revalidatePath("/kunden");
  revalidatePath("/kalender");
  revalidatePath("/verordnungen");
  if (summary.excel?.invoices) revalidatePath("/rechnungen");
  return { ok: "Übernahme abgeschlossen.", result: summary };
}
