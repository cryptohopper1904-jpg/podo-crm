/** Doctolib-Patientenentwurf → Spaltenwerte für `patients` (gemeinsam für den Doctolib-Import und den Übernahme-Assistenten). */
import type { PatientDraft } from "../types";

export function doctolibPatientValues(p: PatientDraft) {
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
    insuranceType: p.insuranceType ?? ("self" as const),
    gpName: p.gpName ?? null,
    notes: p.notes ?? null,
    extra,
    externalIds: p.externalId ? { doctolib: p.externalId } : ({} as Record<string, string>),
    source: "doctolib-csv",
  };
}
