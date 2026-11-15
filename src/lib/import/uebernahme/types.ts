/**
 * Übernahme-Assistent („Daten übernehmen“): gemeinsame Typen. Reine Datenstrukturen ohne DB-Bezug.
 * Beträge in Cent, Datum als JJJJ-MM-TT, Zeitpunkte als ISO-String mit Offset (Europe/Berlin).
 */
import type { PatientDraft } from "@/integrations/types";
import type { ImportResult } from "../excel/types";

export type SourceId = "tinana" | "doctolib" | "podohero-excel" | "pododesk";

export type FileKind =
  | "tinana.patients"
  | "tinana.appointments"
  | "tinana.prescriptions"
  | "tinana.doctors"
  | "tinana.invoices"
  | "tinana.invoice_list"
  | "tinana.report"
  | "doctolib.patients"
  | "podohero.excel"
  | "pododesk.cashbook"
  | "pdf"
  | "unknown";

/** import = wird übernommen, info = nur Hinweis/Abgleich, rejected = abgelehnt (mit Grund), duplicate = doppelt hochgeladen */
export type FileStatus = "import" | "info" | "rejected" | "duplicate";

export interface InputFile {
  /** Anzeigename inkl. Pfad im ZIP („export.zip/patients_export_….csv“) */
  name: string;
  data: Uint8Array;
}

export interface ImportIssue {
  file?: string;
  row?: number;
  message: string;
}

// ───────────── Tinana ─────────────
export interface TinanaPatient {
  row: number;
  id: string;
  salutation: "Herr" | "Frau" | "Divers" | null;
  title: string | null;
  firstName: string | null;
  lastName: string;
  gender: "female" | "male" | "diverse" | null;
  birthDate: string | null;
  street: string | null;
  zip: string | null;
  city: string | null;
  location: string | null;
  email: string | null;
  phoneMobile: string | null;
  phoneLandline: string | null;
  /** weitere Nummern / fremde Labels → Notiz */
  otherPhones: string[];
  notes: string | null;
  vip: boolean;
  insuranceType: "gkv" | "pkv" | "self";
  insuranceRaw: string | null;
  createdAt: string | null;
}

export interface TinanaAppointment {
  row: number;
  id: string;
  patientId: string | null;
  agendaLabel: string | null;
  title: string | null;
  startsAt: string;
  endsAt: string;
  statusRaw: string;
  location: string | null;
  patientFirstName: string | null;
  patientLastName: string | null;
  therapistName: string | null;
  remedies: string | null;
  documentation: string | null;
  description: string | null;
  homeVisit: boolean;
  travel: string | null;
}

export interface TinanaPrescription {
  /** Zeilen der Datei (eine je Heilmittel-Position) */
  rows: number[];
  /** stabiler Schlüssel aus den Formulardaten (Tinana exportiert keine ID) */
  key: string;
  formType: string | null;
  location: string | null;
  issuedAt: string | null;
  patientFirstName: string | null;
  patientLastName: string | null;
  patientBirthDate: string | null;
  doctorName: string | null;
  doctorLanr: string | null;
  doctorBsnr: string | null;
  insurerName: string | null;
  payerIk: string | null;
  insuranceNumber: string | null;
  diagnosisGroup: string | null;
  icd10: string | null;
  units: number | null;
  frequency: string | null;
  homeVisit: boolean;
  urgent: boolean;
  copaymentExempt: boolean;
  therapyReportRequested: boolean;
  positions: { position: string | null; code: string | null; label: string; units: number; priceCents: number | null }[];
  /** feste Auswahl strukturierter Formularangaben (prescriptions.import_data.fields), keine Freitexte */
  fields: Record<string, string>;
}

export interface TinanaDoctor {
  name: string;
  lanr: string | null;
  bsnr: string | null;
}

export interface TinanaInvoice {
  row: number;
  number: string;
  status: string | null;
  type: string | null;
  totalCents: number | null;
  patientFirstName: string | null;
  patientLastName: string | null;
  createdAt: string | null;
  paidAt: string | null;
}

export interface CashbookSummary {
  rows: number;
  firstDate: string | null;
  lastDate: string | null;
  /** letzter Kassenbestand laut Export (Vorschlag für den Anfangsbestand) */
  lastBalanceCents: number | null;
}

/** Ergebnis von Erkennung + Parsen einer einzelnen Datei */
export interface DetectedFile {
  name: string;
  sha256: string;
  size: number;
  kind: FileKind;
  source: SourceId | null;
  /** z. B. „Tinana – Patienten“ */
  label: string;
  /** Ziel in PodoHero, z. B. „Patient:innen“ */
  target: string;
  status: FileStatus;
  /** Erklärung für info/rejected */
  note?: string;
  records: number;
  issues: ImportIssue[];
  tinanaPatients?: TinanaPatient[];
  tinanaAppointments?: TinanaAppointment[];
  tinanaPrescriptions?: TinanaPrescription[];
  tinanaDoctors?: TinanaDoctor[];
  tinanaInvoices?: TinanaInvoice[];
  doctolibPatients?: PatientDraft[];
  excel?: ImportResult;
  cashbook?: CashbookSummary;
  pdf?: Uint8Array;
}

/** Übernommene Verordnungen: abgerechnet (Standard, keine zweite Abrechnung) oder noch aktiv */
export type PrescriptionMode = "billed" | "active";
