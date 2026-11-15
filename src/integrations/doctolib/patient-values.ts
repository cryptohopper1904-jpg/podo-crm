import { DOCTOLIB_CSV_SOURCE } from "@/lib/appointment-marks";
import type { PatientDraft } from "../types";

/**
 * Doctolib-CSV-Import (Einstellungen → Import): Werte für die neue Patientenzeile (ohne Praxis und Nummer). Mit
 * Doctolib-Patienten-ID steht sie in external_ids.doctolib (Abgleich beim nächsten Import), ohne ID wenigstens der
 * Marker { import: "doctolib" } – übernommene Personen sind keine Neupatient:innen (Kalender „N“).
 * Gemeinsam für den Doctolib-Import und den Übernahme-Assistenten. Geburtsname und Beruf werden bewusst nicht
 * übernommen (Datenminimierung, Recht). „Keine Benachrichtigungen“ → extra.no_reminders (wie Erinnerungen/Warteliste lesen).
 */
export function doctolibPatientValues(p: PatientDraft) {
  const extra: Record<string, unknown> = {};
  if (p.referrer) extra.referrer = p.referrer;
  if (p.gpCity) extra.gpCity = p.gpCity;
  if (p.crucialInfo) extra.crucialInfo = p.crucialInfo;
  if (p.noNotifications) extra.no_reminders = true;
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
    // ohne Doctolib-Patienten-ID wenigstens der Import-Marker: übernommene Personen sind keine Neupatient:innen (Kalender „N“)
    externalIds: (p.externalId ? { doctolib: p.externalId } : { import: "doctolib" }) as Record<string, string>,
    source: DOCTOLIB_CSV_SOURCE,
  };
}
