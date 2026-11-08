/**
 * Doctolib-Adapter (PLAN 6.2).
 *
 * Die Doctolib-Partner-API ist nur für zugelassene Partner verfügbar (Doku passwortgeschützt,
 * Partnerantrag hat Priorität). Bis dahin arbeitet dieser Adapter rein lokal:
 *  - CSV-Import/-Export (Patientenexport 22 Spalten, Termin-CSV)
 *  - Parser für Bestätigungsmails
 * TODO Partner-API: Termine/Patienten synchronisieren, sobald Zugang besteht (https://www.doctolib.de/).
 */
import { IntegrationNotConfiguredError } from "../errors";
import type { BookingCsvKind, BookingCsvResult, BookingPort, PatientDraft } from "../types";
import { parseAppointmentsCsv, parseDoctolibPatientsCsv, writeDoctolibPatientsCsv } from "./csv";
import { parseDoctolibEmail } from "./email";

export class DoctolibAdapter implements BookingPort {
  readonly provider = "doctolib" as const;
  readonly isMock: boolean = false;

  async importCsv<K extends BookingCsvKind>(kind: K, text: string): Promise<BookingCsvResult<K>> {
    const res = kind === "patients" ? parseDoctolibPatientsCsv(text) : parseAppointmentsCsv(text);
    return res as BookingCsvResult<K>;
  }

  exportPatientsCsv(patients: PatientDraft[]): string {
    return writeDoctolibPatientsCsv(patients);
  }

  parseConfirmationEmail(text: string, subject?: string) {
    return parseDoctolibEmail(text, subject);
  }

  /** Platzhalter für die Partner-API. */
  async syncAppointments(): Promise<never> {
    throw new IntegrationNotConfiguredError("doctolib", "Partner-API nicht freigeschaltet – bitte CSV-Import nutzen");
  }
}

/** Mock: identische, rein lokale Logik (Doctolib hat ohnehin keinen Netzwerkzugriff in P1). */
export class DoctolibMock extends DoctolibAdapter {
  override readonly isMock = true;
}
