"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, max, sql } from "drizzle-orm";
import { withOrg } from "@/db";
import { patients } from "@/db/schema";
import { parseDoctolibPatientsCsv } from "@/integrations/doctolib/csv";
import type { PatientDraft } from "@/integrations/types";
import { audit } from "@/lib/audit";
import { signPreviewToken, verifyPreviewToken } from "@/lib/preview-token";
import { requireAuth } from "@/lib/auth/session";
import { parseWorkbook } from "@/lib/import/excel/parse";
import { persistImport } from "@/lib/import/excel/persist";
import type { ImportReport } from "@/lib/import/excel/types";

/**
 * Die hochgeladene Datei wird ausschließlich im Arbeitsspeicher verarbeitet und NIE auf die Platte geschrieben.
 * Ablauf: „Prüfen“ (Vorschau + Prüfsumme) → „Import ausführen“ mit derselben Datei (Prüfsumme muss passen).
 */
export type ExcelImportState =
  | {
      error?: string;
      ok?: string;
      /** server-signiert (HMAC), an Datei/Praxis/Benutzer/Art gebunden, 15 Min. gültig */
      previewToken?: string;
      fileName?: string;
      preview?: {
        counts: ImportReport["counts"];
        warnings: ImportReport["warnings"];
        warningsTotal: number;
        duplicates: ImportReport["duplicates"];
        collectiveParts: number;
        invoicesTotalCents: number;
      };
      result?: { patients: number; services: number; vouchers: number; invoices: number; payments: number; fixedCosts: number; renumbered: number; sequences: string[]; warnings: string[] };
    }
  | undefined;

const MAX_BYTES = 20 * 1024 * 1024;

async function readUpload(form: FormData, exts: string[]): Promise<{ data: Uint8Array; name: string; hash: string } | { error: string }> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Bitte eine Datei auswählen." };
  if (file.size > MAX_BYTES) return { error: "Datei ist größer als 20 MB." };
  if (!exts.some((e) => file.name.toLowerCase().endsWith(e))) return { error: `Bitte eine ${exts.join("/")}-Datei hochladen.` };
  const data = new Uint8Array(await file.arrayBuffer());
  return { data, name: file.name, hash: createHash("sha256").update(data).digest("hex") };
}

export async function excelImportAction(_: ExcelImportState, form: FormData): Promise<ExcelImportState> {
  const auth = await requireAuth("import.run");
  const org = auth.organization.id;
  const up = await readUpload(form, [".xlsx"]);
  if ("error" in up) return { error: up.error };
  const result = await parseWorkbook(up.data);
  const intent = form.get("intent");

  if (intent !== "run") {
    await audit({ organizationId: org, userId: auth.user.id, action: "import.excel.preview", meta: { sha256: up.hash } });
    return {
      previewToken: signPreviewToken({ hash: up.hash, organizationId: org, userId: auth.user.id, type: "excel" }),
      fileName: up.name,
      preview: {
        counts: result.report.counts,
        warnings: result.report.warnings.slice(0, 200),
        warningsTotal: result.report.warnings.length,
        duplicates: result.report.duplicates,
        collectiveParts: result.report.collectiveParts,
        invoicesTotalCents: result.invoices.reduce((a, i) => a + i.totalCents, 0),
      },
    };
  }

  if (!verifyPreviewToken(String(form.get("previewToken") ?? ""), { hash: up.hash, organizationId: org, userId: auth.user.id, type: "excel" })) {
    return { error: "Bitte zuerst genau diese Datei prüfen (Vorschau, max. 15 Minuten gültig), dann importieren." };
  }
  if (result.patients.length + result.services.length + result.invoices.length === 0) return { error: "Keine importierbaren Daten gefunden." };
  try {
    const s = await withOrg(org, (tx) => persistImport(tx, org, result, auth.user.id));
    await audit({
      organizationId: org,
      userId: auth.user.id,
      action: "import.excel.run",
      meta: { sha256: up.hash, patients: s.patients, invoices: s.invoices, services: s.services, vouchers: s.vouchers },
    });
    revalidatePath("/kunden");
    revalidatePath("/rechnungen");
    return {
      ok: "Import abgeschlossen.",
      result: {
        patients: s.patients,
        services: s.services,
        vouchers: s.vouchers,
        invoices: s.invoices,
        payments: s.payments,
        fixedCosts: s.fixedCosts,
        renumbered: s.renumberedPatients.length,
        sequences: s.sequences.map((q) => `${q.key} ${q.year}: weiter ab ${q.next}`),
        warnings: s.warnings.map((w) => `${w.sheet}${w.row ? ` Zeile ${w.row}` : ""}: ${w.message}`).slice(0, 100),
      },
    };
  } catch (e) {
    await audit({ organizationId: org, userId: auth.user.id, action: "import.excel.failed", meta: { sha256: up.hash, error: e instanceof Error ? e.name : "Error" } });
    console.error("[import.excel]", e instanceof Error ? e.message : e);
    return { error: "Import abgebrochen, es wurde nichts gespeichert. Bitte Datei prüfen oder den Support kontaktieren." };
  }
}

// ───────────── Doctolib-CSV (Patienten) ─────────────
export type DoctolibImportState =
  | {
      error?: string;
      ok?: string;
      previewToken?: string;
      preview?: { total: number; existing: number; issues: { row: number; message: string }[]; sample: string[] };
    }
  | undefined;

function decodeCsv(data: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8").decode(data);
  return utf8.includes("�") ? new TextDecoder("windows-1252").decode(data) : utf8;
}

async function existingDoctolibIds(org: string): Promise<Set<string>> {
  const rows = await withOrg(org, (tx) =>
    tx
      .select({ id: sql<string | null>`${patients.externalIds}->>'doctolib'` })
      .from(patients)
      .where(and(eq(patients.organizationId, org), sql`${patients.externalIds} ? 'doctolib'`)),
  );
  return new Set(rows.map((r) => r.id).filter((x): x is string => !!x));
}

function toValues(p: PatientDraft) {
  const extra: Record<string, unknown> = {};
  if (p.maidenName) extra.maidenName = p.maidenName;
  if (p.occupation) extra.occupation = p.occupation;
  if (p.referrer) extra.referrer = p.referrer;
  if (p.gpCity) extra.gpCity = p.gpCity;
  if (p.crucialInfo) extra.crucialInfo = p.crucialInfo;
  if (p.noNotifications) extra.noReminders = true;
  return {
    salutation: p.salutation ?? null,
    title: p.title ?? null,
    lastName: p.lastName,
    firstName: p.firstName ?? null,
    birthDate: p.birthDate ?? null,
    street: p.street ?? null,
    zip: p.zip ?? null,
    city: p.city ?? null,
    phoneMobile: p.phoneMobile ?? null,
    phoneLandline: p.phoneLandline ?? null,
    email: p.email ?? null,
    insuranceType: p.insuranceType ?? "self",
    gpName: p.gpName ?? null,
    notes: p.notes ?? null,
    extra,
    externalIds: p.externalId ? { doctolib: p.externalId } : {},
    source: "doctolib-csv",
  };
}

export async function doctolibImportAction(_: DoctolibImportState, form: FormData): Promise<DoctolibImportState> {
  const auth = await requireAuth("import.run");
  const org = auth.organization.id;
  const up = await readUpload(form, [".csv", ".txt"]);
  if ("error" in up) return { error: up.error };
  const { patients: drafts, issues } = parseDoctolibPatientsCsv(decodeCsv(up.data));
  const existing = await existingDoctolibIds(org);
  const fresh = drafts.filter((d) => !d.externalId || !existing.has(d.externalId));

  if (form.get("intent") !== "run") {
    await audit({ organizationId: org, userId: auth.user.id, action: "import.doctolib.preview", meta: { sha256: up.hash, total: drafts.length } });
    return {
      previewToken: signPreviewToken({ hash: up.hash, organizationId: org, userId: auth.user.id, type: "doctolib" }),
      preview: {
        total: drafts.length,
        existing: drafts.length - fresh.length,
        issues: issues.slice(0, 100),
        sample: fresh.slice(0, 8).map((d) => [d.firstName, d.lastName].filter(Boolean).join(" ")),
      },
    };
  }
  if (!verifyPreviewToken(String(form.get("previewToken") ?? ""), { hash: up.hash, organizationId: org, userId: auth.user.id, type: "doctolib" })) {
    return { error: "Bitte zuerst genau diese Datei prüfen (Vorschau, max. 15 Minuten gültig), dann importieren." };
  }
  if (fresh.length === 0) return { ok: "Keine neuen Patient:innen in der Datei." };
  let created = 0;
  try {
    created = await withOrg(org, async (tx) => {
      // Patientennummern konkurrenzsicher vergeben (gleicher Lock wie bei Neuanlage/Online-Buchung)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"pnum:" + org}))`);
      // Unter dem Lock erneut prüfen, welche Doctolib-IDs schon existieren
      const rows = await tx
        .select({ id: sql<string | null>`${patients.externalIds}->>'doctolib'` })
        .from(patients)
        .where(and(eq(patients.organizationId, org), sql`${patients.externalIds} ? 'doctolib'`));
      const known = new Set(rows.map((r) => r.id).filter((x): x is string => !!x));
      const seen = new Set<string>();
      const todo = drafts.filter((d) => {
        if (!d.externalId) return true;
        if (known.has(d.externalId) || seen.has(d.externalId)) return false;
        seen.add(d.externalId);
        return true;
      });
      const [r] = await tx.select({ n: max(patients.number) }).from(patients).where(eq(patients.organizationId, org));
      let next = (r?.n ?? 0) + 1;
      for (let i = 0; i < todo.length; i += 500) {
        await tx.insert(patients).values(todo.slice(i, i + 500).map((d) => ({ ...toValues(d), organizationId: org, number: next++ })));
      }
      return todo.length;
    });
  } catch (e) {
    console.error("[import.doctolib]", e instanceof Error ? e.message : e);
    return { error: "Import abgebrochen, es wurde nichts gespeichert." };
  }
  await audit({ organizationId: org, userId: auth.user.id, action: "import.doctolib.run", meta: { sha256: up.hash, created } });
  revalidatePath("/kunden");
  return { ok: `${created} Patient:innen importiert${drafts.length - created ? `, ${drafts.length - created} bereits vorhanden übersprungen` : ""}.` };
}
