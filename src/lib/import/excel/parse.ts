/**
 * Import der Alt-Arbeitsmappe „Podologie Rechnungsmanager V0.9.2“ (Excel).
 * Reine Funktion: Buffer → normalisierte Entwürfe + Prüfbericht. Kein DB-Zugriff.
 *
 * Annahmen (im Bericht sichtbar, mit der Praxis zu verifizieren):
 *  - Kopfzeile in Zeile 1 (bzw. die erste der ersten 10 Zeilen, die die Pflichtspalte enthält).
 *  - Formeln: gespeichertes Ergebnis wird verwendet; =ROW()-n wird nachgerechnet.
 *  - Beträge sind Bruttobeträge in Euro.
 *  - Sammelrechnungen (Typ „SR“): Zeilen mit gesetzter SR-ID, die auf eine SR-Zeile (deren ID oder
 *    Rechnungsnummer) verweisen, werden als Positionen in diese Sammelrechnung übernommen und NICHT
 *    als eigene Rechnungen importiert (sonst doppelter Umsatz).
 */
import ExcelJS from "exceljs";
import {
  asString,
  normalizeHeader,
  readCell,
  toCents,
  toIsoDate,
  toMinutes,
  toNumber,
  toVatRate,
  type Primitive,
} from "./cells";
import type {
  Channel,
  DuplicateGroup,
  FixedCostImportDraft,
  ImportReport,
  ImportResult,
  ImportWarning,
  InvoiceImportDraft,
  InvoiceKind,
  InvoiceLineDraft,
  PatientImportDraft,
  PaymentDraft,
  PaymentMethod,
  ServiceImportDraft,
  SheetName,
  VoucherImportDraft,
} from "./types";
import { SHEET_NAMES } from "./types";
import { berlinDateIso } from "@/lib/format";

export interface ParseOptions {
  /** Referenzdatum für Ersatzwerte (z. B. fehlendes Startdatum), YYYY-MM-DD. Standard: heute. */
  today?: string;
}

/** Spaltenname → mögliche Kopfzeilen-Texte (normalisiert, inkl. Tippfehlern der Vorlage). */
type ColumnMap<K extends string> = Record<K, string[]>;

const PATIENT_COLS = {
  id: ["id"],
  salutation: ["anrede"],
  title: ["titel"],
  lastName: ["nachname", "name"],
  firstName: ["vorname"],
  street: ["straße", "strasse", "str."],
  zip: ["plz"],
  city: ["ort", "stadt"],
  route: ["route", "tour"],
  birthDate: ["geburtsdatum", "geb.", "geburtstag"],
  mobile: ["mobil", "handy", "mobilnummer"],
  landline: ["festznetz", "festnetz", "telefon"],
  email: ["e-mail", "email", "mail"],
  channel: ["bev. kanal", "bevorzugter kanal", "kanal"],
  note: ["hinweis", "notiz", "bemerkung"],
  open: ["offener betrag", "offen"],
  revenue: ["umsatz"],
  treatments: ["behandlungen"],
  lastTreatment: ["letzte behandung", "letzte behandlung"],
  status: ["status"],
} satisfies ColumnMap<string>;

const SERVICE_COLS = {
  id: ["id"],
  code: ["code", "kürzel"],
  name: ["bezeichnung", "leistung", "name"],
  price: ["preis", "betrag"],
  vat: ["steuer", "mwst", "ust", "steuersatz"],
  duration: ["dauer", "dauer (min)", "minuten"],
} satisfies ColumnMap<string>;

const VOUCHER_COLS = {
  id: ["id"],
  code: ["gutscheinnummer", "nummer", "gutschein"],
  date: ["datum", "ausgestellt"],
  validUntil: ["gültig bis", "gueltig bis"],
  amount: ["betrag", "wert"],
  remaining: ["restbetrag", "rest"],
  note: ["hinweis", "notiz"],
} satisfies ColumnMap<string>;

const INVOICE_COLS = {
  id: ["id"],
  number: ["rechnungsnummer", "nummer", "re-nr."],
  date: ["datum", "rechnungsdatum"],
  type: ["typ", "art"],
  srId: ["sr-id", "sr id"],
  patientId: ["patienten-id", "patienten id", "patient-id"],
  lastName: ["nachname"],
  firstName: ["vorname"],
  payment: ["bezahlung", "zahlart", "zahlung"],
  gsId: ["gs-id", "gs id", "gutschein-id"],
  aCash: ["a-b"],
  aCard: ["a-ec"],
  aTransfer: ["a-ü", "a-ue", "a-u"],
  aVoucher: ["a-gs"],
  total: ["summe"],
  totalSr: ["summe sr"],
  statusReceipt: ["status quittung"],
  statusSr: ["status sr"],
} satisfies ColumnMap<string>;

const FIXED_COLS = {
  category: ["fixkosten kategorie", "kategorie", "fixkosten"],
  amount: ["betrag"],
  interval: ["intervall"],
  share: ["anteil mtl.", "anteil monatlich", "anteil mtl"],
  start: ["startdatum", "start", "ab"],
} satisfies ColumnMap<string>;

type Cols<M> = { [K in keyof M]: number | undefined };

function findSheet(wb: ExcelJS.Workbook, name: SheetName): ExcelJS.Worksheet | undefined {
  return wb.worksheets.find((ws) => normalizeHeader(ws.name) === normalizeHeader(name));
}

/** Sucht die Kopfzeile (erste der ersten 10 Zeilen, die eine der Pflicht-Überschriften enthält). */
function locateColumns<M extends ColumnMap<string>>(ws: ExcelJS.Worksheet, map: M, required: keyof M): { headerRow: number; cols: Cols<M> } | null {
  for (let r = 1; r <= Math.min(10, ws.rowCount || 1); r++) {
    const row = ws.getRow(r);
    const headers = new Map<string, number>();
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const t = asString(readCell(cell, r).value);
      if (t && !headers.has(normalizeHeader(t))) headers.set(normalizeHeader(t), col);
    });
    const cols = {} as Cols<M>;
    for (const key of Object.keys(map) as (keyof M)[]) {
      cols[key] = map[key].map((alias) => headers.get(alias)).find((c) => c !== undefined);
    }
    if (cols[required] !== undefined) return { headerRow: r, cols };
  }
  return null;
}

class Ctx {
  warnings: ImportWarning[] = [];
  warn(sheet: ImportWarning["sheet"], row: number | null, message: string) {
    this.warnings.push({ sheet, row, message });
  }
}

const DERIVED_COLUMNS = new Set(["id", "open", "revenue", "treatments", "lastTreatment", "status", "route", "monthlyShare", "nextDue", "daysUntil", "sum", "sumSr", "remaining", "statusReceipt", "statusSr", "lastName", "firstName"]);

/** Liest eine Zeile als Objekt der gemappten Spalten; meldet Formeln ohne Ergebnis und Fehlerwerte. */
function readRow<M extends ColumnMap<string>>(ctx: Ctx, sheet: SheetName, row: ExcelJS.Row, cols: Cols<M>): { values: { [K in keyof M]: Primitive }; empty: boolean } {
  const values = {} as { [K in keyof M]: Primitive };
  let empty = true;
  const pending: string[] = [];
  for (const key of Object.keys(cols) as (keyof M)[]) {
    const c = cols[key];
    if (c === undefined) {
      values[key] = null;
      continue;
    }
    const rc = readCell(row.getCell(c), row.number);
    // Berechnete Excel-Spalten (Umsatz, offen, Status …) werden im CRM neu berechnet → keine Warnung
    if (rc.formulaWithoutResult && !DERIVED_COLUMNS.has(String(key))) pending.push(`Spalte „${String(key)}“: Formel ohne gespeichertes Ergebnis – bitte Datei einmal in Excel öffnen und speichern.`);
    if (rc.error && !DERIVED_COLUMNS.has(String(key))) pending.push(`Spalte „${String(key)}“: Fehlerwert ${rc.error}.`);
    values[key] = typeof rc.value === "string" && rc.value.trim() === "" ? null : rc.value;
  }
  // „leer“ = keine Zelle mit Inhalt außer evtl. einer ID-Formel (=ROW()-1 steht oft in leeren Zeilen)
  for (const key of Object.keys(values) as (keyof M)[]) {
    if (key === "id") continue;
    if (values[key] !== null) empty = false;
  }
  // Warnungen nur für Zeilen mit echtem Inhalt (leere Vorlagenzeilen enthalten nur Formeln)
  if (!empty) for (const msg of pending) ctx.warn(sheet, row.number, msg);
  return { values, empty };
}

function* dataRows(ws: ExcelJS.Worksheet, headerRow: number): Generator<ExcelJS.Row> {
  for (let r = headerRow + 1; r <= ws.rowCount; r++) yield ws.getRow(r);
}

const toInt = (v: Primitive): number | null => {
  const n = toNumber(v);
  return n === null ? null : Math.round(n);
};

function phone(ctx: Ctx, sheet: SheetName, row: number, v: Primitive): string | null {
  if (v === null) return null;
  if (typeof v === "number") {
    const s = String(Math.round(v));
    if (s.startsWith("49")) return `+${s}`;
    ctx.warn(sheet, row, `Telefonnummer als Zahl gespeichert – führende 0 ergänzt (${s}).`);
    return `0${s}`;
  }
  return asString(v);
}

function zip(v: Primitive): string | null {
  if (typeof v === "number") return String(Math.round(v)).padStart(5, "0");
  return asString(v);
}

export function mapChannel(v: string | null): Channel | null {
  if (!v) return "none";
  const s = v.toLowerCase().replace(/[\s-]/g, "");
  if (/whatsapp|^wa$/.test(s)) return "whatsapp";
  if (/email|^mail$/.test(s)) return "email";
  if (/sms/.test(s)) return "sms";
  if (/telefon|anruf|phone|tel\.?$/.test(s)) return "phone";
  if (/brief|post/.test(s)) return "letter";
  if (/keine?|^-$/.test(s)) return "none";
  return null;
}

function mapSalutation(v: string | null): PatientImportDraft["salutation"] | undefined {
  if (!v) return null;
  const s = v.toLowerCase().replace(/\.$/, "");
  if (s === "herr" || s === "hr") return "Herr";
  if (s === "frau" || s === "fr") return "Frau";
  if (s === "divers" || s === "d") return "Divers";
  return undefined;
}

// ───────────────────────── Patienten ─────────────────────────
function parsePatients(ctx: Ctx, ws: ExcelJS.Worksheet | undefined, report: ImportReport): PatientImportDraft[] {
  const sheet = "Patienten" as const;
  if (!ws) {
    ctx.warn(sheet, null, "Blatt „Patienten“ nicht gefunden.");
    return [];
  }
  const loc = locateColumns(ws, PATIENT_COLS, "lastName");
  if (!loc) {
    ctx.warn(sheet, null, "Kopfzeile mit „Nachname“ nicht gefunden.");
    return [];
  }
  const out: PatientImportDraft[] = [];
  const count = report.counts[sheet];
  for (const row of dataRows(ws, loc.headerRow)) {
    const { values: v, empty } = readRow(ctx, sheet, row, loc.cols);
    count.rows++;
    if (empty) {
      count.skippedEmpty++;
      continue;
    }
    const lastName = asString(v.lastName);
    const firstName = asString(v.firstName);
    if (!lastName) {
      ctx.warn(sheet, row.number, "Nachname fehlt – Zeile übersprungen.");
      count.skippedInvalid++;
      continue;
    }
    const salRaw = asString(v.salutation);
    const salutation = mapSalutation(salRaw);
    if (salutation === undefined) ctx.warn(sheet, row.number, `Unbekannte Anrede „${salRaw}“.`);
    const chRaw = asString(v.channel);
    let channel = mapChannel(chRaw);
    if (channel === null) {
      ctx.warn(sheet, row.number, `Unbekannter Kanal „${chRaw}“ – auf „keiner“ gesetzt.`);
      channel = "none";
    }
    const birthDate = toIsoDate(v.birthDate);
    if (v.birthDate !== null && !birthDate) ctx.warn(sheet, row.number, `Geburtsdatum nicht lesbar („${asString(v.birthDate)}“).`);
    const email = asString(v.email)?.toLowerCase() ?? null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ctx.warn(sheet, row.number, `E-Mail-Adresse wirkt ungültig („${email}“).`);
    const legacyId = toInt(v.id);
    if (legacyId === null) ctx.warn(sheet, row.number, "ID fehlt – neue Patientennummer wird vergeben.");
    out.push({
      row: row.number,
      legacyId,
      salutation: salutation ?? null,
      title: asString(v.title),
      lastName,
      firstName,
      street: asString(v.street),
      zip: zip(v.zip),
      city: asString(v.city),
      route: asString(v.route),
      birthDate,
      phoneMobile: phone(ctx, sheet, row.number, v.mobile),
      phoneLandline: phone(ctx, sheet, row.number, v.landline),
      email,
      preferredChannel: channel,
      notes: asString(v.note),
      legacy: {
        openAmountCents: toCents(v.open),
        revenueCents: toCents(v.revenue),
        treatments: toInt(v.treatments),
        lastTreatment: toIsoDate(v.lastTreatment),
        status: asString(v.status),
      },
    });
    count.imported++;
  }
  // doppelte Legacy-IDs
  const seen = new Map<number, number>();
  for (const p of out) {
    if (p.legacyId === null) continue;
    const prev = seen.get(p.legacyId);
    if (prev !== undefined) ctx.warn(sheet, p.row, `ID ${p.legacyId} doppelt (auch Zeile ${prev}) – neue Nummer wird vergeben.`);
    else seen.set(p.legacyId, p.row);
  }
  return out;
}

export function findDuplicates(patients: PatientImportDraft[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const add = (reason: DuplicateGroup["reason"], keyFn: (p: PatientImportDraft) => string | null) => {
    const map = new Map<string, PatientImportDraft[]>();
    for (const p of patients) {
      const k = keyFn(p);
      if (!k) continue;
      map.set(k, [...(map.get(k) ?? []), p]);
    }
    for (const [value, list] of map) {
      if (list.length > 1) groups.push({ sheet: "Patienten", reason, value, rows: list.map((p) => p.row), legacyIds: list.map((p) => p.legacyId) });
    }
  };
  const norm = (s: string | null) => (s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").replace(/\s+/g, " ").trim();
  add("name_birthdate", (p) => (p.birthDate ? `${norm(p.lastName)}|${norm(p.firstName)}|${p.birthDate}` : null));
  add("email", (p) => p.email);
  const digits = (s: string | null) => {
    if (!s) return null;
    const d = s.replace(/\D/g, "").replace(/^(00)?49/, "0");
    return d.length >= 6 ? d : null;
  };
  // je Patient alle Nummern prüfen
  const phoneMap = new Map<string, PatientImportDraft[]>();
  for (const p of patients) {
    for (const n of new Set([digits(p.phoneMobile), digits(p.phoneLandline)])) {
      if (n) phoneMap.set(n, [...(phoneMap.get(n) ?? []), p]);
    }
  }
  for (const [value, list] of phoneMap) {
    if (list.length > 1) groups.push({ sheet: "Patienten", reason: "phone", value, rows: list.map((p) => p.row), legacyIds: list.map((p) => p.legacyId) });
  }
  return groups;
}

// ───────────────────────── Leistungen ─────────────────────────
function parseServices(ctx: Ctx, ws: ExcelJS.Worksheet | undefined, report: ImportReport): ServiceImportDraft[] {
  const sheet = "Leistungen" as const;
  if (!ws) {
    ctx.warn(sheet, null, "Blatt „Leistungen“ nicht gefunden.");
    return [];
  }
  const loc = locateColumns(ws, SERVICE_COLS, "code");
  if (!loc) {
    ctx.warn(sheet, null, "Kopfzeile mit „Code“ nicht gefunden.");
    return [];
  }
  const out: ServiceImportDraft[] = [];
  const codes = new Set<string>();
  const count = report.counts[sheet];
  for (const row of dataRows(ws, loc.headerRow)) {
    const { values: v, empty } = readRow(ctx, sheet, row, loc.cols);
    count.rows++;
    if (empty) {
      count.skippedEmpty++;
      continue;
    }
    const code = asString(v.code);
    const priceCents = toCents(v.price);
    if (!code || priceCents === null) {
      ctx.warn(sheet, row.number, "Code oder Preis fehlt – Zeile übersprungen.");
      count.skippedInvalid++;
      continue;
    }
    if (codes.has(code.toUpperCase())) {
      ctx.warn(sheet, row.number, `Code „${code}“ doppelt – Zeile übersprungen.`);
      count.skippedInvalid++;
      continue;
    }
    codes.add(code.toUpperCase());
    let vatRate = toVatRate(v.vat) ?? 0;
    if (![0, 7, 19].includes(vatRate)) {
      ctx.warn(sheet, row.number, `Ungewöhnlicher Steuersatz ${vatRate} % – bitte prüfen.`);
    }
    if (vatRate < 0) vatRate = 0;
    const durationMin = toMinutes(v.duration) ?? 30;
    if (v.duration === null) ctx.warn(sheet, row.number, "Dauer fehlt – 30 Minuten angenommen.");
    out.push({ row: row.number, legacyId: toInt(v.id), code, name: asString(v.name) ?? code, priceCents, vatRate, durationMin });
    count.imported++;
  }
  return out;
}

// ───────────────────────── Gutscheine ─────────────────────────
/** Regelverjährung § 195/199 BGB: 3 Jahre zum Jahresende */
function defaultVoucherValidity(issuedAt: string): string {
  return `${Number(issuedAt.slice(0, 4)) + 3}-12-31`;
}

function parseVouchers(ctx: Ctx, ws: ExcelJS.Worksheet | undefined, report: ImportReport, today: string): VoucherImportDraft[] {
  const sheet = "Gutscheine" as const;
  if (!ws) {
    ctx.warn(sheet, null, "Blatt „Gutscheine“ nicht gefunden.");
    return [];
  }
  const loc = locateColumns(ws, VOUCHER_COLS, "code");
  if (!loc) {
    ctx.warn(sheet, null, "Kopfzeile mit „Gutscheinnummer“ nicht gefunden.");
    return [];
  }
  const out: VoucherImportDraft[] = [];
  const count = report.counts[sheet];
  const codes = new Set<string>();
  for (const row of dataRows(ws, loc.headerRow)) {
    const { values: v, empty } = readRow(ctx, sheet, row, loc.cols);
    count.rows++;
    if (empty) {
      count.skippedEmpty++;
      continue;
    }
    const code = typeof v.code === "number" ? String(v.code) : asString(v.code);
    const amountCents = toCents(v.amount);
    if (!code || amountCents === null) {
      ctx.warn(sheet, row.number, "Gutscheinnummer oder Betrag fehlt – Zeile übersprungen.");
      count.skippedInvalid++;
      continue;
    }
    if (codes.has(code)) {
      ctx.warn(sheet, row.number, `Gutscheinnummer „${code}“ doppelt – Zeile übersprungen.`);
      count.skippedInvalid++;
      continue;
    }
    codes.add(code);
    let issuedAt = toIsoDate(v.date);
    if (!issuedAt) {
      ctx.warn(sheet, row.number, "Ausstellungsdatum fehlt – Importdatum verwendet.");
      issuedAt = today;
    }
    let validUntil = toIsoDate(v.validUntil);
    if (!validUntil) {
      validUntil = defaultVoucherValidity(issuedAt);
      ctx.warn(sheet, row.number, `„Gültig bis“ fehlt – gesetzliche Frist bis ${validUntil} angenommen.`);
    }
    const remainingCents = toCents(v.remaining);
    if (remainingCents !== null && (remainingCents < 0 || remainingCents > amountCents)) {
      ctx.warn(sheet, row.number, "Restbetrag liegt außerhalb von 0 … Betrag.");
    }
    out.push({ row: row.number, legacyId: toInt(v.id), code, issuedAt, validUntil, amountCents, remainingCents, note: asString(v.note) });
    count.imported++;
  }
  return out;
}

// ───────────────────────── Rechnungen ─────────────────────────
function mapKind(t: string | null): InvoiceKind | null {
  const s = (t ?? "").trim().toUpperCase();
  if (s === "R" || s === "RECHNUNG") return "invoice";
  if (s === "Q" || s === "QUITTUNG") return "receipt";
  if (s === "SR" || s === "SAMMELRECHNUNG") return "collective";
  return null;
}

function singleMethod(s: string): PaymentMethod | null {
  if (/gutschein/.test(s)) return "voucher";
  if (/überweisung|ueberweisung|uberweisung|transfer/.test(s)) return "transfer";
  if (/\bec\b|karte|sumup|kreditkarte|girocard/.test(s)) return "card";
  if (/\bbar\b|^bar/.test(s)) return "cash";
  return null;
}

interface PaymentParse {
  payments: PaymentDraft[];
  warnings: string[];
}

export function parsePayment(
  raw: string | null,
  totalCents: number,
  split: { cash: number | null; card: number | null; transfer: number | null; voucher: number | null },
  voucherLegacyId: number | null,
): PaymentParse {
  const s = (raw ?? "").toLowerCase().trim();
  const warnings: string[] = [];
  const splitPayments = (): PaymentDraft[] => {
    const list: PaymentDraft[] = [];
    if (split.cash) list.push({ method: "cash", amountCents: split.cash });
    if (split.card) list.push({ method: "card", amountCents: split.card });
    if (split.transfer) list.push({ method: "transfer", amountCents: split.transfer });
    if (split.voucher) list.push({ method: "voucher", amountCents: split.voucher, voucherLegacyId });
    return list.filter((p) => p.amountCents > 0);
  };
  const hasSplit = [split.cash, split.card, split.transfer, split.voucher].some((x) => !!x && x > 0);

  if (/gemischt|misch/.test(s) || (!s && hasSplit)) {
    const list = splitPayments();
    if (list.length === 0) warnings.push("Gemischte Zahlung ohne Teilbeträge (A-B/A-EC/A-Ü/A-GS).");
    return { payments: list, warnings };
  }
  if (!s) {
    warnings.push("Bezahlung leer – als offen importiert.");
    return { payments: [], warnings };
  }
  if (/offen|unbezahlt|ausstehend/.test(s)) return { payments: [], warnings };
  const method = singleMethod(s);
  if (!method) {
    warnings.push(`Unbekannte Bezahlart „${raw}“ – als offen importiert.`);
    return { payments: [], warnings };
  }
  if (method === "voucher") {
    const amt = split.voucher && split.voucher > 0 ? split.voucher : totalCents;
    if (voucherLegacyId === null) warnings.push("Zahlung per Gutschein ohne GS-ID.");
    const list: PaymentDraft[] = [{ method, amountCents: Math.min(amt, totalCents), voucherLegacyId }];
    // Rest ggf. über weitere Teilbeträge
    const rest = splitPayments().filter((p) => p.method !== "voucher");
    return { payments: [...list, ...rest], warnings };
  }
  if (!/bezahlt|erhalten|ok/.test(s)) warnings.push(`Zahlstatus in „${raw}“ unklar – als bezahlt angenommen.`);
  return { payments: [{ method, amountCents: totalCents }], warnings };
}

function computeVat(totalCents: number, rate: number): number {
  return rate > 0 ? Math.round((totalCents * rate) / (100 + rate)) : 0;
}

function parseInvoices(ctx: Ctx, ws: ExcelJS.Worksheet | undefined, report: ImportReport, services: ServiceImportDraft[]): InvoiceImportDraft[] {
  const sheet = "Rechnungen" as const;
  if (!ws) {
    ctx.warn(sheet, null, "Blatt „Rechnungen“ nicht gefunden.");
    return [];
  }
  const loc = locateColumns(ws, INVOICE_COLS, "number");
  if (!loc) {
    ctx.warn(sheet, null, "Kopfzeile mit „Rechnungsnummer“ nicht gefunden.");
    return [];
  }
  // Positionsspalten L1/A1/F1 … L10/A10/F10 suchen
  const header = new Map<string, number>();
  ws.getRow(loc.headerRow).eachCell((cell, col) => {
    const t = asString(readCell(cell, loc.headerRow).value);
    if (t) header.set(normalizeHeader(t), col);
  });
  const lineCols: { n: number; l: number; a?: number; f?: number }[] = [];
  for (let n = 1; n <= 10; n++) {
    const l = header.get(`l${n}`);
    if (l !== undefined) lineCols.push({ n, l, a: header.get(`a${n}`), f: header.get(`f${n}`) });
  }
  if (lineCols.length === 0) ctx.warn(sheet, null, "Keine Positionsspalten (L1/A1/F1 …) gefunden.");

  const serviceByCode = new Map(services.map((s) => [s.code.toUpperCase(), s]));
  const count = report.counts[sheet];
  type Raw = { draft: InvoiceImportDraft; srRef: string | null };
  const raws: Raw[] = [];
  const numbers = new Set<string>();

  for (const row of dataRows(ws, loc.headerRow)) {
    const { values: v, empty } = readRow(ctx, sheet, row, loc.cols);
    const lineCells = lineCols.map((c) => ({
      n: c.n,
      code: asString(readCell(row.getCell(c.l), row.number).value),
      qty: c.a !== undefined ? toNumber(readCell(row.getCell(c.a), row.number).value) : null,
      factor: c.f !== undefined ? toNumber(readCell(row.getCell(c.f), row.number).value) : null,
    }));
    count.rows++;
    if (empty && lineCells.every((l) => !l.code)) {
      count.skippedEmpty++;
      continue;
    }
    const number = typeof v.number === "number" ? String(v.number) : asString(v.number);
    if (!number) {
      ctx.warn(sheet, row.number, "Rechnungsnummer fehlt – Zeile übersprungen.");
      count.skippedInvalid++;
      continue;
    }
    if (numbers.has(number)) {
      ctx.warn(sheet, row.number, `Rechnungsnummer „${number}“ doppelt – Zeile übersprungen.`);
      count.skippedInvalid++;
      continue;
    }
    numbers.add(number);
    const typeRaw = asString(v.type);
    let kind = mapKind(typeRaw);
    if (!kind) {
      ctx.warn(sheet, row.number, `Unbekannter Typ „${typeRaw ?? ""}“ – als Rechnung importiert.`);
      kind = "invoice";
    }
    const issuedAt = toIsoDate(v.date);
    if (!issuedAt) ctx.warn(sheet, row.number, "Rechnungsdatum fehlt oder ist nicht lesbar.");

    const lines: InvoiceLineDraft[] = [];
    for (const lc of lineCells) {
      if (!lc.code) continue;
      const svc = serviceByCode.get(lc.code.toUpperCase());
      if (!svc) ctx.warn(sheet, row.number, `Leistung „${lc.code}“ (L${lc.n}) nicht im Blatt „Leistungen“ – Preis 0 €.`);
      const quantity = lc.qty ?? 1;
      const factor = lc.factor ?? 1;
      const unit = svc?.priceCents ?? 0;
      lines.push({
        position: lines.length + 1,
        serviceCode: lc.code,
        description: svc?.name ?? lc.code,
        quantity,
        factor,
        unitPriceCents: unit,
        vatRate: svc?.vatRate ?? 0,
        totalCents: Math.round(unit * quantity * factor),
      });
    }
    const linesTotal = lines.reduce((a, l) => a + l.totalCents, 0);
    const sum = toCents(v.total);
    const sumSr = toCents(v.totalSr);
    let totalCents = kind === "collective" ? sumSr ?? sum ?? linesTotal : sum ?? linesTotal;
    if (sum === null && lines.length > 0) ctx.warn(sheet, row.number, "Summe fehlt – aus Positionen berechnet.");
    if (sum !== null && lines.length > 0 && Math.abs(sum - linesTotal) > 1 && kind !== "collective") {
      ctx.warn(sheet, row.number, `Summe ${(sum / 100).toFixed(2)} € weicht von Positionen ${(linesTotal / 100).toFixed(2)} € ab – Summe aus Excel übernommen.`);
    }
    if (totalCents < 0) totalCents = 0;

    const gsId = toInt(v.gsId);
    const pay = parsePayment(asString(v.payment), totalCents, { cash: toCents(v.aCash), card: toCents(v.aCard), transfer: toCents(v.aTransfer), voucher: toCents(v.aVoucher) }, gsId);
    pay.warnings.forEach((w) => ctx.warn(sheet, row.number, w));
    const srRefRaw = v.srId;
    const srRef = srRefRaw === null ? null : typeof srRefRaw === "number" ? String(Math.round(srRefRaw)) : asString(srRefRaw);

    raws.push({
      srRef: kind === "collective" ? null : srRef,
      draft: {
        row: row.number,
        legacyId: toInt(v.id),
        number,
        issuedAt,
        kind,
        typeRaw,
        patientLegacyId: toInt(v.patientId),
        lastName: asString(v.lastName),
        firstName: asString(v.firstName),
        paymentRaw: asString(v.payment),
        status: "issued",
        voucherLegacyId: gsId,
        payments: pay.payments,
        totalCents,
        netCents: 0,
        vatCents: 0,
        lines,
        statusReceipt: asString(v.statusReceipt),
        statusCollective: asString(v.statusSr),
        collectedLegacyIds: [],
        collectedNumbers: [],
      },
    });
  }

  // Sammelrechnungen zusammenführen
  const collectives = raws.filter((r) => r.draft.kind === "collective");
  const findSr = (ref: string) =>
    collectives.find((c) => (c.draft.legacyId !== null && String(c.draft.legacyId) === ref) || c.draft.number === ref);
  const result: InvoiceImportDraft[] = [];
  for (const r of raws) {
    if (r.srRef) {
      const sr = findSr(r.srRef);
      if (sr) {
        if (r.draft.legacyId !== null) sr.draft.collectedLegacyIds.push(r.draft.legacyId);
        sr.draft.collectedNumbers.push(r.draft.number);
        for (const l of r.draft.lines) sr.draft.lines.push({ ...l, position: sr.draft.lines.length + 1, description: `${l.description} (${r.draft.issuedAt ?? r.draft.number})` });
        if (sr.draft.patientLegacyId === null) sr.draft.patientLegacyId = r.draft.patientLegacyId;
        report.collectiveParts++;
        continue;
      }
      ctx.warn(sheet, r.draft.row, `SR-ID „${r.srRef}“ verweist auf keine Sammelrechnung – als Einzelrechnung importiert.`);
    }
    result.push(r.draft);
  }

  for (const d of result) {
    if (d.kind === "collective") {
      const linesTotal = d.lines.reduce((a, l) => a + l.totalCents, 0);
      if (d.totalCents === 0 && linesTotal > 0) d.totalCents = linesTotal;
      else if (d.lines.length > 0 && Math.abs(d.totalCents - linesTotal) > 1) {
        ctx.warn(sheet, d.row, `Sammelrechnung: Summe ${(d.totalCents / 100).toFixed(2)} € ≠ Positionen ${(linesTotal / 100).toFixed(2)} €.`);
      }
      // Zahlungsbeträge auf die Gesamtsumme beziehen (bei Einzelzahlart)
      if (d.payments.length === 1 && d.payments[0].method !== "voucher") d.payments[0].amountCents = d.totalCents;
    }
    // Steuer: aus Positionen, anteilig auf die Summe skaliert
    const linesTotal = d.lines.reduce((a, l) => a + l.totalCents, 0);
    const vatLines = d.lines.reduce((a, l) => a + computeVat(l.totalCents, l.vatRate), 0);
    d.vatCents = linesTotal > 0 ? Math.round((vatLines * d.totalCents) / linesTotal) : 0;
    d.netCents = d.totalCents - d.vatCents;
    const paid = d.payments.reduce((a, p) => a + p.amountCents, 0);
    if (paid > d.totalCents + 1) ctx.warn(sheet, d.row, `Zahlungen ${(paid / 100).toFixed(2)} € übersteigen Summe ${(d.totalCents / 100).toFixed(2)} €.`);
    d.status = paid >= d.totalCents && d.totalCents >= 0 && (paid > 0 || d.totalCents === 0) ? "paid" : paid > 0 ? "partially_paid" : "issued";
    count.imported++;
  }
  return result;
}

// ───────────────────────── Kalkulation (Fixkosten) ─────────────────────────
function mapInterval(v: string | null): FixedCostImportDraft["interval"] | null {
  const s = (v ?? "").toLowerCase();
  if (!s) return null;
  if (/monat/.test(s)) return "monthly";
  if (/quartal/.test(s)) return "quarterly";
  if (/jahr|jähr|jaehr/.test(s)) return "yearly";
  return null;
}

function parseFixedCosts(ctx: Ctx, ws: ExcelJS.Worksheet | undefined, report: ImportReport, today: string): FixedCostImportDraft[] {
  const sheet = "Kalkulation" as const;
  if (!ws) {
    ctx.warn(sheet, null, "Blatt „Kalkulation“ nicht gefunden.");
    return [];
  }
  const loc = locateColumns(ws, FIXED_COLS, "category");
  if (!loc) {
    ctx.warn(sheet, null, "Kopfzeile mit „Fixkosten Kategorie“ nicht gefunden.");
    return [];
  }
  const out: FixedCostImportDraft[] = [];
  const count = report.counts[sheet];
  for (const row of dataRows(ws, loc.headerRow)) {
    const { values: v } = readRow(ctx, sheet, row, loc.cols);
    count.rows++;
    const category = asString(v.category);
    if (!category && v.amount === null) {
      count.skippedEmpty++;
      continue;
    }
    if (category && /^(summe|gesamt|total)/i.test(category)) {
      count.skippedEmpty++;
      continue;
    }
    const amountCents = toCents(v.amount);
    if (!category || amountCents === null) {
      ctx.warn(sheet, row.number, "Kategorie oder Betrag fehlt – Zeile übersprungen.");
      count.skippedInvalid++;
      continue;
    }
    let interval = mapInterval(asString(v.interval));
    if (!interval) {
      ctx.warn(sheet, row.number, `Intervall „${asString(v.interval) ?? ""}“ unbekannt – monatlich angenommen.`);
      interval = "monthly";
    }
    let startDate = toIsoDate(v.start);
    if (!startDate) {
      startDate = `${today.slice(0, 4)}-01-01`;
      ctx.warn(sheet, row.number, `Startdatum fehlt – ${startDate} angenommen.`);
    }
    const divisor = interval === "monthly" ? 1 : interval === "quarterly" ? 3 : 12;
    const computedShare = Math.round(amountCents / divisor);
    const share = toCents(v.share);
    if (share !== null && Math.abs(share - computedShare) > 1) {
      ctx.warn(sheet, row.number, `Anteil mtl. ${(share / 100).toFixed(2)} € passt nicht zu Betrag/Intervall (${(computedShare / 100).toFixed(2)} €).`);
    }
    out.push({ row: row.number, category, amountCents, interval, monthlyShareCents: computedShare, startDate });
    count.imported++;
  }
  return out;
}

// ───────────────────────── Einstieg ─────────────────────────
export async function parseWorkbook(buffer: ArrayBuffer | Uint8Array, opts: ParseOptions = {}): Promise<ImportResult> {
  const today = opts.today ?? berlinDateIso();
  const wb = new ExcelJS.Workbook();
  const ctx = new Ctx();
  const report: ImportReport = {
    counts: Object.fromEntries(SHEET_NAMES.map((n) => [n, { rows: 0, imported: 0, skippedEmpty: 0, skippedInvalid: 0 }])) as ImportReport["counts"],
    warnings: ctx.warnings,
    duplicates: [],
    skippedEmptyRows: 0,
    collectiveParts: 0,
  };
  try {
    const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    // exceljs erwartet einen Node-Buffer
    // Tabellen-/Filter-/Validierungsknoten überspringen: exceljs stürzt sonst bei Excel-Tabellen mit
    // Autofilter ab ("filterButton") – für den Import brauchen wir nur Zellwerte.
    const cleaned = await stripExcelTables(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    await wb.xlsx.load(cleaned as unknown as Parameters<ExcelJS.Workbook["xlsx"]["load"]>[0], {
      ignoreNodes: ["tableParts", "autoFilter", "dataValidations", "extLst", "conditionalFormatting"],
    } as unknown as Parameters<ExcelJS.Workbook["xlsx"]["load"]>[1]);
  } catch (e) {
    ctx.warn("Arbeitsmappe", null, `Datei konnte nicht gelesen werden: ${(e as Error).message}`);
    return { patients: [], services: [], vouchers: [], invoices: [], fixedCosts: [], report };
  }

  const patients = parsePatients(ctx, findSheet(wb, "Patienten"), report);
  const services = parseServices(ctx, findSheet(wb, "Leistungen"), report);
  const vouchers = parseVouchers(ctx, findSheet(wb, "Gutscheine"), report, today);
  const invoices = parseInvoices(ctx, findSheet(wb, "Rechnungen"), report, services);
  const fixedCosts = parseFixedCosts(ctx, findSheet(wb, "Kalkulation"), report, today);

  // Querverweise prüfen
  const patientIds = new Set(patients.map((p) => p.legacyId).filter((x): x is number => x !== null));
  const voucherIds = new Set(vouchers.map((v) => v.legacyId).filter((x): x is number => x !== null));
  for (const inv of invoices) {
    if (inv.patientLegacyId !== null && !patientIds.has(inv.patientLegacyId)) {
      ctx.warn("Rechnungen", inv.row, `Patienten-ID ${inv.patientLegacyId} nicht im Blatt „Patienten“.`);
    }
    for (const p of inv.payments) {
      if (p.method === "voucher" && p.voucherLegacyId != null && !voucherIds.has(p.voucherLegacyId)) {
        ctx.warn("Rechnungen", inv.row, `GS-ID ${p.voucherLegacyId} nicht im Blatt „Gutscheine“.`);
      }
    }
  }

  report.duplicates = findDuplicates(patients);
  report.skippedEmptyRows = SHEET_NAMES.reduce((a, n) => a + report.counts[n].skippedEmpty, 0);
  return { patients, services, vouchers, invoices, fixedCosts, report };
}


/**
 * Entfernt Excel-„Tabellen“ (ListObjects) aus der Datei, bevor exceljs sie liest.
 * exceljs 4.4 stürzt bei Tabellen mit Autofilter ab („filterButton“, z. B. Rechnungsmanager V0.9.2).
 * Für den Import werden nur die Zellwerte gebraucht; die Originaldatei bleibt unverändert.
 */
async function stripExcelTables(buf: Buffer): Promise<Buffer> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(buf);
  const tables = Object.keys(zip.files).filter((f) => /^xl\/tables\/.+\.xml$/i.test(f));
  if (!tables.length) return buf;
  for (const f of tables) zip.remove(f);
  for (const f of Object.keys(zip.files).filter((n) => /^xl\/worksheets\/_rels\/.+\.rels$/i.test(n))) {
    const xml = await zip.file(f)!.async("string");
    zip.file(f, xml.replace(/<Relationship\b[^>]*Target="[^"]*tables\/[^"]*"[^>]*\/>/gi, ""));
  }
  for (const f of Object.keys(zip.files).filter((n) => /^xl\/worksheets\/[^/]+\.xml$/i.test(n))) {
    const xml = await zip.file(f)!.async("string");
    zip.file(f, xml.replace(/<tableParts\b[^>]*>[\s\S]*?<\/tableParts>/gi, "").replace(/<tableParts\b[^>]*\/>/gi, ""));
  }
  const ct = zip.file("[Content_Types].xml");
  if (ct) {
    const xml = await ct.async("string");
    zip.file("[Content_Types].xml", xml.replace(/<Override\b[^>]*PartName="\/xl\/tables\/[^"]*"[^>]*\/>/gi, ""));
  }
  return zip.generateAsync({ type: "nodebuffer" });
}
