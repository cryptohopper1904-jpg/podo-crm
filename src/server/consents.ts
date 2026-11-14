import "server-only";
import { withOrg } from "@/db";
import { consents, consentTypeEnum } from "@/db/schema";
import { PATIENT_NOT_IN_ORG_MSG, patientInOrg } from "./patient-route";

export type ConsentType = (typeof consentTypeEnum.enumValues)[number];

export type ConsentInput = { patientId: string; type: string; granted: boolean; via: string; recordedBy: string };

/**
 * Einwilligung in der Akte erfassen (nur anhängend). Die Patient:in muss zur eigenen Praxis gehören: Fremdschlüssel
 * prüft Postgres unabhängig von RLS (zweite Sicherung: Trigger aus Migration 0050). Prüfung und Anlage in einer
 * Transaktion.
 */
export async function recordConsent(org: string, input: ConsentInput): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(consentTypeEnum.enumValues as readonly string[]).includes(input.type)) return { ok: false, error: "Unbekannte Einwilligung." };
  const type = input.type as ConsentType;
  return withOrg(org, async (tx) => {
    if (!(await patientInOrg(tx, org, input.patientId))) return { ok: false as const, error: PATIENT_NOT_IN_ORG_MSG };
    await tx.insert(consents).values({ organizationId: org, patientId: input.patientId, type, granted: input.granted, via: input.via, recordedBy: input.recordedBy });
    return { ok: true as const };
  });
}
