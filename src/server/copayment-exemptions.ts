import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db";
import { patients, type CopaymentExemptionRow } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import { gkvGuard } from "@/lib/features";
import { assertCan } from "./authz";

/**
 * Befreiungsbescheinigungen (Zuzahlung) je Person – SGB V § 62 Abs. 1 (Befreiung für den Rest des Kalenderjahres),
 * Vertrag § 125 Podologie § 8 Abs. 3 (Verzicht nur bei gültiger Bescheinigung; über den Jahreswechsel neu prüfen).
 * Gespeichert als Liste an der Person (patients.copayment_exemptions); ausgewertet je Behandlungstag
 * (src/lib/rules/prescription.ts, exemptOn/priceSnapshot).
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum fehlt.");

export const exemptionInput = z
  .object({
    patientId: z.string().uuid(),
    validFrom: isoDate,
    validTo: isoDate,
    insurerName: z.string().trim().max(200).optional().transform((v) => v || null),
    insurerIk: z.string().trim().max(20).optional().transform((v) => (v ? v.replace(/\s+/g, "") : null)),
    note: z.string().trim().max(300).optional().transform((v) => v || null),
  })
  .refine((d) => d.validFrom <= d.validTo, { message: "„Gültig bis“ liegt vor „gültig ab“." });

const MAX_EXEMPTIONS = 50;

export async function addCopaymentExemption(auth: AuthContext, d: z.infer<typeof exemptionInput>): Promise<{ error: string } | { ok: true }> {
  assertCan(auth, "medical.write");
  const blocked = gkvGuard(auth.organization, "copayment");
  if (blocked) return blocked;
  // nur Format (Prüfziffer-Abweichung zeigt die Pflichtangaben-Prüfung der Verordnung als Hinweis)
  if (d.insurerIk && !/^\d{9}$/.test(d.insurerIk)) return { error: "IK der Krankenkasse hat 9 Ziffern." };
  // Bescheinigungen gelten je Kalenderjahr – über den Jahreswechsel nicht in einem Eintrag
  if (d.validFrom.slice(0, 4) !== d.validTo.slice(0, 4)) return { error: "Eine Befreiung gilt höchstens bis zum Ende des Kalenderjahres – bitte je Jahr einen Eintrag." };
  const org = auth.organization.id;
  const row: CopaymentExemptionRow = { id: randomUUID(), validFrom: d.validFrom, validTo: d.validTo, insurerName: d.insurerName, insurerIk: d.insurerIk, note: d.note, createdAt: new Date().toISOString() };
  const done = await withOrg(org, async (tx) => {
    const [p] = await tx.select({ list: patients.copaymentExemptions }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, d.patientId))).for("update");
    if (!p) return false;
    if (p.list.length >= MAX_EXEMPTIONS) return null;
    await tx.update(patients).set({ copaymentExemptions: [...p.list, row] }).where(and(eq(patients.organizationId, org), eq(patients.id, d.patientId)));
    return true;
  });
  if (done === false) return { error: "Patient nicht gefunden." };
  if (done === null) return { error: "Zu viele Einträge – bitte alte Befreiungen entfernen." };
  await audit({ organizationId: org, userId: auth.user.id, action: "patient.copayment_exemption.add", entity: "patient", entityId: d.patientId, meta: { validFrom: d.validFrom, validTo: d.validTo } });
  return { ok: true };
}

export async function removeCopaymentExemption(auth: AuthContext, input: { patientId: string; id: string }): Promise<void> {
  assertCan(auth, "medical.write");
  if (gkvGuard(auth.organization, "copayment")) return;
  const org = auth.organization.id;
  await withOrg(org, (tx) =>
    tx
      .update(patients)
      .set({ copaymentExemptions: sql`coalesce((select jsonb_agg(e) from jsonb_array_elements(${patients.copaymentExemptions}) e where e->>'id' <> ${input.id}), '[]'::jsonb)` })
      .where(and(eq(patients.organizationId, org), eq(patients.id, input.patientId))),
  );
  await audit({ organizationId: org, userId: auth.user.id, action: "patient.copayment_exemption.remove", entity: "patient", entityId: input.patientId, meta: { id: input.id } });
}
