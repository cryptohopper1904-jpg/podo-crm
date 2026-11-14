import "server-only";
import { withOrg } from "@/db";
import { consents, consentTypeEnum } from "@/db/schema";
import { PATIENT_NOT_IN_ORG_MSG, patientInOrg } from "./patient-route";

export type ConsentType = (typeof consentTypeEnum.enumValues)[number];

export type ConsentInput = { patientId: string; type: string; granted: boolean; via: string; recordedBy: string };

/**
 * Erfassungswege, die von außen (Formular der Akte) kommen dürfen. Andere Wege („online-anamnese“, „loeschung“)
 * setzen nur die jeweiligen Server-Abläufe selbst – über das Formular ließen sie sich sonst vortäuschen.
 */
export const MANUAL_CONSENT_VIA = ["praxis"] as const;

/**
 * Einwilligung in der Akte erfassen (nur anhängend). Die Patient:in muss zur eigenen Praxis gehören: Fremdschlüssel
 * prüft Postgres unabhängig von RLS (zweite Sicherung: DB-Trigger podo_fk_same_org). Prüfung und Anlage in einer
 * Transaktion.
 */
export async function recordConsent(org: string, input: ConsentInput): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(consentTypeEnum.enumValues as readonly string[]).includes(input.type)) return { ok: false, error: "Unbekannte Einwilligung." };
  const type = input.type as ConsentType;
  if (!(MANUAL_CONSENT_VIA as readonly string[]).includes(input.via)) return { ok: false, error: "Unbekannter Erfassungsweg." };
  return withOrg(org, async (tx) => {
    if (!(await patientInOrg(tx, org, input.patientId))) return { ok: false as const, error: PATIENT_NOT_IN_ORG_MSG };
    await tx.insert(consents).values({ organizationId: org, patientId: input.patientId, type, granted: input.granted, via: input.via, recordedBy: input.recordedBy });
    return { ok: true as const };
  });
}
