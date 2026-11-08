/**
 * Doctolib CSV-Import/-Export (Patientenexport, 22 Spalten) und generischer Termin-CSV-Import.
 * Ersatz für die nur Partnern zugängliche Doctolib-API (PLAN 6.2).
 */
import { parseCsvObjects, writeCsv, type Delimiter } from "../csv";
import { berlinLocalToIso } from "../time";
import type { AppointmentCandidate, CsvImportIssue, Gender, PatientDraft } from "../types";

export const DOCTOLIB_PATIENT_COLUMNS = [
  "id",
  "import_identifier",
  "gender",
  "last_name",
  "maiden_name",
  "first_name",
  "birthdate",
  "email",
  "phone_number",
  "secondary_phone_number",
  "address",
  "zipcode",
  "city",
  "insurance_type",
  "insurance_sector",
  "crucial_info",
  "referrer",
  "occupation",
  "regular_doctor_name",
  "regular_doctor_city",
  "notes",
  "no_notifications_for_doctor_appointment",
] as const;

export type DoctolibPatientColumn = (typeof DOCTOLIB_PATIENT_COLUMNS)[number];

const nz = (v: string | undefined | null): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/** Datum in YYYY-MM-DD; akzeptiert ISO, TT.MM.JJJJ, TT/MM/JJJJ. Ungültig → null. */
export function parseDateLoose(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  let mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (mt) [y, m, d] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  else if ((mt = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/))) {
    d = Number(mt[1]);
    m = Number(mt[2]);
    y = Number(mt[3]);
    if (mt[3].length === 2) y += y > (new Date().getFullYear() % 100) ? 1900 : 2000;
  } else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Erkennt deutsche Mobilnummern (015x, 016x, 017x bzw. +49 15/16/17). */
export function isMobileNumber(phone: string): boolean {
  const digits = phone.replace(/[^\d+]/g, "").replace(/^\+49|^0049/, "0");
  return /^01[5-7]/.test(digits);
}

function parseGender(v: string | null): Gender {
  const s = (v ?? "").toLowerCase();
  if (/^(f|w|female|frau|weiblich|woman|mme|madame)$/.test(s)) return "female";
  if (/^(m|male|herr|männlich|man|mr|monsieur)$/.test(s)) return "male";
  if (/^(d|x|diverse|divers|other|non[-_ ]?binary)$/.test(s)) return "diverse";
  return "unknown";
}

function parseInsurance(type: string | null, sector: string | null): PatientDraft["insuranceType"] {
  const s = `${type ?? ""} ${sector ?? ""}`.toLowerCase();
  if (/beihilfe/.test(s)) return "beihilfe";
  if (/(public|gesetzlich|gkv|statutory)/.test(s)) return "gkv";
  if (/(private|privat|pkv)/.test(s)) return "pkv";
  if (/(self|selbst|none|keine)/.test(s)) return "self";
  return null;
}

const truthy = (v: string | null) => /^(1|true|yes|ja|y|x|wahr)$/i.test((v ?? "").trim());

/** Doctolib-Patientenexport → Patientenentwürfe. */
export function parseDoctolibPatientsCsv(text: string): { patients: PatientDraft[]; issues: CsvImportIssue[] } {
  const { headers, records } = parseCsvObjects(text);
  const issues: CsvImportIssue[] = [];
  const norm = headers.map((h) => h.toLowerCase());
  const missing = ["last_name", "first_name"].filter((c) => !norm.includes(c));
  if (missing.length) {
    issues.push({ row: 1, message: `Pflichtspalten fehlen: ${missing.join(", ")}` });
    return { patients: [], issues };
  }
  const get = (values: Record<string, string>, col: DoctolibPatientColumn) => {
    const key = headers.find((h) => h.toLowerCase() === col);
    return key ? nz(values[key]) : null;
  };
  const patients: PatientDraft[] = [];
  for (const { row, values } of records) {
    if (Object.values(values).every((v) => v === "")) continue;
    const lastName = get(values, "last_name");
    if (!lastName) {
      issues.push({ row, message: "Nachname fehlt – Zeile übersprungen." });
      continue;
    }
    const gender = parseGender(get(values, "gender"));
    const birthRaw = get(values, "birthdate");
    const birthDate = parseDateLoose(birthRaw);
    if (birthRaw && !birthDate) issues.push({ row, message: `Ungültiges Geburtsdatum „${birthRaw}“.` });
    const phones = [get(values, "phone_number"), get(values, "secondary_phone_number")].filter((p): p is string => !!p);
    const mobile = phones.find(isMobileNumber) ?? null;
    const landline = phones.find((p) => p !== mobile) ?? null;
    patients.push({
      externalId: get(values, "id"),
      gender,
      salutation: gender === "female" ? "Frau" : gender === "male" ? "Herr" : gender === "diverse" ? "Divers" : null,
      lastName,
      maidenName: get(values, "maiden_name"),
      firstName: get(values, "first_name"),
      birthDate,
      email: get(values, "email")?.toLowerCase() ?? null,
      phoneMobile: mobile,
      phoneLandline: landline,
      street: get(values, "address"),
      zip: get(values, "zipcode"),
      city: get(values, "city"),
      insuranceType: parseInsurance(get(values, "insurance_type"), get(values, "insurance_sector")),
      insuranceSectorRaw: get(values, "insurance_sector"),
      crucialInfo: get(values, "crucial_info"),
      referrer: get(values, "referrer"),
      occupation: get(values, "occupation"),
      gpName: get(values, "regular_doctor_name"),
      gpCity: get(values, "regular_doctor_city"),
      notes: get(values, "notes"),
      noNotifications: truthy(get(values, "no_notifications_for_doctor_appointment")),
    });
  }
  return { patients, issues };
}

const genderOut = (g: Gender | undefined, salutation?: string | null): string => {
  const x = g && g !== "unknown" ? g : salutation === "Frau" ? "female" : salutation === "Herr" ? "male" : "";
  return x === "diverse" ? "other" : x;
};

const insuranceOut = (t: PatientDraft["insuranceType"]): string =>
  t === "gkv" ? "public" : t === "pkv" || t === "beihilfe" ? "private" : t === "self" ? "self_paying" : "";

/** Patienten → Doctolib-CSV (22 Spalten, Kopfzeile, Semikolon-getrennt mit BOM sofern nicht anders gewünscht). */
export function writeDoctolibPatientsCsv(
  patients: (PatientDraft & { importIdentifier?: string | number | null })[],
  opts: { delimiter?: Delimiter; bom?: boolean } = { delimiter: ",", bom: true },
): string {
  const rows: unknown[][] = [[...DOCTOLIB_PATIENT_COLUMNS]];
  for (const p of patients) {
    const rec: Record<DoctolibPatientColumn, unknown> = {
      id: p.externalId ?? "",
      import_identifier: p.importIdentifier ?? "",
      gender: genderOut(p.gender, p.salutation),
      last_name: p.lastName,
      maiden_name: p.maidenName ?? "",
      first_name: p.firstName ?? "",
      birthdate: p.birthDate ?? "",
      email: p.email ?? "",
      phone_number: p.phoneMobile ?? p.phoneLandline ?? "",
      secondary_phone_number: p.phoneMobile && p.phoneLandline ? p.phoneLandline : "",
      address: p.street ?? "",
      zipcode: p.zip ?? "",
      city: p.city ?? "",
      insurance_type: insuranceOut(p.insuranceType ?? null),
      insurance_sector: p.insuranceSectorRaw ?? "",
      crucial_info: p.crucialInfo ?? "",
      referrer: p.referrer ?? "",
      occupation: p.occupation ?? "",
      regular_doctor_name: p.gpName ?? "",
      regular_doctor_city: p.gpCity ?? "",
      notes: p.notes ?? "",
      no_notifications_for_doctor_appointment: p.noNotifications ? "true" : "false",
    };
    rows.push(DOCTOLIB_PATIENT_COLUMNS.map((c) => rec[c]));
  }
  return writeCsv(rows, { delimiter: opts.delimiter ?? ",", bom: opts.bom ?? true });
}

// ───────────── Termin-CSV (Format variiert je Export – Spaltennamen tolerant zuordnen) ─────────────
const APPT_ALIASES: Record<string, string[]> = {
  id: ["id", "appointment_id", "termin_id"],
  start: ["start", "start_date", "starts_at", "start_time", "beginn", "datum_uhrzeit"],
  date: ["date", "datum", "day"],
  time: ["time", "uhrzeit", "hour"],
  end: ["end", "end_date", "ends_at", "ende"],
  duration: ["duration", "dauer", "duration_min"],
  lastName: ["last_name", "patient_last_name", "nachname"],
  firstName: ["first_name", "patient_first_name", "vorname"],
  name: ["patient", "patient_name", "name"],
  email: ["email", "patient_email", "e-mail"],
  phone: ["phone", "phone_number", "telefon", "mobil"],
  reason: ["visit_motive", "motive", "reason", "grund", "besuchsgrund", "leistung"],
  status: ["status", "state"],
};

/** Parst Zeitangaben wie „2026-11-09 10:30“, „09.11.2026 10:30“, ISO mit Offset. */
export function parseDateTimeLoose(s: string | null, time?: string | null): string | null {
  if (!s) return null;
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(t)) return new Date(t).toISOString();
  const m = t.match(/^(.+?)[ T,]+(\d{1,2})[:.](\d{2})/);
  const datePart = m ? m[1] : t;
  const date = parseDateLoose(datePart);
  if (!date) return null;
  let hh = 0,
    mm = 0;
  if (m) {
    hh = Number(m[2]);
    mm = Number(m[3]);
  } else if (time) {
    const tm = time.match(/(\d{1,2})[:.](\d{2})/);
    if (!tm) return null;
    hh = Number(tm[1]);
    mm = Number(tm[2]);
  } else return null;
  const [y, mo, d] = date.split("-").map(Number);
  return berlinLocalToIso(y, mo, d, hh, mm);
}

export function parseAppointmentsCsv(text: string): { appointments: AppointmentCandidate[]; issues: CsvImportIssue[] } {
  const { headers, records } = parseCsvObjects(text);
  const issues: CsvImportIssue[] = [];
  const col = (k: string) => headers.find((h) => APPT_ALIASES[k].includes(h.toLowerCase()));
  const cols = Object.fromEntries(Object.keys(APPT_ALIASES).map((k) => [k, col(k)])) as Record<string, string | undefined>;
  if (!cols.start && !cols.date) {
    issues.push({ row: 1, message: "Keine Datums-/Startspalte gefunden." });
    return { appointments: [], issues };
  }
  const appointments: AppointmentCandidate[] = [];
  for (const { row, values } of records) {
    const v = (k: string) => (cols[k] ? nz(values[cols[k]!]) : null);
    if (Object.values(values).every((x) => x === "")) continue;
    const warnings: string[] = [];
    const startsAt = cols.start ? parseDateTimeLoose(v("start")) : parseDateTimeLoose(v("date"), v("time"));
    if (!startsAt) {
      issues.push({ row, message: "Startzeit nicht lesbar – Zeile übersprungen." });
      continue;
    }
    let endsAt = parseDateTimeLoose(v("end"));
    const dur = Number(v("duration"));
    if (!endsAt && Number.isFinite(dur) && dur > 0) endsAt = new Date(new Date(startsAt).getTime() + dur * 60000).toISOString();
    if (!endsAt) warnings.push("Ende unbekannt – Standarddauer verwenden.");
    const name = v("name") ?? ([v("firstName"), v("lastName")].filter(Boolean).join(" ") || null);
    const status = (v("status") ?? "").toLowerCase();
    const kind: AppointmentCandidate["kind"] = /(cancel|abgesagt|storniert)/.test(status) ? "cancelled" : "booked";
    appointments.push({
      kind,
      startsAt,
      endsAt,
      patientName: name,
      patientEmail: v("email"),
      patientPhone: v("phone"),
      reason: v("reason"),
      externalId: v("id"),
      confidence: name ? 0.95 : 0.7,
      warnings,
    });
  }
  return { appointments, issues };
}
