/**
 * Übernahme-Plan: führt die erkannten Dateien zusammen und gleicht sie mit dem Bestand der Praxis ab – rein, ohne DB.
 * Derselbe Plan dient der Vorschau und (innerhalb der Import-Transaktion neu berechnet) dem Import.
 *
 * Grundsätze:
 *  - Ergänzen, nie überschreiben oder löschen. Schon übernommene Datensätze (gleiche Quelle + ID) werden übersprungen.
 *  - Patient:innen mit gleicher Quelle-ID → vorhanden. Auf Wunsch gelöschte Personen (Art. 17, contact_erased_at) werden
 *    nie neu angelegt („gelöscht, nicht übernommen“), auch nicht ihre Termine/Verordnungen.
 *  - Mögliche Dubletten im Bestand (gleicher Name + Geburtsdatum, gleicher Nachname + Geburtsdatum, E-Mail, Mobilnummer)
 *    entscheidet die Praxis je Fall in der Vorschau (`decisions`, Auswahl über `opts.choices`): verknüpfen (nur die Quell-ID
 *    wird ergänzt) oder neu anlegen. Standard: verknüpfen bei genau einer Person mit gleichem Namen + Geburtsdatum.
 *  - Verordnungen → Patient:in über Name + Geburtsdatum (Tinana exportiert keine Patienten-ID); nicht eindeutig → nicht übernommen.
 *  - Rechnungen aus Fremdsystemen werden nie PodoHero-Rechnungen: nur deren PDFs landen als Dokument bei der Patient:in –
 *    und nur, wenn die Rechnung genau einer Person aus der hochgeladenen Tinana-Patientendatei (mit Tinana-ID) zugeordnet
 *    werden kann. Ein Namenstreffer nur im Bestand (ohne Geburtsdatum/ID) reicht nicht.
 */
import { findDuplicates as findFileDuplicates } from "../excel/parse";
import type { ImportResult, PatientImportDraft } from "../excel/types";
import { doctolibPatientValues } from "@/integrations/doctolib/patient-values";
import { plural } from "./plural";
import { mapAppointmentStatus, normName, prescriptionComplete } from "./tinana";
import type { CashbookSummary, DetectedFile, ImportIssue, PrescriptionMode, TinanaPatient, TinanaPrescription } from "./types";

export interface ExistingPatient {
  id: string;
  number: number;
  firstName: string | null;
  lastName: string;
  birthDate: string | null;
  email: string | null;
  phoneMobile: string | null;
  externalIds: Record<string, unknown>;
  /** Kontaktdaten auf Wunsch gelöscht (Art. 17 DSGVO) */
  erased?: boolean;
}

export interface ExistingSnapshot {
  patients: ExistingPatient[];
  /** appointments.external_id der Quelle „import“ */
  appointmentRefs: Set<string>;
  /** prescriptions.external_ref */
  prescriptionRefs: Set<string>;
  /** `${patientId}|${sha256}` vorhandener Dokumente */
  documentHashes: Set<string>;
  therapists: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  services: { id: string; name: string; code: string }[];
}

export type PatientRef = { existingId: string } | { ref: string };

export interface PatientCreate {
  ref: string;
  sourceLabel: string;
  pseudonym: string;
  values: {
    salutation: string | null;
    title: string | null;
    lastName: string;
    firstName: string | null;
    birthDate: string | null;
    street: string | null;
    zip: string | null;
    city: string | null;
    phoneMobile: string | null;
    phoneLandline: string | null;
    email: string | null;
    insuranceType: "gkv" | "pkv" | "self" | "beihilfe";
    insurerName?: string | null;
    insuranceNumber?: string | null;
    gpName: string | null;
    notes: string | null;
    extra: Record<string, unknown>;
    externalIds: Record<string, string>;
    source: string;
  };
}

export interface PatientLink {
  patientId: string;
  key: "tinana" | "doctolib";
  externalId: string;
}

export interface AppointmentCreate {
  externalId: string;
  patient: PatientRef;
  therapistId: string | null;
  locationId: string | null;
  startsAt: string;
  endsAt: string;
  status: "planned" | "done" | "cancelled" | "no_show";
  title: string | null;
  notes: string | null;
  homeVisit: boolean;
  serviceIds: string[];
}

export interface PrescriptionCreate {
  externalRef: string;
  patient: PatientRef;
  values: {
    issuedAt: string;
    doctorName: string | null;
    doctorLanr: string | null;
    doctorBsnr: string | null;
    diagnosisGroup: string;
    icd10: string | null;
    remedy: string | null;
    units: number;
    frequencyPerWeek: string | null;
    homeVisit: boolean;
    urgent: boolean;
    copaymentExempt: boolean;
    therapyReportRequested: boolean;
    positions: { position?: string; label: string; units: number }[];
    status: "billed" | "active";
    importData: Record<string, unknown>;
  };
}

export interface DocumentCreate {
  patient: PatientRef;
  name: string;
  sha256: string;
  data: Uint8Array;
  caption: string;
}

/** Mögliche Dublette: die Praxis wählt in der Vorschau „verknüpfen mit Nr. …“ oder „neu anlegen“. */
export interface DuplicateDecision {
  /** Quell-Schlüssel („tinana:…“) – Name des Auswahlfelds */
  key: string;
  /** pseudonymisiert, z. B. „E. M. (Jg. 1950)“ */
  who: string;
  sourceLabel: string;
  candidates: { id: string; number: number; reason: string }[];
  /** "new" oder die ID der Bestandsperson */
  defaultChoice: string;
  /** tatsächlich verwendete Auswahl */
  choice: string;
}

export interface FileSummary {
  name: string;
  label: string;
  target: string;
  status: DetectedFile["status"];
  records: number;
  note?: string;
}

export interface PlanTotals {
  patientsNew: number;
  patientsLinked: number;
  patientsExisting: number;
  /** Personen, deren Kontaktdaten in PodoHero auf Wunsch gelöscht wurden – nicht erneut übernommen */
  patientsErased: number;
  appointmentsNew: number;
  appointmentsExisting: number;
  appointmentsUnassigned: number;
  prescriptionsNew: number;
  prescriptionsExisting: number;
  prescriptionsUnassigned: number;
  documentsNew: number;
  documentsExisting: number;
  documentsUnassigned: number;
  invoicesInfo: number;
  excel: { patientsNew: number; patientsExisting: number; services: number; vouchers: number; invoices: number; fixedCosts: number } | null;
}

export interface ImportPlan {
  files: FileSummary[];
  patientsCreate: PatientCreate[];
  patientsLink: PatientLink[];
  appointments: AppointmentCreate[];
  prescriptions: PrescriptionCreate[];
  documents: DocumentCreate[];
  decisions: DuplicateDecision[];
  excel: ImportResult | null;
  cashbook: CashbookSummary | null;
  totals: PlanTotals;
  warnings: ImportIssue[];
  samples: { patients: string[]; appointments: string[]; prescriptions: string[]; documents: string[] };
  /** true = es gibt etwas zu importieren */
  hasWork: boolean;
}

const personKey = (first: string | null | undefined, last: string | null | undefined, birth: string | null | undefined) =>
  birth ? `${normName(first)}|${normName(last)}|${birth}` : null;
const nameKey = (first: string | null | undefined, last: string | null | undefined) => `${normName(first)}|${normName(last)}`;

/** „E. M. (Jg. 1950)“ – pseudonyme Beispielzeile für die Vorschau */
export function pseudonym(first: string | null | undefined, last: string | null | undefined, birth?: string | null): string {
  const ini = (s: string | null | undefined) => (s && s.trim() ? `${s.trim()[0].toUpperCase()}.` : "");
  return [ini(first), ini(last)].filter(Boolean).join(" ") + (birth ? ` (Jg. ${birth.slice(0, 4)})` : "");
}

const dateDe = (iso: string) => {
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
  return p.replace(",", "");
};
const STATUS_DE = { planned: "geplant", done: "erledigt", cancelled: "abgesagt", no_show: "nicht erschienen" } as const;

/** Feldlängen begrenzen (fremde Exporte können beliebig lange Felder enthalten) */
export const FIELD_MAX = { name: 100, title: 50, street: 200, zip: 20, city: 100, phone: 50, email: 254, notes: 5000, apptTitle: 300, apptNotes: 10_000, doctor: 200, short: 100 } as const;
const clip = (v: string | null | undefined, max: number): string | null => (v == null ? null : v.length > max ? v.slice(0, max) : v);

function clipValues(v: PatientCreate["values"]): PatientCreate["values"] {
  return {
    ...v,
    salutation: clip(v.salutation, FIELD_MAX.short),
    title: clip(v.title, FIELD_MAX.title),
    lastName: clip(v.lastName, FIELD_MAX.name) ?? "",
    firstName: clip(v.firstName, FIELD_MAX.name),
    street: clip(v.street, FIELD_MAX.street),
    zip: clip(v.zip, FIELD_MAX.zip),
    city: clip(v.city, FIELD_MAX.city),
    phoneMobile: clip(v.phoneMobile, FIELD_MAX.phone),
    phoneLandline: clip(v.phoneLandline, FIELD_MAX.phone),
    email: clip(v.email, FIELD_MAX.email),
    insurerName: clip(v.insurerName, FIELD_MAX.doctor),
    insuranceNumber: clip(v.insuranceNumber, FIELD_MAX.short),
    gpName: clip(v.gpName, FIELD_MAX.doctor),
    notes: clip(v.notes, FIELD_MAX.notes),
  };
}

const phoneDigits = (s: string | null | undefined) => {
  const d = (s ?? "").replace(/\D/g, "").replace(/^(00)?49/, "0");
  return d.length >= 6 ? d : null;
};

function tinanaValues(p: TinanaPatient): PatientCreate["values"] {
  const extra: Record<string, unknown> = {};
  if (p.gender) extra.gender = p.gender;
  if (p.vip) extra.vip = true;
  if (p.location) extra.tinanaLocation = p.location;
  if (p.createdAt) extra.tinanaCreatedAt = p.createdAt;
  if (p.insuranceRaw && p.insuranceType === "self") extra.insuranceRaw = p.insuranceRaw;
  const notes = [p.notes, p.otherPhones.length ? `Weitere Telefonnummern: ${p.otherPhones.join(", ")}` : null].filter(Boolean).join("\n") || null;
  return {
    salutation: p.salutation,
    title: p.title,
    lastName: p.lastName,
    firstName: p.firstName,
    birthDate: p.birthDate,
    street: p.street,
    zip: p.zip,
    city: p.city,
    phoneMobile: p.phoneMobile,
    phoneLandline: p.phoneLandline,
    email: p.email,
    insuranceType: p.insuranceType,
    gpName: null,
    notes,
    extra,
    externalIds: { tinana: p.id },
    source: "tinana-import",
  };
}

/** Bestandsabgleich wie findDuplicates (src/server/patients.ts): Nachname+Geburtsdatum, E-Mail, Mobilnummer. */
function duplicateCandidates(v: PatientCreate["values"], existing: ExistingPatient[]): { patient: ExistingPatient; reason: string }[] {
  const out: { patient: ExistingPatient; reason: string }[] = [];
  for (const e of existing) {
    if (e.erased) continue;
    if (v.birthDate && e.birthDate === v.birthDate && normName(e.lastName) === normName(v.lastName)) {
      out.push({ patient: e, reason: normName(e.firstName) === normName(v.firstName) ? "gleicher Name und Geburtsdatum" : "gleicher Nachname und Geburtsdatum" });
    } else if (v.email && e.email && e.email.toLowerCase() === v.email.toLowerCase()) out.push({ patient: e, reason: "gleiche E-Mail-Adresse" });
    else if (v.phoneMobile && e.phoneMobile && phoneDigits(e.phoneMobile) === phoneDigits(v.phoneMobile)) out.push({ patient: e, reason: "gleiche Mobilnummer" });
  }
  return out;
}

export interface PlanOptions {
  prescriptionMode: PrescriptionMode;
  now?: Date;
  /** Entscheidungen der Praxis zu möglichen Dubletten: Quell-Schlüssel → "new" oder ID der Bestandsperson */
  choices?: Record<string, string>;
}

export function buildPlan(input: DetectedFile[], existing: ExistingSnapshot, opts: PlanOptions): ImportPlan {
  // Kopien: der Plan ergänzt Hinweise/Status je Datei, die Eingabe bleibt für einen zweiten Plan unverändert
  const detected = input.map((d) => ({ ...d }));
  const now = opts.now ?? new Date();
  const warnings: ImportIssue[] = [];
  const active = detected.filter((d) => d.status !== "duplicate" && d.status !== "rejected");
  for (const d of active) warnings.push(...d.issues);

  const totals: PlanTotals = {
    patientsNew: 0,
    patientsLinked: 0,
    patientsExisting: 0,
    patientsErased: 0,
    appointmentsNew: 0,
    appointmentsExisting: 0,
    appointmentsUnassigned: 0,
    prescriptionsNew: 0,
    prescriptionsExisting: 0,
    prescriptionsUnassigned: 0,
    documentsNew: 0,
    documentsExisting: 0,
    documentsUnassigned: 0,
    invoicesInfo: 0,
    excel: null,
  };
  const samples = { patients: [] as string[], appointments: [] as string[], prescriptions: [] as string[], documents: [] as string[] };

  // ───── Bestands-Indizes ─────
  const byExt = new Map<string, ExistingPatient>();
  const byPerson = new Map<string, ExistingPatient[]>();
  const byName = new Map<string, ExistingPatient[]>();
  /** Personenschlüssel gelöschter Personen (Art. 17) – auch ohne Quell-ID nicht erneut anlegen */
  const erasedPersons = new Set<string>();
  for (const e of existing.patients) {
    for (const k of ["tinana", "doctolib"]) {
      const v = e.externalIds[k];
      if (typeof v === "string" || typeof v === "number") byExt.set(`${k}:${v}`, e);
    }
    const pk = personKey(e.firstName, e.lastName, e.birthDate);
    if (e.erased) {
      if (pk) erasedPersons.add(pk);
      continue;
    }
    if (pk) byPerson.set(pk, [...(byPerson.get(pk) ?? []), e]);
    const nk = nameKey(e.firstName, e.lastName);
    byName.set(nk, [...(byName.get(nk) ?? []), e]);
  }
  const live = existing.patients.filter((e) => !e.erased);

  const patientsCreate: PatientCreate[] = [];
  const patientsLink: PatientLink[] = [];
  const decisions: DuplicateDecision[] = [];
  /** Quell-ID („tinana:…“) → Ziel; null = gelöschte Person (nicht übernehmen) */
  const target = new Map<string, PatientRef | null>();
  /** Personenschlüssel → Ziele aus dem Upload (für Verordnungen) */
  const uploadByPerson = new Map<string, PatientRef[]>();
  /** Name → Ziele aus der Tinana-Patientendatei (mit Tinana-ID) – nur darüber werden Rechnungs-PDFs zugeordnet */
  const tinanaByName = new Map<string, PatientRef[]>();
  /** Bestandspersonen, die in diesem Lauf schon eine Quell-ID bekommen (je Quelle nur eine) */
  const linkedNow = new Set<string>();
  const linkedIds = new Set<string>();
  const refKey = (r: PatientRef) => ("existingId" in r ? `e:${r.existingId}` : `r:${r.ref}`);
  const addIndex = (map: Map<string, PatientRef[]>, key: string | null, r: PatientRef) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    if (!list.some((x) => refKey(x) === refKey(r))) list.push(r);
    map.set(key, list);
  };
  const erasedWarning = (who: string) => warnings.push({ message: `${who}: Kontaktdaten wurden in PodoHero auf Wunsch gelöscht (Art. 17 DSGVO) – gelöscht, nicht übernommen (auch keine Termine oder Verordnungen).` });

  /**
   * Ziel für eine Person aus dem Upload. `linkable` = die Quelle liefert eine stabile ID (sonst wird nichts verknüpft,
   * sondern nur wiedererkannt). Liefert null für gelöschte Personen.
   */
  const resolvePatient = (key: "tinana" | "doctolib", extId: string, raw: PatientCreate["values"], sourceLabel: string, linkable = true): PatientRef | null => {
    const ext = `${key}:${extId}`;
    if (target.has(ext)) return target.get(ext)!;
    const values = clipValues(raw);
    const who = pseudonym(values.firstName, values.lastName, values.birthDate);
    const person = personKey(values.firstName, values.lastName, values.birthDate);
    const done = (ref: PatientRef | null) => {
      target.set(ext, ref);
      if (ref) {
        addIndex(uploadByPerson, person, ref);
        if (key === "tinana") addIndex(tinanaByName, nameKey(values.firstName, values.lastName), ref);
      }
      return ref;
    };
    const hit = byExt.get(ext);
    if (hit?.erased || (!hit && person && erasedPersons.has(person))) {
      totals.patientsErased++;
      erasedWarning(who);
      return done(null);
    }
    if (hit) {
      totals.patientsExisting++;
      return done({ existingId: hit.id });
    }
    const sameperson = person ? byPerson.get(person) ?? [] : [];
    if (!linkable) {
      // ohne Quell-ID (z. B. Doctolib-Zeile ohne ID): wiedererkennen über Name + Geburtsdatum, sonst Name + E-Mail/Mobilnummer
      const byContact = sameperson.length
        ? sameperson
        : live.filter(
            (e) =>
              normName(e.lastName) === normName(values.lastName) &&
              normName(e.firstName) === normName(values.firstName) &&
              ((values.email && e.email?.toLowerCase() === values.email.toLowerCase()) || (values.phoneMobile && phoneDigits(e.phoneMobile) === phoneDigits(values.phoneMobile))),
          );
      if (byContact.length === 1) {
        totals.patientsExisting++;
        return done({ existingId: byContact[0].id });
      }
    }
    // mögliche Dubletten: verknüpfbar sind nur Personen ohne ID dieser Quelle, die in diesem Lauf noch nicht vergeben sind
    const free = (e: ExistingPatient) => e.externalIds[key] === undefined && !linkedNow.has(`${key}:${e.id}`);
    const exact = sameperson.filter(free);
    const others = duplicateCandidates(values, live).filter((c) => !sameperson.includes(c.patient));
    const candidates = [
      ...exact.map((e) => ({ id: e.id, number: e.number, reason: "gleicher Name und Geburtsdatum" })),
      ...(linkable ? others.filter((c) => free(c.patient)).map((c) => ({ id: c.patient.id, number: c.patient.number, reason: c.reason })) : []),
    ];
    if (candidates.length && linkable) {
      const defaultChoice = exact.length === 1 && sameperson.length === 1 ? exact[0].id : "new";
      const wanted = opts.choices?.[ext];
      const choice = wanted && (wanted === "new" || candidates.some((c) => c.id === wanted)) ? wanted : defaultChoice;
      decisions.push({ key: ext, who, sourceLabel, candidates, defaultChoice, choice });
      if (choice !== "new") {
        const e = live.find((x) => x.id === choice)!;
        linkedNow.add(`${key}:${e.id}`);
        patientsLink.push({ patientId: e.id, key, externalId: extId });
        if (!linkedIds.has(e.id)) totals.patientsLinked++;
        linkedIds.add(e.id);
        warnings.push({ message: `${who}: mit vorhandener Nr. ${e.number} verknüpft – nichts überschrieben.` });
        return done({ existingId: e.id });
      }
    }
    const ref: PatientRef = { ref: ext };
    patientsCreate.push({ ref: ext, sourceLabel, pseudonym: who, values });
    totals.patientsNew++;
    if (candidates.length && linkable) warnings.push({ message: `${who}: mögliche Dublette zu ${candidates.map((c) => `Nr. ${c.number}`).join(", ")} – wird neu angelegt (Auswahl in der Vorschau).` });
    else if (sameperson.length > 1) warnings.push({ message: `${who}: mehrere gleichnamige Personen mit diesem Geburtsdatum vorhanden – neu angelegt, bitte prüfen.` });
    else if (others.length) warnings.push({ message: `${who}: mögliche Dublette zu Nr. ${others[0].patient.number} – neu angelegt, bitte prüfen und ggf. zusammenführen.` });
    if (!linkable && !values.birthDate && !values.email && !values.phoneMobile) {
      warnings.push({ message: `${who}: ohne Doctolib-ID, Geburtsdatum, E-Mail und Mobilnummer – bei einem erneuten Upload nicht wiedererkennbar (würde doppelt angelegt).` });
    }
    return done(ref);
  };

  // ───── Tinana-Patient:innen (mehrere Standort-Exporte: über die ID zusammengeführt) ─────
  const tinanaPatients = active.flatMap((d) => d.tinanaPatients ?? []);
  const prescriptionsAll = dedupe(active.flatMap((d) => d.tinanaPrescriptions ?? []), (p) => p.key);
  // jüngste Verordnung je Person liefert Kasse/Versichertennummer für NEUE Patient:innen
  const latestRx = new Map<string, TinanaPrescription>();
  for (const p of prescriptionsAll) {
    const k = personKey(p.patientFirstName, p.patientLastName, p.patientBirthDate);
    if (!k) continue;
    const prev = latestRx.get(k);
    if (!prev || (p.issuedAt ?? "") > (prev.issuedAt ?? "")) latestRx.set(k, p);
  }
  for (const p of dedupe(tinanaPatients, (x) => x.id)) {
    const values = tinanaValues(p);
    const rx = latestRx.get(personKey(p.firstName, p.lastName, p.birthDate) ?? "");
    if (rx) {
      values.insurerName = rx.insurerName;
      values.insuranceNumber = rx.insuranceNumber;
      if (rx.payerIk) values.extra.payerIk = rx.payerIk;
      if (values.insuranceType === "self" && rx.insurerName) values.insuranceType = "gkv";
    } else if (!p.insuranceRaw) {
      warnings.push({ row: p.row, message: `${pseudonym(p.firstName, p.lastName, p.birthDate)}: Versicherungsart fehlt – als Selbstzahler:in übernommen.` });
    }
    resolvePatient("tinana", p.id, values, "Tinana");
  }

  // ───── Doctolib-Patient:innen ─────
  for (const d of active.flatMap((f) => f.doctolibPatients ?? [])) {
    const v = doctolibPatientValues(d);
    const values: PatientCreate["values"] = { ...v, insuranceType: v.insuranceType, externalIds: v.externalIds as Record<string, string> };
    // ohne Doctolib-ID: stabiler Schlüssel aus Name + Geburtsdatum bzw. Kontakt (gleiche Zeile im nächsten Export → gleicher Schlüssel)
    const stable = `ohne-id:${normName(d.firstName)}|${normName(d.lastName)}|${d.birthDate ?? ""}|${(d.email ?? "").toLowerCase()}|${phoneDigits(d.phoneMobile) ?? ""}`;
    resolvePatient("doctolib", d.externalId ?? stable, values, "Doctolib", !!d.externalId);
  }

  // Dubletten innerhalb des Uploads (gleiche Kriterien wie beim Excel-Import)
  const pseudoDrafts = patientsCreate.map((c, i) => ({ row: i + 1, legacyId: null, lastName: c.values.lastName, firstName: c.values.firstName, birthDate: c.values.birthDate, email: c.values.email, phoneMobile: c.values.phoneMobile, phoneLandline: c.values.phoneLandline }) as unknown as PatientImportDraft);
  for (const g of findFileDuplicates(pseudoDrafts)) {
    const who = g.rows.map((r) => patientsCreate[r - 1].pseudonym).join(", ");
    warnings.push({ message: `Mögliche Dublette im Upload (${g.reason === "name_birthdate" ? "Name + Geburtsdatum" : g.reason === "email" ? "E-Mail" : "Telefon"}): ${who} – werden getrennt angelegt, bitte danach prüfen und ggf. zusammenführen.` });
  }
  samples.patients = patientsCreate.slice(0, 5).map((c) => `${c.pseudonym} · ${c.sourceLabel}`);

  // ───── Termine ─────
  const therapistByName = new Map<string, string[]>();
  for (const t of existing.therapists) therapistByName.set(normName(t.name), [...(therapistByName.get(normName(t.name)) ?? []), t.id]);
  const locationByName = new Map(existing.locations.map((l) => [normName(l.name), l.id]));
  const servicesByLength = [...existing.services].filter((s) => s.name.trim()).sort((a, b) => b.name.length - a.name.length);
  const unmatchedTherapists = new Set<string>();
  const appointments: AppointmentCreate[] = [];
  let pastPlanned = 0;
  let erasedAppointments = 0;
  /** künftige, geplante Termine bei Bestandspersonen (verknüpft oder schon übernommen) – können Erinnerungen auslösen */
  let linkedFuture = 0;
  for (const a of dedupe(active.flatMap((d) => d.tinanaAppointments ?? []), (x) => x.id)) {
    const externalId = `tinana:${a.id}`;
    if (existing.appointmentRefs.has(externalId)) {
      totals.appointmentsExisting++;
      continue;
    }
    const ext = a.patientId ? `tinana:${a.patientId}` : null;
    const known = ext ? byExt.get(ext) : undefined;
    if ((ext && target.has(ext) && target.get(ext) === null) || known?.erased) {
      totals.appointmentsUnassigned++;
      erasedAppointments++;
      continue;
    }
    const patient = ext ? target.get(ext) ?? (known ? { existingId: known.id } : null) : null;
    if (!patient) {
      totals.appointmentsUnassigned++;
      warnings.push({ row: a.row, message: `Termin ${dateDe(a.startsAt)} (${pseudonym(a.patientFirstName, a.patientLastName)}): Patient:in nicht in der Patientendatei – nicht übernommen. Bitte die Patientendatei desselben Standorts mit hochladen.` });
      continue;
    }
    const st = mapAppointmentStatus(a.statusRaw, a.startsAt, now);
    if (st.assumed && st.status === "done") pastPlanned++;
    if (st.status === "planned" && "existingId" in patient) linkedFuture++;
    let therapistId: string | null = null;
    for (const cand of [a.therapistName, a.agendaLabel]) {
      const ids = cand ? therapistByName.get(normName(cand)) : undefined;
      if (ids?.length === 1) {
        therapistId = ids[0];
        break;
      }
    }
    if (!therapistId && (a.therapistName || a.agendaLabel)) unmatchedTherapists.add((a.therapistName || a.agendaLabel)!);
    // Leistungen über den Namen zuordnen (längster Treffer zuerst; Tinana trennt mit „, “, Namen können selbst Kommas enthalten)
    const serviceIds: string[] = [];
    let rest = `, ${normName(a.remedies)}, `;
    for (const s of servicesByLength) {
      const n = `, ${normName(s.name)}, `;
      if (rest.includes(n)) {
        serviceIds.push(s.id);
        rest = rest.replace(n, ", ");
      }
    }
    const notes = [
      a.description,
      a.remedies ? `Heilmittel (Tinana): ${a.remedies}` : null,
      a.documentation ? `Dokumentation (Tinana): ${a.documentation}` : null,
      a.travel,
      st.assumed ? `Status in Tinana: „${a.statusRaw || "–"}“` : null,
      "Übernommen aus Tinana",
    ]
      .filter(Boolean)
      .join("\n");
    appointments.push({
      externalId,
      patient,
      therapistId,
      locationId: a.location ? locationByName.get(normName(a.location)) ?? null : null,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      status: st.status,
      title: clip(a.title, FIELD_MAX.apptTitle),
      notes: clip(notes, FIELD_MAX.apptNotes),
      homeVisit: a.homeVisit,
      serviceIds,
    });
    totals.appointmentsNew++;
    if (samples.appointments.length < 5) samples.appointments.push(`${dateDe(a.startsAt)} · ${pseudonym(a.patientFirstName, a.patientLastName)} · ${STATUS_DE[st.status]}`);
  }
  if (pastPlanned) warnings.push({ message: `${plural(pastPlanned, "vergangener Termin stand", "vergangene Termine standen")} in Tinana noch auf „Geplant“ – als erledigt übernommen (Hinweis in der Terminnotiz).` });
  if (erasedAppointments) warnings.push({ message: `${plural(erasedAppointments, "Termin gehört", "Termine gehören")} zu Personen, deren Kontaktdaten gelöscht wurden – nicht übernommen.` });
  if (linkedFuture) {
    warnings.push({ message: `${plural(linkedFuture, "künftiger Termin gehört", "künftige Termine gehören")} zu Patient:innen, die schon in PodoHero geführt werden (verknüpft oder früher übernommen). Haben diese Personen in PodoHero bereits in Terminerinnerungen eingewilligt, erhalten sie dafür Erinnerungen.` });
  }
  if (unmatchedTherapists.size) {
    warnings.push({ message: `Behandler:in ohne gleichnamiges Teammitglied: ${[...unmatchedTherapists].slice(0, 10).join(", ")} – Termine ohne Behandler:in übernommen. Legen Sie das Team vorher unter Einstellungen → Team an, wenn die Termine zugeordnet werden sollen.` });
  }

  // ───── Verordnungen ─────
  const doctors = active.flatMap((d) => d.tinanaDoctors ?? []);
  const lanrByDoctor = new Map<string, Set<string>>();
  for (const d of doctors) if (d.lanr) lanrByDoctor.set(normName(d.name), (lanrByDoctor.get(normName(d.name)) ?? new Set()).add(d.lanr));
  const prescriptions: PrescriptionCreate[] = [];
  let erasedPrescriptions = 0;
  for (const p of prescriptionsAll) {
    const externalRef = `tinana:${p.key}`;
    if (!prescriptionComplete(p)) {
      totals.prescriptionsUnassigned++;
      continue;
    }
    if (existing.prescriptionRefs.has(externalRef)) {
      totals.prescriptionsExisting++;
      continue;
    }
    const pk = personKey(p.patientFirstName, p.patientLastName, p.patientBirthDate);
    if (pk && erasedPersons.has(pk) && !(uploadByPerson.get(pk) ?? []).length) {
      totals.prescriptionsUnassigned++;
      erasedPrescriptions++;
      continue;
    }
    const fromUpload = pk ? uploadByPerson.get(pk) ?? [] : [];
    const fromDb = pk ? (byPerson.get(pk) ?? []).map((e) => ({ existingId: e.id }) as PatientRef) : [];
    const cands = fromUpload.length ? fromUpload : fromDb;
    const who = pseudonym(p.patientFirstName, p.patientLastName, p.patientBirthDate);
    if (cands.length !== 1) {
      totals.prescriptionsUnassigned++;
      warnings.push({
        row: p.rows[0],
        message: cands.length
          ? `Verordnung vom ${p.issuedAt} (${who}): mehrere passende Patient:innen – nicht übernommen.`
          : `Verordnung vom ${p.issuedAt} (${who}): keine Patient:in mit gleichem Namen und Geburtsdatum – nicht übernommen. Bitte die Patientendatei aller Standorte mit hochladen.`,
      });
      continue;
    }
    let lanr = p.doctorLanr;
    if (!lanr && p.doctorName) {
      const set = lanrByDoctor.get(normName(p.doctorName));
      if (set?.size === 1) lanr = [...set][0];
    }
    prescriptions.push({
      externalRef,
      patient: cands[0],
      values: {
        issuedAt: p.issuedAt!,
        doctorName: clip(p.doctorName, FIELD_MAX.doctor),
        doctorLanr: clip(lanr, FIELD_MAX.short),
        doctorBsnr: clip(p.doctorBsnr, FIELD_MAX.short),
        diagnosisGroup: clip(p.diagnosisGroup, FIELD_MAX.short)!,
        icd10: clip(p.icd10, FIELD_MAX.short),
        remedy: clip(p.positions.map((x) => x.label).join(", ") || null, FIELD_MAX.street),
        units: p.units!,
        frequencyPerWeek: clip(p.frequency, FIELD_MAX.short),
        homeVisit: p.homeVisit,
        urgent: p.urgent,
        copaymentExempt: p.copaymentExempt,
        therapyReportRequested: p.therapyReportRequested,
        positions: p.positions.map((x) => ({ ...(x.position ? { position: x.position.slice(0, 20) } : {}), label: x.label.slice(0, FIELD_MAX.city), units: x.units })),
        status: opts.prescriptionMode,
        importData: {
          source: "tinana",
          formType: p.formType,
          insurerName: p.insurerName,
          payerIk: p.payerIk,
          insuranceNumber: p.insuranceNumber,
          prices: p.positions.map((x) => ({ position: x.position, code: x.code, priceCents: x.priceCents })),
          fields: p.fields,
          billedOutside: opts.prescriptionMode === "billed",
        },
      },
    });
    totals.prescriptionsNew++;
    if (samples.prescriptions.length < 5) samples.prescriptions.push(`${p.issuedAt} · ${p.diagnosisGroup} · ${plural(p.units ?? 0, "Einheit", "Einheiten")} · ${who}`);
  }
  if (erasedPrescriptions) warnings.push({ message: `${plural(erasedPrescriptions, "Verordnung gehört", "Verordnungen gehören")} zu Personen, deren Kontaktdaten gelöscht wurden – nicht übernommen.` });

  // ───── Rechnungen (nur Info) und Rechnungs-PDFs (Dokumente) ─────
  const invoices = dedupe(active.flatMap((d) => d.tinanaInvoices ?? []), (i) => i.number);
  totals.invoicesInfo = invoices.length;
  const invoiceByNumber = new Map(invoices.map((i) => [i.number.toLowerCase(), i]));
  const documents: DocumentCreate[] = [];
  for (const f of active.filter((d) => d.kind === "pdf" && d.pdf)) {
    const base = f.name.split("/").pop()!.replace(/\.pdf$/i, "");
    const inv = invoiceByNumber.get(base.toLowerCase());
    if (!inv) {
      totals.documentsUnassigned++;
      f.note = invoices.length ? "Keine passende Rechnungsnummer im Rechnungsexport – nicht übernommen." : "Rechnungs-PDFs bitte zusammen mit dem Rechnungsexport (CSV) hochladen – sonst ist keine Zuordnung möglich.";
      continue;
    }
    // sicher ist nur eine Person aus der hochgeladenen Tinana-Patientendatei (mit Tinana-ID); Bestand allein reicht nicht
    const cands = inv.patientLastName ? tinanaByName.get(nameKey(inv.patientFirstName, inv.patientLastName)) ?? [] : [];
    const unique = cands.length === 1 ? cands[0] : null;
    if (!unique) {
      totals.documentsUnassigned++;
      const onlyDb = inv.patientLastName && !cands.length && (byName.get(nameKey(inv.patientFirstName, inv.patientLastName)) ?? []).length > 0;
      f.note =
        inv.type && /abrechnung/i.test(inv.type)
          ? "GKV-Abrechnung an die Kasse – keiner Patient:in zugeordnet, nicht übernommen."
          : !inv.patientLastName
            ? `Rechnung ${inv.number}: ohne Patient:in im Rechnungsexport – nicht übernommen.`
            : cands.length > 1
              ? `Rechnung ${inv.number}: mehrere Patient:innen mit diesem Namen in der Patientendatei – nicht eindeutig, nicht übernommen.`
              : onlyDb
                ? `Rechnung ${inv.number}: Name nur im PodoHero-Bestand gefunden – ohne Geburtsdatum oder Tinana-ID keine sichere Zuordnung, nicht übernommen. Bitte die Tinana-Patientendatei mit hochladen.`
                : `Rechnung ${inv.number}: Patient:in nicht in der hochgeladenen Patientendatei – nicht übernommen.`;
      continue;
    }
    if ("existingId" in unique && existing.documentHashes.has(`${unique.existingId}|${f.sha256}`)) {
      totals.documentsExisting++;
      f.note = "Bereits übernommen.";
      continue;
    }
    documents.push({ patient: unique, name: `${inv.number}.pdf`, sha256: f.sha256, data: f.pdf!, caption: `Rechnung ${inv.number} (aus Tinana übernommen${inv.createdAt ? `, ${inv.createdAt.slice(0, 10)}` : ""})` });
    f.note = "Wird als Dokument bei der Patient:in abgelegt.";
    f.status = "import";
    totals.documentsNew++;
    if (samples.documents.length < 5) samples.documents.push(`${inv.number} · ${pseudonym(inv.patientFirstName, inv.patientLastName)}`);
  }
  if (invoices.length) warnings.push({ message: `${plural(invoices.length, "Rechnung", "Rechnungen")} aus Tinana: nur zur Info – sie werden nicht als PodoHero-Rechnungen, Zahlungen oder Kassenbuchungen angelegt.` });

  // ───── PodoHero-Excel ─────
  const excelFiles = active.filter((d) => d.excel);
  const excel = excelFiles[0]?.excel ?? null;
  if (excelFiles.length > 1) {
    for (const f of excelFiles.slice(1)) {
      f.status = "rejected";
      f.note = "Bitte je Lauf nur eine Excel-Datei hochladen.";
    }
  }
  if (excel) {
    const known = new Set(existing.patients.map((p) => p.externalIds.legacyExcel).filter((x) => x !== undefined).map(String));
    // ohne Legacy-ID: Abgleich über Name + Geburtsdatum (wie persistImport mit skipExisting)
    const already = excel.patients.filter((p) =>
      p.legacyId !== null
        ? known.has(String(p.legacyId))
        : !!p.birthDate && ((byPerson.get(personKey(p.firstName, p.lastName, p.birthDate)!) ?? []).length > 0 || erasedPersons.has(personKey(p.firstName, p.lastName, p.birthDate)!)),
    ).length;
    totals.excel = {
      patientsNew: excel.patients.length - already,
      patientsExisting: already,
      services: excel.services.length,
      vouchers: excel.vouchers.length,
      invoices: excel.invoices.length,
      fixedCosts: excel.fixedCosts.length,
    };
    if (excel.invoices.length) warnings.push({ message: "Excel-Rechnungsmanager: Rechnungen werden wie beim bisherigen Excel-Import mit ihrer Nummer als ausgestellte Rechnungen übernommen; vorhandene Nummern werden übersprungen." });
  }

  const cashbook = active.find((d) => d.cashbook)?.cashbook ?? null;

  const files: FileSummary[] = detected.map((d) => ({ name: d.name, label: d.label, target: d.target, status: d.status, records: d.records, note: d.note }));
  const hasWork =
    patientsCreate.length + patientsLink.length + appointments.length + prescriptions.length + documents.length > 0 ||
    !!(excel && (totals.excel!.patientsNew || excel.services.length || excel.vouchers.length || excel.invoices.length || excel.fixedCosts.length));
  return { files, patientsCreate, patientsLink, appointments, prescriptions, documents, decisions, excel, cashbook, totals, warnings, samples, hasWork };
}

function dedupe<T>(list: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
