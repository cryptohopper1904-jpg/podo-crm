/**
 * Pododesk-Gesamtexport („Praxisdaten exportieren“ an der Praxiskachel): ZIP mit aerzte.csv, leistungenPrivat.csv,
 * patienten.csv, praxisstammdaten.csv, termine.csv und users.csv. Format laut echtem Export (11/2026, nur Struktur):
 * UTF-8 mit BOM, „;“, Texte in Anführungszeichen, Zeitstempel ISO-8601 in UTC („2026-11-13T07:00:00.000Z“), Datum
 * JJJJ-MM-TT, Booleans true/false, Vergütung in Cent (Ganzzahl), MwSt als „19.00“, termine.leistungen als JSON-Array
 * `[{"istKKLeistung":false,"id":3}]`.
 *
 * Datensparsamkeit: Je Datei wird nur eine feste Auswahl von Spalten gelesen (PODODESK_COLUMNS). Alle anderen Spalten
 * – u. a. IBAN/BIC/Bank, PayPal, sevDesk-API-Schlüssel, iCal-Token, Auth-IDs, Einwilligungs-Schalter (emailErinnerung,
 * smsReminder, emailNewsletter, callReminder) – werden direkt nach dem Zerlegen verworfen (restrictColumns) und
 * erreichen weder Parser noch Plan, Vorschau oder Datenbank.
 */
import { isMobileNumber, parseDateLoose } from "@/integrations/doctolib/csv";
import { normName, validSourceId } from "./tinana";
import type { Table } from "./text";
import type { ImportIssue, PododeskAppointment, PododeskDoctor, PododeskPatient, PododeskPractice, PododeskService, PododeskUser } from "./types";
import { THERAPIST_COLORS, type TherapistColor } from "@/lib/therapist-colors";

/** Exakte Kopfzeilen des Gesamtexports (Reihenfolge wie im Export, Groß-/Kleinschreibung wie im Original) */
export const PODODESK_HEADERS = {
  aerzte: ["id", "vorname", "nachname", "titel", "strasse", "hausnummer", "postleitzahl", "ort", "telefon", "fax", "mobil", "email", "notizen", "praxisbezeichnung", "lanr", "bsnr", "website", "createdAt", "createdBy", "modifiedAt", "modifiedBy", "geschlecht"],
  leistungenPrivat: [
    "id", "kuerzel", "beschreibung", "regelbehandlungszeitMin", "regelbehandlungszeitMax", "mehrwertsteuer", "verguetung", "deleted", "createdAt", "createdBy", "modifiedAt", "modifiedBy", "debitoorId",
    "vorbereitungsbedarf", "vorbereitungsnotiz", "equipment", "disableForCalendarPlan", "appointmentColor", "onlineBookable", "onlineBookableTherapeuten", "onlineBookableNewPatients", "onlineBookableReturningPatients",
  ],
  patienten: [
    "id", "patientSeit", "vorname", "nachname", "geschlecht", "titel", "geburtsdatum", "strasse", "hausnummer", "postleitzahl", "ort", "telefon", "mobil", "email", "emailErinnerung", "emailNewsletter",
    "krankenkasse", "hausarzt", "facharzt", "frequenz", "empfehlung", "bisherigePodologie", "abgewandertZu", "bild", "verstorben", "notizen", "createdAt", "createdBy", "modifiedAt", "modifiedBy",
    "sozialeGemeinschaft", "land", "debitoorId", "maxFrequenz", "verstorbenAm", "beruf", "smsReminder", "km", "mobilCountry", "internationalMobil", "versichertennummer", "patientennummer", "callReminder",
    "regularTherapist", "internationalTelefon", "ikNummerKK", "versichertenstatus", "otherInsurance", "sevdeskId", "defaultDiscount",
  ],
  praxisstammdaten: [
    "id", "firmenbezeichnung", "kassenzulassung", "inhaber", "strasse", "hausnummer", "postleitzahl", "ort", "bundesland", "angeschlossenAn", "telefon", "fax", "mobil", "email", "website", "oeffnungszeiten",
    "institutionskennzeichen", "zfdMitgliedschaft", "vdpMitgliedschaft", "iban", "bic", "bank", "paypalEmail", "isAppointmentReminderEnabled", "standardBehandlungsdauer", "terminraster", "deaktivierteTodoTypen",
    "terminFindenDeaktiviert", "modifiedAt", "modifiedBy", "icsSources", "autoLockActive", "autoLockTimeout", "appointmentRemindersSchedule", "logo", "land", "smsReminder", "smsSchedule", "icsRetention",
    "callReminder", "countryCode", "getButikCustomer", "getButikUrl", "meditEasyCustomer", "callReminderSchedule", "treatmentRoomFeature", "roomFeatureEnabledAt", "roomSelectionMandatory", "emailReminderNote",
    "arniCustomer", "currency", "sevDeskApiKey", "sevDeskUser", "appointmentColorDependency", "footModelEnabled", "ruckAbbreviationsEnabled", "arniReimbursement", "discountUpperLimit",
    "disableRequiredCheckDokumentation", "datenschutzbeauftragter",
  ],
  termine: [
    "id", "beginn", "ende", "patient", "hausbesuch", "leistungen", "notizen", "therapeut", "absagegrund", "begruendungFrequenzueberschreitung", "createdAt", "createdBy", "modifiedAt", "modifiedBy", "absagedatum",
    "istOrganisatorisch", "teilnehmerOrganisatorischerTermin", "titelOrganisatorischerTermin", "heilmittelverordnung", "hvoWirdNachgereicht", "isAllDay", "dateShadesCalendar", "modifiedCount", "insocialcommunity",
    "preparationNeeded", "room", "sevdeskinvoiceId", "specificNksService", "products", "customerDiscount", "begruendungFrequenzunterschreitung", "gebuehrenbefreit", "privatrezept", "arniUebermittelt", "serie",
    "blocksOnlineBooking",
  ],
  users: [
    "id", "vorname", "nachname", "farbe", "authUserId", "istAdmin", "email", "strasse", "hausnummer", "postleitzahl", "ort", "telefon", "mobil", "istTherapeut", "praxisbezeichnung", "funktionInPraxis", "geschlecht",
    "wieVonPododeskErfahren", "agbAngenommen", "datenschutzbedingungenGelesen", "avatar", "avatarFallback", "arbeitszeiten", "iCalendarToken", "createdAt", "createdBy", "modifiedAt", "modifiedBy", "pinDefined",
    "disabled", "positionInOrder", "land", "debitoorCustomer", "freshdeskCustomer", "restoreid", "sevdeskCustomer", "behandeltBluter", "behandeltDiabetiker",
  ],
} as const;

export type PododeskFile = keyof typeof PODODESK_HEADERS;

/**
 * Gelesene Spalten je Datei (normalisiert, klein). Alles andere wird verworfen – insbesondere Bankdaten, Zugangsdaten,
 * Tokens und Einwilligungs-Schalter (Einwilligungen übernehmen wir nie, ihr Nachweis bleibt im Altsystem).
 */
export const PODODESK_COLUMNS: Record<PododeskFile, readonly string[]> = {
  aerzte: ["id", "vorname", "nachname", "titel", "ort"],
  leistungenPrivat: ["id", "kuerzel", "beschreibung", "regelbehandlungszeitmin", "regelbehandlungszeitmax", "mehrwertsteuer", "verguetung", "deleted"],
  patienten: [
    "id", "patientseit", "vorname", "nachname", "geschlecht", "titel", "geburtsdatum", "strasse", "hausnummer", "postleitzahl", "ort", "telefon", "mobil", "email", "krankenkasse", "hausarzt", "facharzt",
    "frequenz", "empfehlung", "bisherigepodologie", "verstorben", "notizen", "land", "verstorbenam", "beruf", "internationalmobil", "versichertennummer", "patientennummer", "internationaltelefon", "iknummerkk",
    "versichertenstatus",
  ],
  praxisstammdaten: ["terminraster", "standardbehandlungsdauer", "currency"],
  termine: ["id", "beginn", "ende", "patient", "hausbesuch", "leistungen", "notizen", "therapeut", "absagegrund", "absagedatum", "istorganisatorisch", "isallday", "products"],
  users: ["id", "vorname", "nachname", "farbe", "istherapeut", "disabled"],
};

/** Ausdrücklich verworfene sensible Spalten (Dokumentation + Test; verworfen wird ohnehin alles außerhalb PODODESK_COLUMNS) */
export const PODODESK_SENSITIVE = {
  praxisstammdaten: ["iban", "bic", "bank", "paypalemail", "sevdeskapikey", "sevdeskuser"],
  users: ["authuserid", "icalendartoken", "pindefined", "email"],
  patienten: ["emailerinnerung", "emailnewsletter", "smsreminder", "callreminder", "bild", "sevdeskid", "debitoorid"],
} as const;

const lower = (h: readonly string[]) => h.map((x) => x.toLowerCase());
const SIGNATURES = Object.fromEntries(Object.entries(PODODESK_HEADERS).map(([k, v]) => [k, [...lower(v)].sort().join("|")])) as Record<PododeskFile, string>;

/** Datei des Gesamtexports über den exakten Spaltensatz (Reihenfolge egal, Groß-/Kleinschreibung egal) */
export function pododeskFileOf(headers: string[]): PododeskFile | null {
  const sig = [...headers].sort().join("|");
  return (Object.keys(SIGNATURES) as PododeskFile[]).find((k) => SIGNATURES[k] === sig) ?? null;
}

/** Nur erlaubte Spalten behalten – alle anderen Werte werden entfernt, bevor ein Parser sie sieht. */
export function restrictColumns(t: Table, file: PododeskFile): Table {
  const allowed = new Set(PODODESK_COLUMNS[file]);
  return {
    headers: t.headers.filter((h) => allowed.has(h)),
    records: t.records.map((r) => {
      const values: Record<string, string> = {};
      for (const k of allowed) if (r.values[k] !== undefined) values[k] = r.values[k];
      return { row: r.row, values };
    }),
  };
}

// ───────────── Hilfen ─────────────
const nz = (v: string | undefined | null): string | null => {
  const t = (v ?? "").trim();
  return t === "" || t.toLowerCase() === "null" ? null : t;
};
const bool = (v: string | null | undefined) => /^(true|1|ja|yes|x)$/i.test((v ?? "").trim());

const berlinDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * Zeitpunkt aus dem Export → ISO (UTC). Pododesk exportiert UTC mit „Z“; Werte ohne Zone (z. B. nach dem Speichern in
 * Excel: „2026-11-13 07:00“ oder „13.11.2026 07:00“) gelten ebenfalls als UTC, weil der Export UTC enthält.
 */
export function parseUtc(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  let iso: string | null = null;
  let m: RegExpMatchArray | null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) iso = s;
  else if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?$/))) iso = `${m[1]}-${m[2]}-${m[3]}T${m[4].padStart(2, "0")}:${m[5]}:${m[6] ?? "00"}Z`;
  else if ((m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/))) iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T${m[4].padStart(2, "0")}:${m[5]}:${m[6] ?? "00"}Z`;
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 1900 || y > 2200) return null;
  return d.toISOString();
}

/** Datum (JJJJ-MM-TT, TT.MM.JJJJ) oder Zeitstempel (→ Kalendertag in Berlin) */
export function parsePododeskDate(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(s)) return parseDateLoose(s);
  const ts = parseUtc(s);
  return ts ? berlinDate.format(new Date(ts)) : null;
}

function salutationOf(v: string | null): PododeskPatient["salutation"] {
  const s = normName(v);
  if (/^(w|f|weiblich|female|frau)$/.test(s)) return "Frau";
  if (/^(m|maennlich|mannlich|male|herr)$/.test(s)) return "Herr";
  if (/^(d|x|divers|diverse)$/.test(s)) return "Divers";
  return null;
}
const genderOf = (s: PododeskPatient["salutation"]): PododeskPatient["gender"] => (s === "Frau" ? "female" : s === "Herr" ? "male" : s === "Divers" ? "diverse" : null);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ───────────── Patient:innen ─────────────
export function parsePododeskPatients(t: Table, file?: string): { patients: PododeskPatient[]; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  const patients: PododeskPatient[] = [];
  for (const r of t.records) {
    const v = (k: string) => nz(r.values[k]);
    if (Object.values(r.values).every((x) => !x)) continue;
    const id = v("id");
    if (!id || !validSourceId(id)) {
      issues.push({ file, row: r.row, message: id ? "Patienten-ID ungültig (zu lang oder unzulässige Zeichen) – Zeile übersprungen." : "Patienten-ID fehlt – Zeile übersprungen." });
      continue;
    }
    const lastName = v("nachname");
    if (!lastName) {
      issues.push({ file, row: r.row, message: "Nachname fehlt (Pflichtfeld) – Zeile übersprungen." });
      continue;
    }
    const birthRaw = v("geburtsdatum");
    const birthDate = parsePododeskDate(birthRaw);
    if (birthRaw && !birthDate) issues.push({ file, row: r.row, message: "Geburtsdatum nicht lesbar – leer übernommen." });
    const emailRaw = v("email")?.toLowerCase() ?? null;
    const email = emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw : null;
    if (emailRaw && !email) issues.push({ file, row: r.row, message: "E-Mail-Adresse ungültig – nicht übernommen." });
    let phoneLandline = v("telefon") ?? v("internationaltelefon");
    let phoneMobile = v("mobil") ?? v("internationalmobil");
    // Mobilnummer im Festnetzfeld (und kein Mobil angegeben) → als Mobilnummer
    if (!phoneMobile && phoneLandline && isMobileNumber(phoneLandline)) {
      phoneMobile = phoneLandline;
      phoneLandline = null;
    }
    const salutation = salutationOf(v("geschlecht"));
    const deathRaw = v("verstorbenam");
    const kasse = v("krankenkasse");
    const ik = v("iknummerkk");
    const insuranceNumber = v("versichertennummer");
    const status = v("versichertenstatus");
    // „krankenkasse“ kann ein Verweis (nur Ziffern) statt eines Namens sein – dann nicht als Name übernehmen
    const kasseIsRef = !!kasse && /^\d+$/.test(kasse);
    const privat = /priv|pkv|beihilfe/i.test(`${kasse ?? ""} ${status ?? ""}`);
    patients.push({
      row: r.row,
      id,
      number: v("patientennummer"),
      salutation,
      gender: genderOf(salutation),
      title: v("titel"),
      firstName: v("vorname"),
      lastName,
      birthDate,
      street: [v("strasse"), v("hausnummer")].filter(Boolean).join(" ") || null,
      zip: v("postleitzahl"),
      city: v("ort"),
      country: v("land"),
      phoneLandline,
      phoneMobile,
      email,
      insurerName: kasseIsRef ? null : kasse,
      insurerRef: kasseIsRef ? kasse : null,
      insurerIk: ik && /^\d{9}$/.test(ik) ? ik : kasseIsRef && /^\d{9}$/.test(kasse!) ? kasse : null,
      insuranceNumber,
      insuranceStatus: status,
      insuranceType: privat ? "pkv" : ik || insuranceNumber || kasse ? "gkv" : "self",
      gpId: v("hausarzt"),
      specialistId: v("facharzt"),
      notes: v("notizen"),
      deceased: bool(v("verstorben")) || !!deathRaw,
      deceasedOn: parsePododeskDate(deathRaw),
      patientSince: parsePododeskDate(v("patientseit")),
      occupation: v("beruf"),
      referrer: v("empfehlung"),
      previousPractice: v("bisherigepodologie"),
      frequency: v("frequenz"),
    });
  }
  return { patients, issues };
}

// ───────────── Ärzt:innen ─────────────
export function parsePododeskDoctors(t: Table): PododeskDoctor[] {
  const out: PododeskDoctor[] = [];
  for (const r of t.records) {
    const id = nz(r.values.id);
    const name = [nz(r.values.titel), nz(r.values.vorname), nz(r.values.nachname)].filter(Boolean).join(" ");
    if (!id || !name) continue;
    out.push({ id, name, city: nz(r.values.ort) });
  }
  return out;
}

// ───────────── Leistungen (privat) ─────────────
export function parsePododeskServices(t: Table, file?: string): { services: PododeskService[]; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  const services: PododeskService[] = [];
  for (const r of t.records) {
    const v = (k: string) => nz(r.values[k]);
    if (Object.values(r.values).every((x) => !x)) continue;
    const id = v("id");
    const code = v("kuerzel");
    if (!id || !code) {
      issues.push({ file, row: r.row, message: "Leistung ohne ID oder Kürzel – übersprungen." });
      continue;
    }
    const cents = v("verguetung");
    const priceCents = cents && /^-?\d+$/.test(cents) ? Number(cents) : null;
    if (cents && (priceCents === null || priceCents < 0)) issues.push({ file, row: r.row, message: `Leistung ${code}: Vergütung nicht lesbar – Preis 0 übernommen, bitte prüfen.` });
    const vatRaw = v("mehrwertsteuer");
    const vatNum = vatRaw ? Number(vatRaw.replace(",", ".")) : 0;
    let vatRate = Number.isFinite(vatNum) && vatNum >= 0 && vatNum <= 100 ? Math.round(vatNum) : null;
    if (vatRate !== null && vatRate !== vatNum) issues.push({ file, row: r.row, message: `Leistung ${code}: MwSt ${vatRaw} % auf ${vatRate} % gerundet.` });
    if (vatRate === null) {
      issues.push({ file, row: r.row, message: `Leistung ${code}: MwSt nicht lesbar – 19 % angenommen, bitte prüfen.` });
      vatRate = 19;
    }
    const dur = [v("regelbehandlungszeitmax"), v("regelbehandlungszeitmin")].map((x) => (x && /^\d+$/.test(x) ? Number(x) : null)).find((x) => x !== null && x > 0) ?? null;
    services.push({
      row: r.row,
      id,
      code,
      name: v("beschreibung") ?? code,
      priceCents: priceCents !== null && priceCents >= 0 ? priceCents : 0,
      vatRate,
      durationMin: dur !== null ? Math.min(Math.max(dur, 5), 480) : null,
      deleted: bool(v("deleted")),
    });
  }
  return { services, issues };
}

// ───────────── Termine ─────────────
/** termine.leistungen: `[{"istKKLeistung":false,"id":3}]` → Liste; ungültig → null */
export function parseServiceRefs(v: string | null): { id: string; kk: boolean }[] | null {
  if (!v) return [];
  if (v.length > 10_000) return null;
  try {
    const raw: unknown = JSON.parse(v);
    if (!Array.isArray(raw)) return null;
    const out: { id: string; kk: boolean }[] = [];
    for (const x of raw.slice(0, 50)) {
      if (!x || typeof x !== "object") continue;
      const o = x as Record<string, unknown>;
      const id = typeof o.id === "number" || typeof o.id === "string" ? String(o.id) : null;
      if (!id || !validSourceId(id)) continue;
      out.push({ id, kk: o.istKKLeistung === true || o.istKKLeistung === "true" });
    }
    return out;
  } catch {
    return null;
  }
}

const jsonCount = (v: string | null) => {
  if (!v) return 0;
  try {
    const a: unknown = JSON.parse(v);
    return Array.isArray(a) ? a.length : 0;
  } catch {
    return 0;
  }
};

export function parsePododeskAppointments(t: Table, file?: string): { appointments: PododeskAppointment[]; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  const appointments: PododeskAppointment[] = [];
  for (const r of t.records) {
    const v = (k: string) => nz(r.values[k]);
    if (Object.values(r.values).every((x) => !x)) continue;
    const id = v("id");
    const patientId = v("patient");
    const therapistId = v("therapeut");
    if (!id || !validSourceId(id) || (patientId !== null && !validSourceId(patientId)) || (therapistId !== null && !validSourceId(therapistId))) {
      issues.push({ file, row: r.row, message: id ? "Termin-, Patienten- oder Behandler-ID ungültig – Zeile übersprungen." : "Termin-ID fehlt – Zeile übersprungen." });
      continue;
    }
    const organizational = bool(v("istorganisatorisch"));
    const startsAt = parseUtc(v("beginn"));
    let endsAt = parseUtc(v("ende"));
    if (!startsAt) {
      issues.push({ file, row: r.row, message: "Beginn nicht lesbar – Termin übersprungen." });
      continue;
    }
    if (!endsAt || new Date(endsAt) <= new Date(startsAt)) {
      endsAt = new Date(new Date(startsAt).getTime() + 30 * 60_000).toISOString();
      if (!organizational) issues.push({ file, row: r.row, message: "Ende fehlt oder liegt vor dem Beginn – 30 Minuten angenommen." });
    }
    const services = parseServiceRefs(v("leistungen"));
    if (services === null) issues.push({ file, row: r.row, message: "Leistungen des Termins nicht lesbar – ohne Leistungen übernommen." });
    const cancelledOn = parsePododeskDate(v("absagedatum"));
    const cancelReason = v("absagegrund");
    appointments.push({
      row: r.row,
      id,
      startsAt,
      endsAt,
      patientId,
      therapistId,
      homeVisit: bool(v("hausbesuch")),
      services: services ?? [],
      notes: v("notizen"),
      cancelled: !!cancelledOn || !!cancelReason || !!v("absagedatum"),
      cancelledOn,
      cancelReason,
      organizational,
      products: jsonCount(v("products")),
    });
  }
  return { appointments, issues };
}

// ───────────── Mitarbeitende ─────────────
export function parsePododeskUsers(t: Table): PododeskUser[] {
  const out: PododeskUser[] = [];
  for (const r of t.records) {
    const id = nz(r.values.id);
    const name = [nz(r.values.vorname), nz(r.values.nachname)].filter(Boolean).join(" ");
    if (!id || !name) continue;
    const farbe = nz(r.values.farbe);
    out.push({ id, name, color: farbe && /^#?[0-9a-f]{6}$/i.test(farbe) ? (farbe.startsWith("#") ? farbe : `#${farbe}`).toLowerCase() : null, disabled: bool(r.values.disabled) });
  }
  return out;
}

// ───────────── Praxisstammdaten (nur Vorschläge) ─────────────
export function parsePododeskPractice(t: Table): PododeskPractice {
  const r = t.records[0]?.values ?? {};
  const int = (k: string) => {
    const x = nz(r[k]);
    return x && /^\d{1,4}$/.test(x) ? Number(x) : null;
  };
  return { slotMin: int("terminraster"), defaultDurationMin: int("standardbehandlungsdauer"), currency: nz(r.currency) };
}

/**
 * Hex-Farbe aus Pododesk → nächste Farbe der PodoHero-Palette (memberships.color speichert nur Paletten-Schlüssel).
 * Graue/sehr blasse Töne → „stone“, sonst nach Farbton.
 */
export function paletteColor(hex: string | null): TherapistColor | null {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (sat < 0.15 || l < 0.08 || l > 0.97) return "stone";
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const anchors: [TherapistColor, number][] = [["rose", 350], ["orange", 25], ["amber", 45], ["green", 120], ["teal", 170], ["cyan", 190], ["blue", 220], ["violet", 265], ["fuchsia", 305]];
  let best: TherapistColor = "stone";
  let bestDist = 999;
  for (const [c, a] of anchors) {
    const dist = Math.min(Math.abs(h - a), 360 - Math.abs(h - a));
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return (THERAPIST_COLORS as readonly string[]).includes(best) ? best : null;
}
