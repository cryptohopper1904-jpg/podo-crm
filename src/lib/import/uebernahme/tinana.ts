/**
 * Tinana-Datenexport (Einstellungen → Allgemein → Datenexport): Parser für Patienten, Termine, Verordnungen,
 * Ärzte und Rechnungen. Format laut Analyse: UTF-8 mit BOM, „;“, Datum TT.MM.JJJJ, Zeitpunkte TT.MM.JJJJ HH:MM
 * (Berliner Ortszeit), Ja/Nein, Dezimalpunkt ohne Tausendertrennung. Tolerant gegen von Excel neu gespeicherte Dateien
 * (ohne BOM, Dezimalkomma, TT.MM.JJ).
 */
import { createHash } from "node:crypto";
import { isMobileNumber, parseDateLoose, parseDateTimeLoose } from "@/integrations/doctolib/csv";
import type { ImportIssue, TinanaAppointment, TinanaDoctor, TinanaInvoice, TinanaPatient, TinanaPrescription } from "./types";
import type { Delimiter } from "@/integrations/csv";
import { readTable, type Table } from "./text";

const nz = (v: string | undefined | null): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};
export const yes = (v: string | null | undefined) => /^(ja|yes|true|1|x)$/i.test((v ?? "").trim());

/** „51.92“, „57.2“, „51,92“ → Cent; Tinana kennt keine Tausendertrennung. */
export function decimalCents(v: string | null | undefined): number | null {
  const s = (v ?? "").replace(/[€\s]/g, "").replace(/EUR/i, "");
  if (!s) return null;
  const n = Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function int(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * Normalisierung für Namensvergleiche: Groß/Klein, Umlaute wie ihre Umschreibung (Müller = Mueller), ß = ss, Akzente,
 * Bindestriche wie Leerzeichen (Anna-Maria = Anna Maria), mehrfache Leerzeichen.
 */
const normCache = new Map<string, string>();

export function normName(s: string | null | undefined): string {
  if (!s) return "";
  // Exporte wiederholen dieselben Namen tausendfach – Ergebnis zwischenspeichern (begrenzt, A-B1)
  const hit = normCache.get(s);
  if (hit !== undefined) return hit;
  const out = normNameRaw(s);
  if (normCache.size >= 20_000) normCache.clear();
  normCache.set(s, out);
  return out;
}

function normNameRaw(s: string): string {
  return s
    // zuerst NFC: „ü“ als u + Trema (NFD, z. B. aus macOS-Exporten) wird sonst nicht zu „ue“ (S2)
    .normalize("NFC")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[-‐‑‒–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Quell-IDs (Tinana patienten_id/termin_id, Doctolib-ID) landen in external_ids bzw. external_id: höchstens 100 Zeichen,
 * nur Buchstaben, Ziffern und . _ : - (UUIDs, Zahlen). Andere Werte → Zeile mit Hinweis übersprungen (AppSec A-H6).
 */
export const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
export const validSourceId = (v: string | null | undefined): v is string => !!v && SOURCE_ID_RE.test(v);

// ───────────── Patienten ─────────────
function salutationOf(v: string | null): TinanaPatient["salutation"] {
  const s = normName(v);
  return s === "herr" ? "Herr" : s === "frau" ? "Frau" : s === "divers" ? "Divers" : null;
}
function genderOf(v: string | null): TinanaPatient["gender"] {
  const s = normName(v);
  return s.startsWith("weib") ? "female" : s.startsWith("maenn") || s.startsWith("mann") ? "male" : s === "divers" ? "diverse" : null;
}
function insuranceOf(v: string | null): TinanaPatient["insuranceType"] {
  const s = normName(v);
  if (s === "gkv" || s.includes("gesetz")) return "gkv";
  if (s.startsWith("priv") || s === "pkv") return "pkv";
  return "self";
}

export function parseTinanaPatients(text: string | Table, file?: string, delimiter?: Delimiter): { patients: TinanaPatient[]; issues: ImportIssue[] } {
  const t = typeof text === "string" ? readTable(text, delimiter) : text;
  const issues: ImportIssue[] = [];
  const patients: TinanaPatient[] = [];
  for (const r of t.records) {
    const v = (k: string) => nz(r.values[k]);
    if (Object.values(r.values).every((x) => !x)) continue;
    const id = v("patienten_id");
    const lastName = v("nachname");
    if (!id) {
      issues.push({ file, row: r.row, message: "Patienten-ID fehlt – Zeile übersprungen." });
      continue;
    }
    if (!validSourceId(id)) {
      issues.push({ file, row: r.row, message: "Patienten-ID ungültig (zu lang oder unzulässige Zeichen) – Zeile übersprungen." });
      continue;
    }
    if (!lastName) {
      issues.push({ file, row: r.row, message: "Nachname fehlt (Pflichtfeld) – Zeile übersprungen." });
      continue;
    }
    const birthRaw = v("geburtsdatum");
    const birthDate = parseDateLoose(birthRaw);
    if (birthRaw && !birthDate) issues.push({ file, row: r.row, message: "Geburtsdatum nicht lesbar – leer übernommen." });
    let phoneMobile: string | null = null;
    let phoneLandline: string | null = null;
    const otherPhones: string[] = [];
    for (const n of [1, 2, 3, 4]) {
      const num = v(`telefon_${n}`);
      if (!num) continue;
      const label = normName(v(`telefon_${n}_label`));
      const mobile = label.startsWith("mobil") || label.startsWith("handy") ? true : label.startsWith("festnetz") ? false : isMobileNumber(num);
      if (mobile && !phoneMobile) phoneMobile = num;
      else if (!mobile && !phoneLandline) phoneLandline = num;
      else otherPhones.push(`${v(`telefon_${n}_label`) ?? "Telefon"}: ${num}`);
    }
    const email = v("email")?.toLowerCase() ?? null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) issues.push({ file, row: r.row, message: "E-Mail-Adresse ungültig – nicht übernommen." });
    const insuranceRaw = v("versicherungstyp");
    patients.push({
      row: r.row,
      id,
      salutation: salutationOf(v("anrede")),
      title: v("titel"),
      firstName: v("vorname"),
      lastName,
      gender: genderOf(v("geschlecht")),
      birthDate,
      street: [v("strasse"), v("hausnummer")].filter(Boolean).join(" ") || null,
      zip: v("plz"),
      city: v("stadt"),
      location: v("standort"),
      email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
      phoneMobile,
      phoneLandline,
      otherPhones,
      notes: v("notiz"),
      vip: yes(v("vip")),
      insuranceType: insuranceOf(insuranceRaw),
      insuranceRaw,
      createdAt: v("erstellt_am"),
    });
  }
  return { patients, issues };
}

// ───────────── Termine ─────────────
export function parseTinanaAppointments(text: string | Table, file?: string, delimiter?: Delimiter): { appointments: TinanaAppointment[]; issues: ImportIssue[] } {
  const t = typeof text === "string" ? readTable(text, delimiter) : text;
  const issues: ImportIssue[] = [];
  const appointments: TinanaAppointment[] = [];
  for (const r of t.records) {
    const v = (k: string) => nz(r.values[k]);
    if (Object.values(r.values).every((x) => !x)) continue;
    const id = v("termin_id");
    if (!id) {
      issues.push({ file, row: r.row, message: "Termin-ID fehlt – Zeile übersprungen." });
      continue;
    }
    const patientId = v("patienten_id");
    if (!validSourceId(id) || (patientId !== null && !validSourceId(patientId))) {
      issues.push({ file, row: r.row, message: "Termin- oder Patienten-ID ungültig (zu lang oder unzulässige Zeichen) – Zeile übersprungen." });
      continue;
    }
    const startsAt = parseDateTimeLoose(v("startzeit"));
    let endsAt = parseDateTimeLoose(v("endzeit"));
    if (!startsAt) {
      issues.push({ file, row: r.row, message: "Startzeit nicht lesbar – Termin übersprungen." });
      continue;
    }
    if (!endsAt || new Date(endsAt) <= new Date(startsAt)) {
      endsAt = new Date(new Date(startsAt).getTime() + 30 * 60_000).toISOString();
      issues.push({ file, row: r.row, message: "Endzeit fehlt oder liegt vor dem Beginn – 30 Minuten angenommen." });
    }
    const travel = ["anfahrt_minuten", "rueckfahrt_minuten", "anfahrt_km", "rueckfahrt_km"].some((k) => v(k))
      ? `Anfahrt ${v("anfahrt_minuten") ?? "–"} Min./${v("anfahrt_km") ?? "–"} km, Rückfahrt ${v("rueckfahrt_minuten") ?? "–"} Min./${v("rueckfahrt_km") ?? "–"} km`
      : null;
    appointments.push({
      row: r.row,
      id,
      patientId,
      agendaLabel: v("agenda_label"),
      title: v("titel"),
      startsAt,
      endsAt,
      statusRaw: v("status") ?? "",
      location: v("standort"),
      patientFirstName: v("patient_vorname"),
      patientLastName: v("patient_nachname"),
      therapistName: [v("mitarbeiter_vorname"), v("mitarbeiter_nachname")].filter(Boolean).join(" ") || null,
      remedies: v("heilmittel"),
      documentation: v("dokumentation"),
      description: v("beschreibung"),
      homeVisit: yes(v("hausbesuch")),
      travel,
    });
  }
  return { appointments, issues };
}

/**
 * Tinana-Terminstatus → PodoHero. Vergangene Termine werden nie „geplant“ übernommen (sonst tauchen sie als offen auf):
 * „Geplant“ in der Vergangenheit → erledigt, mit Hinweis.
 */
export function mapAppointmentStatus(raw: string, startsAt: string, now: Date): { status: "planned" | "done" | "cancelled" | "no_show"; assumed: boolean } {
  const s = normName(raw);
  if (/(abgesagt|storniert|cancel|absage)/.test(s)) return { status: "cancelled", assumed: false };
  if (/(nicht erschienen|no.?show|ausgefallen|versaeumt|verpasst)/.test(s)) return { status: "no_show", assumed: false };
  if (/(stattgefunden|erledigt|abgeschlossen|durchgefuhrt|durchgefuehrt|done|completed)/.test(s)) return { status: "done", assumed: false };
  const past = new Date(startsAt).getTime() < now.getTime();
  return past ? { status: "done", assumed: true } : { status: "planned", assumed: s !== "geplant" && s !== "" && s !== "bestatigt" && s !== "bestaetigt" };
}

// ───────────── Verordnungen ─────────────
/** Datumswerte wiederholen sich in einer Datei vielfach – je Parserlauf zwischenspeichern (A-B1) */
interface DateMemo {
  date: (v: string | null | undefined) => string | null;
  dateTime: (v: string | null | undefined) => string | null;
}
function dateMemo(): DateMemo {
  const d = new Map<string, string | null>();
  const dt = new Map<string, string | null>();
  const cached = (m: Map<string, string | null>, f: (v: string) => string | null) => (v: string | null | undefined) => {
    if (!v) return f(v ?? "");
    let r = m.get(v);
    if (r === undefined) {
      r = f(v);
      if (m.size < 50_000) m.set(v, r);
    }
    return r;
  };
  return { date: cached(d, (v) => parseDateLoose(v)), dateTime: cached(dt, (v) => parseDateTimeLoose(v)) };
}

/**
 * Gruppenschlüssel einer Verordnung (Tinana exportiert keine ID): aus GEPARSTEN Werten, damit dieselbe Datei nach dem
 * Öffnen und Speichern in Excel (TT.MM.JJ statt TT.MM.JJJJ, ohne Sekunden …) denselben Schlüssel ergibt (Code-Review CR4).
 */
function groupKey(r: Record<string, string>, memo: DateMemo): string {
  const created = memo.dateTime(r["erstellt_am"]) ?? r["erstellt_am"] ?? "";
  const parts = [
    normName(r["patient_vorname"]),
    normName(r["patient_nachname"]),
    memo.date(r["patient_geburtsdatum"]) ?? "",
    normName(r["versichertennummer"]),
    memo.date(r["ausstelldatum"]) ?? "",
    normName(r["arzt_titel"]),
    normName(r["arzt_vorname"]),
    normName(r["arzt_nachname"]),
    normName(r["diagnosegruppe"]),
    normName(r["icd10_codes"]),
    created,
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

/**
 * Feste Auswahl strukturierter Formularangaben für prescriptions.import_data (Nachvollziehbarkeit). Bewusst KEINE
 * Freitexte (Leitsymptomatik im Wortlaut, weitere Diagnosen, Therapieziele) und keine sonstigen Rohspalten (Recht).
 */
const FIELD_WHITELIST: Record<string, string> = {
  formulartyp: "formType",
  standort: "location",
  statusfeld: "statusField",
  leitsymptom_code: "leadSymptomCode",
  gesamte_therapiedauer: "totalDuration",
  langzeitverordnung: "longTerm",
  unfallbedingt: "accident",
  bvg: "bvg",
  telefonverordnung: "phonePrescription",
  leistungserbringer_ik: "providerIk",
  therapieart: "therapyType",
  erstellt_am: "createdAt",
};

export function parseTinanaPrescriptions(text: string | Table, file?: string, delimiter?: Delimiter): { prescriptions: TinanaPrescription[]; issues: ImportIssue[] } {
  const t = typeof text === "string" ? readTable(text, delimiter) : text;
  const issues: ImportIssue[] = [];
  const groups = new Map<string, TinanaPrescription>();
  const memo = dateMemo();
  /** Positionsnummern je Verordnung (Set statt Suche in der Liste – lineare Laufzeit, A-B1) */
  const positionsSeen = new Map<string, Set<string>>();
  for (const r of t.records) {
    const v = (k: string) => nz(r.values[k]);
    if (Object.values(r.values).every((x) => !x)) continue;
    const key = groupKey(r.values, memo);
    let g = groups.get(key);
    if (!g) {
      const dg = v("diagnosegruppe");
      const doctor = [v("arzt_titel"), v("arzt_vorname"), v("arzt_nachname")].filter(Boolean).join(" ") || null;
      const fields: Record<string, string> = {};
      for (const [col, k] of Object.entries(FIELD_WHITELIST)) {
        const x = v(col);
        if (x) fields[k] = x.slice(0, 200);
      }
      g = {
        rows: [],
        key,
        formType: v("formulartyp"),
        location: v("standort"),
        issuedAt: parseDateLoose(v("ausstelldatum")),
        patientFirstName: v("patient_vorname"),
        patientLastName: v("patient_nachname"),
        patientBirthDate: parseDateLoose(v("patient_geburtsdatum")),
        doctorName: doctor,
        doctorLanr: v("arztnummer"),
        doctorBsnr: v("betriebsstaettennummer"),
        insurerName: v("krankenkasse"),
        payerIk: v("kostentraeger_id"),
        insuranceNumber: v("versichertennummer"),
        // „UI1 – Unguis incarnatus …“ → „UI1“ (Gedankenstrich oder Bindestrich)
        diagnosisGroup: dg ? dg.split(/\s+[–-]\s+/)[0].trim() || null : null,
        icd10: v("icd10_codes"),
        units: int(v("behandlungseinheiten")),
        frequency: v("therapiefrequenz"),
        homeVisit: yes(v("hausbesuch")),
        urgent: yes(v("dringend")) || yes(v("dringende_behandlung_noetig")),
        copaymentExempt: yes(v("zuzahlungsbefreit")),
        therapyReportRequested: yes(v("therapiebericht_angefordert")),
        positions: [],
        fields,
      };
      groups.set(key, g);
    }
    g.rows.push(r.row);
    const label = v("heilmittel_name");
    if (label) {
      const position = v("heilmittel_positionsnummer");
      let seen = positionsSeen.get(key);
      if (!seen) positionsSeen.set(key, (seen = new Set()));
      if (position && seen.has(position)) {
        issues.push({ file, row: r.row, message: `Heilmittel ${position} doppelt in derselben Verordnung – evtl. zwei gleiche Verordnungen am selben Tag (zusammengefasst).` });
      }
      if (position) seen.add(position);
      g.positions.push({ position, code: v("heilmittel_kuerzel"), label, units: int(v("heilmittel_menge")) ?? 0, priceCents: decimalCents(v("heilmittel_preis")) });
    }
  }
  const prescriptions = [...groups.values()];
  for (const p of prescriptions) {
    if (p.units === null) p.units = p.positions.reduce((a, x) => Math.max(a, x.units), 0) || null;
    if (!p.issuedAt) issues.push({ file, row: p.rows[0], message: "Ausstelldatum fehlt – Verordnung wird nicht übernommen." });
    if (!p.diagnosisGroup) issues.push({ file, row: p.rows[0], message: "Diagnosegruppe fehlt – Verordnung wird nicht übernommen." });
    if (!p.units) issues.push({ file, row: p.rows[0], message: "Behandlungseinheiten fehlen – Verordnung wird nicht übernommen." });
    if (p.formType && !/muster\s*13/i.test(p.formType)) issues.push({ file, row: p.rows[0], message: `Formular „${p.formType}“ (nicht Muster 13) – bitte nach dem Import prüfen.` });
  }
  return { prescriptions, issues };
}

/** Pflichtangaben für eine Verordnung in PodoHero vorhanden? */
export const prescriptionComplete = (p: TinanaPrescription) => !!p.issuedAt && !!p.diagnosisGroup && !!p.units;

// ───────────── Ärzte (nur Nachschlagetabelle für LANR/BSNR) ─────────────
export function parseTinanaDoctors(text: string | Table, delimiter?: Delimiter): TinanaDoctor[] {
  const t = typeof text === "string" ? readTable(text, delimiter) : text;
  return t.records
    .map((r) => ({
      name: [nz(r.values.titel), nz(r.values.vorname), nz(r.values.nachname)].filter(Boolean).join(" "),
      lanr: nz(r.values.arztnummer),
      bsnr: nz(r.values.betriebsstaettennummer),
    }))
    .filter((d) => d.name);
}

// ───────────── Rechnungen (nur Info/Archiv) ─────────────
export function parseTinanaInvoices(text: string | Table, delimiter?: Delimiter): TinanaInvoice[] {
  const t = typeof text === "string" ? readTable(text, delimiter) : text;
  const out: TinanaInvoice[] = [];
  for (const r of t.records) {
    const number = nz(r.values.rechnungsnummer);
    if (!number) continue;
    out.push({
      row: r.row,
      number,
      status: nz(r.values.status),
      type: nz(r.values.typ),
      totalCents: decimalCents(r.values.gesamtbetrag),
      patientFirstName: nz(r.values.patient_vorname),
      patientLastName: nz(r.values.patient_nachname),
      createdAt: nz(r.values.erstellt_am),
      paidAt: nz(r.values.bezahlt_am),
    });
  }
  return out;
}

