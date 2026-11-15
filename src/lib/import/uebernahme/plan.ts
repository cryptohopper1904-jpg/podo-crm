/**
 * Übernahme-Plan: führt die erkannten Dateien zusammen und gleicht sie mit dem Bestand der Praxis ab – rein, ohne DB.
 * Derselbe Plan dient der Vorschau und (innerhalb der Import-Transaktion neu berechnet) dem Import.
 *
 * Grundsätze:
 *  - Ergänzen, nie überschreiben oder löschen. Schon übernommene Datensätze (gleiche Quelle + ID) werden übersprungen.
 *  - Patient:innen mit gleicher Quelle-ID → vorhanden; sonst exakt gleicher Vor-/Nachname + Geburtsdatum bei genau einer
 *    bestehenden Person → verknüpfen (nur die Quell-ID wird ergänzt); sonst neu anlegen. Weitere Treffer nach den
 *    Kriterien von findDuplicates (Nachname+Geburtsdatum, E-Mail, Mobilnummer) erscheinen als Warnung.
 *  - Verordnungen → Patient:in über Name + Geburtsdatum (Tinana exportiert keine Patienten-ID); nicht eindeutig → nicht übernommen.
 *  - Rechnungen aus Fremdsystemen werden nie PodoHero-Rechnungen: nur deren PDFs landen als Dokument bei der Patient:in,
 *    wenn die Zuordnung (Rechnungsnummer → eindeutiger Name) sicher ist.
 */
import { findDuplicates as findFileDuplicates } from "../excel/parse";
import type { ImportResult, PatientImportDraft } from "../excel/types";
import { doctolibPatientValues } from "@/integrations/doctolib/patient-values";
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
function dbDuplicateHint(v: PatientCreate["values"], existing: ExistingPatient[]): string | null {
  const hit = existing.find(
    (e) =>
      (v.birthDate && e.birthDate === v.birthDate && normName(e.lastName) === normName(v.lastName)) ||
      (v.email && e.email && e.email.toLowerCase() === v.email.toLowerCase()) ||
      (v.phoneMobile && e.phoneMobile && e.phoneMobile === v.phoneMobile),
  );
  return hit ? `mögliche Dublette zu Nr. ${hit.number}` : null;
}

export function buildPlan(detected: DetectedFile[], existing: ExistingSnapshot, opts: { prescriptionMode: PrescriptionMode; now?: Date }): ImportPlan {
  const now = opts.now ?? new Date();
  const warnings: ImportIssue[] = [];
  const active = detected.filter((d) => d.status !== "duplicate" && d.status !== "rejected");
  for (const d of active) warnings.push(...d.issues);

  const totals: PlanTotals = {
    patientsNew: 0,
    patientsLinked: 0,
    patientsExisting: 0,
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
  for (const e of existing.patients) {
    for (const k of ["tinana", "doctolib"]) {
      const v = e.externalIds[k];
      if (typeof v === "string" || typeof v === "number") byExt.set(`${k}:${v}`, e);
    }
    const pk = personKey(e.firstName, e.lastName, e.birthDate);
    if (pk) byPerson.set(pk, [...(byPerson.get(pk) ?? []), e]);
    const nk = nameKey(e.firstName, e.lastName);
    byName.set(nk, [...(byName.get(nk) ?? []), e]);
  }

  const patientsCreate: PatientCreate[] = [];
  const patientsLink: PatientLink[] = [];
  /** Quell-ID („tinana:…“) → Ziel */
  const target = new Map<string, PatientRef>();
  /** Personenschlüssel/Name → Ziele aus dem Upload (für Verordnungen/Rechnungen) */
  const uploadByPerson = new Map<string, PatientRef[]>();
  const uploadByName = new Map<string, PatientRef[]>();
  const refKey = (r: PatientRef) => ("existingId" in r ? `e:${r.existingId}` : `r:${r.ref}`);
  const addIndex = (map: Map<string, PatientRef[]>, key: string | null, r: PatientRef) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    if (!list.some((x) => refKey(x) === refKey(r))) list.push(r);
    map.set(key, list);
  };

  const resolvePatient = (key: "tinana" | "doctolib", extId: string, values: PatientCreate["values"], sourceLabel: string, linkable = true): PatientRef => {
    const ext = `${key}:${extId}`;
    const known = target.get(ext);
    if (known) return known;
    let ref: PatientRef;
    const hit = byExt.get(ext);
    const person = personKey(values.firstName, values.lastName, values.birthDate);
    const sameperson = person ? byPerson.get(person) ?? [] : [];
    if (hit) {
      ref = { existingId: hit.id };
      totals.patientsExisting++;
    } else if (sameperson.length === 1 && !linkable) {
      // ohne Quell-ID (z. B. Doctolib-Zeile ohne ID): gleiche Person schon vorhanden → nichts anlegen, nichts verknüpfen
      ref = { existingId: sameperson[0].id };
      totals.patientsExisting++;
    } else if (sameperson.length === 1 && sameperson[0].externalIds[key] === undefined) {
      ref = { existingId: sameperson[0].id };
      patientsLink.push({ patientId: sameperson[0].id, key, externalId: extId });
      totals.patientsLinked++;
      warnings.push({ message: `${pseudonym(values.firstName, values.lastName, values.birthDate)}: bereits als Nr. ${sameperson[0].number} vorhanden – verknüpft, nichts überschrieben.` });
    } else {
      ref = { ref: ext };
      patientsCreate.push({ ref: ext, sourceLabel, pseudonym: pseudonym(values.firstName, values.lastName, values.birthDate), values });
      totals.patientsNew++;
      if (sameperson.length > 1) warnings.push({ message: `${pseudonym(values.firstName, values.lastName, values.birthDate)}: mehrere gleichnamige Personen mit diesem Geburtsdatum vorhanden – neu angelegt, bitte prüfen.` });
      else {
        const hint = dbDuplicateHint(values, existing.patients);
        if (hint) warnings.push({ message: `${pseudonym(values.firstName, values.lastName, values.birthDate)}: ${hint} – neu angelegt, bitte prüfen und ggf. zusammenführen.` });
      }
    }
    target.set(ext, ref);
    addIndex(uploadByPerson, person, ref);
    addIndex(uploadByName, nameKey(values.firstName, values.lastName), ref);
    return ref;
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
  let doctolibRow = 0;
  for (const d of active.flatMap((f) => f.doctolibPatients ?? [])) {
    doctolibRow++;
    const v = doctolibPatientValues(d);
    const values: PatientCreate["values"] = { ...v, insuranceType: v.insuranceType, externalIds: v.externalIds as Record<string, string> };
    resolvePatient("doctolib", d.externalId ?? `ohne-id-${doctolibRow}`, values, "Doctolib", !!d.externalId);
  }

  // Dubletten innerhalb des Uploads (gleiche Kriterien wie beim Excel-Import)
  const pseudoDrafts = patientsCreate.map((c, i) => ({ row: i + 1, legacyId: null, lastName: c.values.lastName, firstName: c.values.firstName, birthDate: c.values.birthDate, email: c.values.email, phoneMobile: c.values.phoneMobile, phoneLandline: c.values.phoneLandline }) as unknown as PatientImportDraft);
  for (const g of findFileDuplicates(pseudoDrafts)) {
    const who = g.rows.map((r) => patientsCreate[r - 1].pseudonym).join(", ");
    warnings.push({ message: `Mögliche Dublette im Upload (${g.reason === "name_birthdate" ? "Name + Geburtsdatum" : g.reason === "email" ? "E-Mail" : "Telefon"}): ${who} – werden getrennt angelegt, bitte danach zusammenführen.` });
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
  for (const a of dedupe(active.flatMap((d) => d.tinanaAppointments ?? []), (x) => x.id)) {
    const externalId = `tinana:${a.id}`;
    if (existing.appointmentRefs.has(externalId)) {
      totals.appointmentsExisting++;
      continue;
    }
    const patient = a.patientId ? target.get(`tinana:${a.patientId}`) ?? (byExt.get(`tinana:${a.patientId}`) ? { existingId: byExt.get(`tinana:${a.patientId}`)!.id } : null) : null;
    if (!patient) {
      totals.appointmentsUnassigned++;
      warnings.push({ row: a.row, message: `Termin ${dateDe(a.startsAt)} (${pseudonym(a.patientFirstName, a.patientLastName)}): Patient:in nicht in der Patientendatei – nicht übernommen. Bitte die Patientendatei desselben Standorts mit hochladen.` });
      continue;
    }
    const st = mapAppointmentStatus(a.statusRaw, a.startsAt, now);
    if (st.assumed && st.status === "done") pastPlanned++;
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
      title: a.title,
      notes,
      homeVisit: a.homeVisit,
      serviceIds,
    });
    totals.appointmentsNew++;
    if (samples.appointments.length < 5) samples.appointments.push(`${dateDe(a.startsAt)} · ${pseudonym(a.patientFirstName, a.patientLastName)} · ${STATUS_DE[st.status]}`);
  }
  if (pastPlanned) warnings.push({ message: `${pastPlanned} vergangene Termine standen in Tinana noch auf „Geplant“ – als erledigt übernommen (Hinweis in der Terminnotiz).` });
  if (unmatchedTherapists.size) {
    warnings.push({ message: `Behandler:in ohne gleichnamiges Teammitglied: ${[...unmatchedTherapists].slice(0, 10).join(", ")} – Termine ohne Behandler:in übernommen. Lege das Team vorher unter Einstellungen → Team an, wenn die Termine zugeordnet werden sollen.` });
  }

  // ───── Verordnungen ─────
  const doctors = active.flatMap((d) => d.tinanaDoctors ?? []);
  const lanrByDoctor = new Map<string, Set<string>>();
  for (const d of doctors) if (d.lanr) lanrByDoctor.set(normName(d.name), (lanrByDoctor.get(normName(d.name)) ?? new Set()).add(d.lanr));
  const prescriptions: PrescriptionCreate[] = [];
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
        doctorName: p.doctorName,
        doctorLanr: lanr,
        doctorBsnr: p.doctorBsnr,
        diagnosisGroup: p.diagnosisGroup!,
        icd10: p.icd10,
        remedy: p.positions.map((x) => x.label).join(", ") || null,
        units: p.units!,
        frequencyPerWeek: p.frequency,
        homeVisit: p.homeVisit,
        urgent: p.urgent,
        copaymentExempt: p.copaymentExempt,
        therapyReportRequested: p.therapyReportRequested,
        positions: p.positions.map((x) => ({ ...(x.position ? { position: x.position } : {}), label: x.label, units: x.units })),
        status: opts.prescriptionMode,
        importData: {
          source: "tinana",
          formType: p.formType,
          insurerName: p.insurerName,
          payerIk: p.payerIk,
          insuranceNumber: p.insuranceNumber,
          prices: p.positions.map((x) => ({ position: x.position, code: x.code, priceCents: x.priceCents })),
          raw: p.raw,
          billedOutside: opts.prescriptionMode === "billed",
        },
      },
    });
    totals.prescriptionsNew++;
    if (samples.prescriptions.length < 5) samples.prescriptions.push(`${p.issuedAt} · ${p.diagnosisGroup} · ${p.units} Einheiten · ${who}`);
  }

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
    const nk = nameKey(inv.patientFirstName, inv.patientLastName);
    const cands: PatientRef[] = [];
    const add = (r: PatientRef) => {
      if (!cands.some((c) => refKey(c) === refKey(r))) cands.push(r);
    };
    if (inv.patientLastName) {
      for (const r of uploadByName.get(nk) ?? []) add(r);
      for (const e of byName.get(nk) ?? []) add({ existingId: e.id });
    }
    // „sicher“ heißt: genau eine Person dieses Namens (Upload und Bestand zusammen)
    const unique = cands.length === 1 ? cands[0] : null;
    if (!unique) {
      totals.documentsUnassigned++;
      f.note = inv.type && /abrechnung/i.test(inv.type) ? "GKV-Abrechnung an die Kasse – keiner Patient:in zugeordnet, nicht übernommen." : `Rechnung ${inv.number}: Patient:in nicht eindeutig – nicht übernommen.`;
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
  if (invoices.length) warnings.push({ message: `${invoices.length} Rechnungen aus Tinana: nur zur Info – sie werden nicht als PodoHero-Rechnungen, Zahlungen oder Kassenbuchungen angelegt.` });

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
    const already = excel.patients.filter((p) => p.legacyId !== null && known.has(String(p.legacyId))).length;
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
  return { files, patientsCreate, patientsLink, appointments, prescriptions, documents, excel, cashbook, totals, warnings, samples, hasWork };
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
