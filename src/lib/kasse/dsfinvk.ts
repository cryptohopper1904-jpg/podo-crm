/**
 * DSFinV-K-Export (Digitale Schnittstelle der Finanzverwaltung für Kassensysteme, Version 2.x) – reine Funktionen.
 *
 * Aufbau nach DSFinV-K: Module „Stammdaten“, „Kassenabschluss“ und „Einzelaufzeichnung“, je Tabelle eine CSV-Datei
 * plus index.xml (Beschreibung nach GDPdU-DTD „gdpdu-01-09-2004.dtd“).
 * Format: UTF-8, Spaltentrenner „;“, Zeilenende CRLF, Text in doppelten Anführungszeichen (innere verdoppelt),
 * Dezimalkomma ohne Tausendertrennzeichen, erste Zeile = Spaltennamen (index.xml: Range From 2).
 *
 * Zuordnung PodoCRM → DSFinV-K: ein Kassenabschluss (cash_closings) = ein Z-Bon (Z_NR); Zahlungen an der Kasse
 * (Bar/Karte/Gutschein) und Einlagen/Entnahmen = Bons (Bonkopf/Bonpos). Rechnungsnummern stehen in Bon_Referenzen
 * (REF_TYP „ExterneRechnung“).
 *
 * Unsichere Punkte sind mit „TODO DSFinV-K prüfen“ markiert und in docs/KASSE.md gelistet.
 */
import JSZip from "jszip";
import type { Bon } from "./model";
import { UST_KEY_LABEL, UST_KEY_RATE } from "./model";

// ───────────────────────── Tabellenbeschreibung ─────────────────────────
type ColType = { t: "text"; max?: number } | { t: "num"; acc: number } | { t: "int" } | { t: "date" } | { t: "datetime" };
type Col = { name: string; type: ColType; key?: boolean };
export type TableSpec = { file: string; name: string; description: string; columns: Col[] };

const T = (max?: number): ColType => ({ t: "text", max });
const N2: ColType = { t: "num", acc: 2 };
const N3: ColType = { t: "num", acc: 3 };
const INT: ColType = { t: "int" };
const DT: ColType = { t: "datetime" };
const D: ColType = { t: "date" };

const zKey: Col[] = [
  { name: "Z_KASSE_ID", type: T(50), key: true },
  { name: "Z_ERSTELLUNG", type: DT, key: true },
  { name: "Z_NR", type: INT, key: true },
];
const bonKey: Col[] = [...zKey, { name: "BON_ID", type: T(40), key: true }];
const c = (name: string, type: ColType, key = false): Col => ({ name, type, key });

// TODO DSFinV-K prüfen: Tabellennamen (index.xml <Name>), Feldlängen und Nachkommastellen gegen die aktuelle Spezifikation 2.x
export const TABLES: TableSpec[] = [
  {
    file: "cashpointclosing.csv",
    name: "Stamm_Abschluss",
    description: "Stammdaten Kassenabschluss",
    columns: [
      ...zKey,
      c("Z_BUCHUNGSTAG", D),
      c("TAXONOMIE_VERSION", T(10)),
      c("Z_START_ID", T(40)),
      c("Z_ENDE_ID", T(40)),
      c("NAME", T(60)),
      c("STRASSE", T(60)),
      c("PLZ", T(10)),
      c("ORT", T(62)),
      c("LAND", T(3)),
      c("STNR", T(20)),
      c("USTID", T(15)),
      c("Z_SE_ZAHLUNGEN", N2),
      c("Z_SE_BARZAHLUNGEN", N2),
    ],
  },
  {
    file: "location.csv",
    name: "Stamm_Orte",
    description: "Stammdaten Orte",
    columns: [...zKey, c("LOC_NAME", T(60)), c("LOC_STRASSE", T(60)), c("LOC_PLZ", T(10)), c("LOC_ORT", T(62)), c("LOC_LAND", T(3)), c("LOC_USTID", T(15))],
  },
  {
    file: "cashregister.csv",
    name: "Stamm_Kassen",
    description: "Stammdaten Kassen",
    columns: [
      ...zKey,
      c("KASSE_BRAND", T(50)),
      c("KASSE_MODELL", T(50)),
      c("KASSE_SERIENNR", T(70)),
      c("KASSE_SW_BRAND", T(50)),
      c("KASSE_SW_VERSION", T(50)),
      c("KASSE_BASISWAEH_CODE", T(3)),
      c("KEINE_UST_ZUORDNUNG", T(1)),
    ],
  },
  {
    file: "vat.csv",
    name: "Stamm_USt",
    description: "Stammdaten Umsatzsteuer",
    columns: [...zKey, c("UST_SCHLUESSEL", INT, true), c("UST_SATZ", N2), c("UST_BESCHR", T(55))],
  },
  {
    file: "tse.csv",
    name: "Stamm_TSE",
    description: "Stammdaten TSE",
    columns: [
      ...zKey,
      c("TSE_ID", INT, true),
      c("TSE_SERIAL", T(68)),
      c("TSE_SIG_ALGO", T(21)),
      c("TSE_ZEITFORMAT", T(31)),
      c("TSE_PD_ENCODING", T(5)),
      c("TSE_PUBLIC_KEY", T(512)),
      c("TSE_ZERTIFIKAT_I", T(1000)),
      c("TSE_ZERTIFIKAT_II", T(1000)),
    ],
  },
  {
    file: "businesscases.csv",
    name: "Z_GV_Typ",
    description: "Kassenabschluss: Geschäftsvorfälle",
    columns: [...zKey, c("GV_TYP", T(30), true), c("GV_NAME", T(40), true), c("AGENTUR_ID", INT, true), c("UST_SCHLUESSEL", INT, true), c("Z_UMS_BRUTTO", N2), c("Z_UMS_NETTO", N2), c("Z_UST", N2)],
  },
  {
    file: "payment.csv",
    name: "Z_Zahlart",
    description: "Kassenabschluss: Zahlarten",
    columns: [...zKey, c("ZAHLART_TYP", T(25), true), c("ZAHLART_NAME", T(60), true), c("Z_ZAHLART_BETRAG", N2)],
  },
  {
    file: "cash_per_currency.csv",
    name: "Z_Waehrungen",
    description: "Kassenabschluss: Bargeld je Währung",
    columns: [...zKey, c("ZAHLART_WAEH", T(3), true), c("ZAHLART_BETRAG_WAEH", N2)],
  },
  {
    file: "transactions.csv",
    name: "Bonkopf",
    description: "Einzelaufzeichnung: Bonkopf",
    columns: [
      ...bonKey,
      c("BON_NR", INT),
      c("BON_TYP", T(30)),
      c("BON_NAME", T(60)),
      c("TERMINAL_ID", T(50)),
      c("BON_STORNO", T(1)),
      c("BON_START", DT),
      c("BON_ENDE", DT),
      c("BEDIENER_ID", T(50)),
      c("BEDIENER_NAME", T(50)),
      c("UMS_BRUTTO", N2),
      c("KUNDE_NAME", T(50)),
      c("KUNDE_ID", T(50)),
      c("KUNDE_TYP", T(50)),
      c("KUNDE_STRASSE", T(60)),
      c("KUNDE_PLZ", T(10)),
      c("KUNDE_ORT", T(62)),
      c("KUNDE_LAND", T(3)),
      c("KUNDE_USTID", T(15)),
      c("BON_NOTIZ", T(255)),
    ],
  },
  {
    file: "transactions_vat.csv",
    name: "Bonkopf_USt",
    description: "Einzelaufzeichnung: Bonkopf USt",
    columns: [...bonKey, c("UST_SCHLUESSEL", INT, true), c("BON_BRUTTO", N2), c("BON_NETTO", N2), c("BON_UST", N2)],
  },
  {
    file: "datapayment.csv",
    name: "Bonkopf_Zahlarten",
    description: "Einzelaufzeichnung: Zahlarten",
    columns: [...bonKey, c("ZAHLART_TYP", T(25), true), c("ZAHLART_NAME", T(60), true), c("ZAHLWAEH_CODE", T(3), true), c("ZAHLWAEH_BETRAG", N2), c("BASISWAEH_BETRAG", N2)],
  },
  {
    file: "lines.csv",
    name: "Bonpos",
    description: "Einzelaufzeichnung: Bonpositionen",
    columns: [
      ...bonKey,
      c("POS_ZEILE", T(50), true),
      c("GUTSCHEIN_NR", T(50)),
      c("ARTIKELTEXT", T(255)),
      c("POS_TERMINAL_ID", T(50)),
      c("GV_TYP", T(30)),
      c("GV_NAME", T(40)),
      c("INHAUS", T(1)),
      c("P_STORNO", T(1)),
      c("AGENTUR_ID", INT),
      c("ART_NR", T(50)),
      c("GTIN", T(50)),
      c("WARENGR_ID", T(40)),
      c("WARENGR", T(50)),
      c("MENGE", N3),
      c("FAKTOR", N3),
      c("EINHEIT", T(50)),
      c("STK_BR", { t: "num", acc: 5 }),
    ],
  },
  {
    file: "lines_vat.csv",
    name: "Bonpos_USt",
    description: "Einzelaufzeichnung: Bonpositionen USt",
    columns: [...bonKey, c("POS_ZEILE", T(50), true), c("UST_SCHLUESSEL", INT, true), c("POS_BRUTTO", N2), c("POS_NETTO", N2), c("POS_UST", N2)],
  },
  {
    file: "transactions_tse.csv",
    name: "TSE_Transaktionen",
    description: "Einzelaufzeichnung: TSE-Transaktionen",
    columns: [
      ...bonKey,
      c("TSE_ID", INT, true),
      c("TSE_TANR", INT, true),
      c("TSE_TA_START", T(30)),
      c("TSE_TA_ENDE", T(30)),
      c("TSE_TA_VORGANGSART", T(30)),
      c("TSE_TA_SIGZ", INT),
      c("TSE_TA_SIG", T(512)),
      c("TSE_TA_FEHLER", T(200)),
      c("TSE_VORGANGSDATEN", T(1000)),
    ],
  },
  {
    file: "references.csv",
    name: "Bon_Referenzen",
    description: "Einzelaufzeichnung: Referenzen",
    columns: [
      ...bonKey,
      c("POS_ZEILE", T(50), true),
      c("REF_TYP", T(20)),
      c("REF_NAME", T(40)),
      c("REF_DATUM", DT),
      c("REF_KASSE_ID", T(50)),
      c("REF_Z_NR", INT),
      c("REF_BON_ID", T(40)),
    ],
  },
];

export const tableByFile = (file: string) => {
  const t = TABLES.find((x) => x.file === file);
  if (!t) throw new Error(`Unbekannte DSFinV-K-Tabelle ${file}`);
  return t;
};

// ───────────────────────── Feldformatierung ─────────────────────────
/** Betrag in Cent → „12,34“ / „-0,50“ (Dezimalkomma, keine Tausendertrennung) */
export function decimal(cents: number, acc = 2): string {
  if (!Number.isInteger(cents)) throw new Error("Betrag muss in Cent (ganzzahlig) vorliegen");
  if (acc === 2) {
    const neg = cents < 0;
    const abs = Math.abs(cents);
    return `${neg ? "-" : ""}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
  }
  return (cents / 100).toFixed(acc).replace(".", ",");
}

/** Zahl (z. B. Menge, Steuersatz) mit fester Nachkommazahl und Dezimalkomma */
export const fixed = (n: number, acc: number) => n.toFixed(acc).replace(".", ",");

/** Text in Anführungszeichen, innere Anführungszeichen verdoppelt, Zeilenumbrüche/Steuerzeichen → Leerzeichen, gekürzt */
export function quote(s: string | null | undefined, max?: number): string {
  let v = (s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (max && [...v].length > max) v = [...v].slice(0, max).join("");
  return `"${v.replace(/"/g, '""')}"`;
}

const berlinParts = (d: Date) => {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  return { y: g("year"), m: g("month"), d: g("day"), hh: g("hour"), mm: g("minute"), ss: g("second") };
};

/**
 * Zeitpunkt als „YYYY-MM-DDThh:mm:ss“ in Ortszeit (Europe/Berlin).
 * // TODO DSFinV-K prüfen: Ortszeit ohne Offset vs. UTC (TSE-Zeiten sind UTC, Format laut TSE_ZEITFORMAT)
 */
export function dateTime(d: Date): string {
  const x = berlinParts(d);
  return `${x.y}-${x.m}-${x.d}T${x.hh}:${x.mm}:${x.ss}`;
}

/** UTC-Zeitpunkt für TSE-Felder (ISO 8601 mit „Z“) */
export const utcTime = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export type Cell = string | number | null | undefined | { raw: string };

/** Wert gemäß Spaltentyp formatieren. Zahlen bei „num“ sind Cent (acc 2) bzw. echte Zahlen (acc ≠ 2). */
export function formatCell(col: Col, v: Cell): string {
  if (v && typeof v === "object" && "raw" in v) return v.raw;
  switch (col.type.t) {
    case "text":
      return quote(v === null || v === undefined ? "" : String(v), col.type.max);
    case "int":
      if (v === null || v === undefined || v === "") return "";
      if (!Number.isInteger(Number(v))) throw new Error(`${col.name}: ganze Zahl erwartet`);
      return String(Number(v));
    case "num":
      if (v === null || v === undefined || v === "") return "";
      return col.type.acc === 2 ? decimal(Number(v)) : fixed(Number(v), col.type.acc);
    case "date":
    case "datetime":
      if (v === null || v === undefined || v === "") return "";
      return String(v);
  }
}

const CRLF = "\r\n";

/** CSV-Datei: Kopfzeile (Spaltennamen) + Datenzeilen; jede Zeile hat genau so viele Felder wie Spalten. */
export function toCsv(spec: TableSpec, rows: Record<string, Cell>[]): string {
  const names = new Set(spec.columns.map((x) => x.name));
  const out = [spec.columns.map((x) => x.name).join(";")];
  for (const r of rows) {
    for (const k of Object.keys(r)) if (!names.has(k)) throw new Error(`${spec.file}: unbekannte Spalte ${k}`);
    out.push(spec.columns.map((col) => formatCell(col, r[col.name])).join(";"));
  }
  return out.join(CRLF) + CRLF;
}

/** Felder einer CSV-Zeile (berücksichtigt Anführungszeichen) – für Tests/Prüfungen */
export function splitCsvLine(lineText: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < lineText.length; i++) {
    const ch = lineText[i];
    if (q) {
      if (ch === '"' && lineText[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ";") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// ───────────────────────── index.xml ─────────────────────────
const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function columnXml(col: Col): string {
  const tag = col.key ? "VariablePrimaryKey" : "VariableColumn";
  let type: string;
  switch (col.type.t) {
    case "text":
      type = `<AlphaNumeric/>${col.type.max ? `<MaxLength>${col.type.max}</MaxLength>` : ""}`;
      break;
    case "int":
      type = "<Numeric/>";
      break;
    case "num":
      type = `<Numeric><Accuracy>${col.type.acc}</Accuracy></Numeric>`;
      break;
    case "date":
      type = "<Date><Format>YYYY-MM-DD</Format></Date>";
      break;
    case "datetime":
      type = '<Date><Format>YYYY-MM-DD"T"hh:mm:ss</Format></Date>';
      break;
  }
  return `        <${tag}><Name>${col.name}</Name>${type}</${tag}>`;
}

/**
 * index.xml nach GDPdU-DTD. Die DTD-Datei (gdpdu-01-09-2004.dtd, Download BMF/DSFinV-K) wird referenziert.
 * // TODO DSFinV-K prüfen: Fremdschlüssel (<ForeignKey>) zwischen den Tabellen und Validity-Angabe ergänzen
 */
export function indexXml(opts: { supplier: string; location: string; from: string; to: string; tables?: TableSpec[] }): string {
  const de = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
  const tables = (opts.tables ?? TABLES)
    .map(
      (t) => `    <Table>
      <URL>${t.file}</URL>
      <Name>${t.name}</Name>
      <Description>${xmlEsc(t.description)}</Description>
      <Validity>
        <Range><From>${de(opts.from)}</From><To>${de(opts.to)}</To></Range>
        <Format>DD.MM.YYYY</Format>
      </Validity>
      <UTF8/>
      <DecimalSymbol>,</DecimalSymbol>
      <DigitGroupingSymbol>.</DigitGroupingSymbol>
      <Range><From>2</From></Range>
      <VariableLength>
        <ColumnDelimiter>;</ColumnDelimiter>
        <RecordDelimiter>&#13;&#10;</RecordDelimiter>
        <TextEncapsulator>"</TextEncapsulator>
${t.columns.filter((x) => x.key).map(columnXml).join("\n")}
${t.columns.filter((x) => !x.key).map(columnXml).join("\n")}
      </VariableLength>
    </Table>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004.dtd">
<DataSet>
  <Version>1.0</Version>
  <DataSupplier>
    <Name>${xmlEsc(opts.supplier)}</Name>
    <Location>${xmlEsc(opts.location)}</Location>
    <Comment>DSFinV-K Export aus PodoCRM</Comment>
  </DataSupplier>
  <Media>
    <Name>DSFinV-K</Name>
${tables}
  </Media>
</DataSet>
`;
}

// ───────────────────────── Export-Modell ─────────────────────────
export type DsfinvkOrg = {
  name: string;
  street: string | null;
  zip: string | null;
  city: string | null;
  taxNumber: string | null;
  vatId: string | null;
};

export type DsfinvkRegister = {
  kasseId: string;
  brand: string;
  model: string;
  serial: string;
  swBrand: string;
  swVersion: string;
};

export type DsfinvkClosing = {
  number: number;
  businessDate: string;
  createdAt: Date;
  bons: Bon[];
  /** TSE laut Abschluss (nur echte TSE, keine Test-Signaturen) */
  tseSerials: string[];
};

/** Version der DSFinV-K-Taxonomie. // TODO DSFinV-K prüfen: aktuelle Version (2.3 / 2.4) */
export const TAXONOMY_VERSION = "2.3";

const zCols = (reg: DsfinvkRegister, z: DsfinvkClosing) => ({ Z_KASSE_ID: reg.kasseId, Z_ERSTELLUNG: dateTime(z.createdAt), Z_NR: z.number });

/** Erzeugt alle CSV-Dateien (Dateiname → Inhalt). */
export function buildDsfinvkFiles(org: DsfinvkOrg, reg: DsfinvkRegister, closings: DsfinvkClosing[]): Record<string, string> {
  const rows: Record<string, Record<string, Cell>[]> = Object.fromEntries(TABLES.map((t) => [t.file, []]));
  const push = (file: string, r: Record<string, Cell>) => rows[file].push(r);

  for (const z of closings) {
    const zc = zCols(reg, z);
    const all = z.bons.flatMap((b) => b.payments);
    const total = all.reduce((s, p) => s + p.amountCents, 0);
    const cash = all.filter((p) => p.typ === "Bar").reduce((s, p) => s + p.amountCents, 0);
    push("cashpointclosing.csv", {
      ...zc,
      Z_BUCHUNGSTAG: z.businessDate,
      TAXONOMIE_VERSION: TAXONOMY_VERSION,
      Z_START_ID: z.bons[0]?.bonId ?? "",
      Z_ENDE_ID: z.bons[z.bons.length - 1]?.bonId ?? "",
      NAME: org.name,
      STRASSE: org.street,
      PLZ: org.zip,
      ORT: org.city,
      LAND: "DEU",
      STNR: org.taxNumber,
      USTID: org.vatId,
      Z_SE_ZAHLUNGEN: total,
      Z_SE_BARZAHLUNGEN: cash,
    });
    push("location.csv", { ...zc, LOC_NAME: org.name, LOC_STRASSE: org.street, LOC_PLZ: org.zip, LOC_ORT: org.city, LOC_LAND: "DEU", LOC_USTID: org.vatId });
    push("cashregister.csv", {
      ...zc,
      KASSE_BRAND: reg.brand,
      KASSE_MODELL: reg.model,
      KASSE_SERIENNR: reg.serial,
      KASSE_SW_BRAND: reg.swBrand,
      KASSE_SW_VERSION: reg.swVersion,
      KASSE_BASISWAEH_CODE: "EUR",
      // TODO DSFinV-K prüfen: Kodierung des Kennzeichens (0/1)
      KEINE_UST_ZUORDNUNG: "0",
    });
    const keys = new Set<number>();
    for (const b of z.bons) for (const l of b.lines) keys.add(l.ustKey);
    for (const k of [...keys].sort((a, b) => a - b)) {
      push("vat.csv", { ...zc, UST_SCHLUESSEL: k, UST_SATZ: { raw: fixed(UST_KEY_RATE[k] ?? 0, 2) }, UST_BESCHR: UST_KEY_LABEL[k] ?? "" });
    }
    z.tseSerials.forEach((serial, i) =>
      push("tse.csv", {
        ...zc,
        TSE_ID: i + 1,
        TSE_SERIAL: serial,
        // TODO DSFinV-K prüfen: Algorithmus, Zeitformat, Encoding, Public Key und Zertifikate vom TSE-Anbieter (fiskaly) übernehmen
        TSE_SIG_ALGO: "ecdsa-plain-SHA384",
        TSE_ZEITFORMAT: "unixTime",
        TSE_PD_ENCODING: "UTF-8",
        TSE_PUBLIC_KEY: "",
        TSE_ZERTIFIKAT_I: "",
        TSE_ZERTIFIKAT_II: "",
      }),
    );

    // Kassenabschluss-Summen
    const gv = new Map<string, { GV_TYP: string; UST_SCHLUESSEL: number; b: number; n: number; u: number }>();
    const pay = new Map<string, { typ: string; name: string; a: number }>();
    for (const b of z.bons) {
      for (const l of b.lines) {
        const k = `${l.gvTyp}|${l.ustKey}`;
        const e = gv.get(k) ?? { GV_TYP: l.gvTyp, UST_SCHLUESSEL: l.ustKey, b: 0, n: 0, u: 0 };
        e.b += l.grossCents;
        e.n += l.netCents;
        e.u += l.vatCents;
        gv.set(k, e);
      }
      for (const p of b.payments) {
        const k = `${p.typ}|${p.name}`;
        const e = pay.get(k) ?? { typ: p.typ, name: p.name, a: 0 };
        e.a += p.amountCents;
        pay.set(k, e);
      }
    }
    for (const e of [...gv.values()].sort((a, b) => a.GV_TYP.localeCompare(b.GV_TYP) || a.UST_SCHLUESSEL - b.UST_SCHLUESSEL)) {
      // TODO DSFinV-K prüfen: AGENTUR_ID 0 für eigene Umsätze
      push("businesscases.csv", { ...zc, GV_TYP: e.GV_TYP, GV_NAME: "", AGENTUR_ID: 0, UST_SCHLUESSEL: e.UST_SCHLUESSEL, Z_UMS_BRUTTO: e.b, Z_UMS_NETTO: e.n, Z_UST: e.u });
    }
    for (const e of [...pay.values()].sort((a, b) => a.typ.localeCompare(b.typ) || a.name.localeCompare(b.name))) {
      push("payment.csv", { ...zc, ZAHLART_TYP: e.typ, ZAHLART_NAME: e.name, Z_ZAHLART_BETRAG: e.a });
    }
    push("cash_per_currency.csv", { ...zc, ZAHLART_WAEH: "EUR", ZAHLART_BETRAG_WAEH: cash });

    // Einzelaufzeichnungen
    for (const b of z.bons) {
      const bc = { ...zc, BON_ID: b.bonId };
      push("transactions.csv", {
        ...bc,
        BON_NR: b.bonNr,
        BON_TYP: "Beleg",
        BON_NAME: "",
        TERMINAL_ID: "",
        BON_STORNO: "0",
        BON_START: dateTime(b.start),
        BON_ENDE: dateTime(b.end),
        BEDIENER_ID: b.operator?.id ?? "",
        BEDIENER_NAME: b.operator?.name ?? "",
        UMS_BRUTTO: b.totalCents,
        // Keine Kundendaten (Gesundheitsdaten-Bezug) – Pflicht nur ab Schwellen/auf Verlangen. // TODO DSFinV-K prüfen
        KUNDE_NAME: "",
        KUNDE_ID: "",
        KUNDE_TYP: "",
        KUNDE_STRASSE: "",
        KUNDE_PLZ: "",
        KUNDE_ORT: "",
        KUNDE_LAND: "",
        KUNDE_USTID: "",
        BON_NOTIZ: b.note ?? "",
      });
      const bv = new Map<number, { b: number; n: number; u: number }>();
      for (const l of b.lines) {
        const e = bv.get(l.ustKey) ?? { b: 0, n: 0, u: 0 };
        e.b += l.grossCents;
        e.n += l.netCents;
        e.u += l.vatCents;
        bv.set(l.ustKey, e);
        push("lines.csv", {
          ...bc,
          POS_ZEILE: String(l.pos),
          GUTSCHEIN_NR: l.voucherCode ?? "",
          ARTIKELTEXT: l.text,
          POS_TERMINAL_ID: "",
          GV_TYP: l.gvTyp,
          GV_NAME: "",
          INHAUS: "0",
          P_STORNO: "0",
          AGENTUR_ID: 0,
          ART_NR: "",
          GTIN: "",
          WARENGR_ID: "",
          WARENGR: "",
          MENGE: 1,
          FAKTOR: 1,
          EINHEIT: "",
          STK_BR: l.grossCents / 100,
        });
        push("lines_vat.csv", { ...bc, POS_ZEILE: String(l.pos), UST_SCHLUESSEL: l.ustKey, POS_BRUTTO: l.grossCents, POS_NETTO: l.netCents, POS_UST: l.vatCents });
      }
      for (const [k, e] of [...bv.entries()].sort((a, b) => a[0] - b[0])) {
        push("transactions_vat.csv", { ...bc, UST_SCHLUESSEL: k, BON_BRUTTO: e.b, BON_NETTO: e.n, BON_UST: e.u });
      }
      for (const p of b.payments) {
        push("datapayment.csv", { ...bc, ZAHLART_TYP: p.typ, ZAHLART_NAME: p.name, ZAHLWAEH_CODE: "EUR", ZAHLWAEH_BETRAG: p.amountCents, BASISWAEH_BETRAG: p.amountCents });
      }
      if (b.tse && !b.tse.isTest) {
        const tseId = z.tseSerials.indexOf(b.tse.serial) + 1;
        push("transactions_tse.csv", {
          ...bc,
          TSE_ID: tseId || 1,
          TSE_TANR: b.tse.number,
          // TODO DSFinV-K prüfen: Start/Ende, Signatur und Prozessdaten der TSE-Transaktion speichern und hier ausgeben
          TSE_TA_START: "",
          TSE_TA_ENDE: "",
          TSE_TA_VORGANGSART: "Kassenbeleg-V1",
          TSE_TA_SIGZ: b.tse.signatureCounter,
          TSE_TA_SIG: "",
          TSE_TA_FEHLER: "",
          TSE_VORGANGSDATEN: "",
        });
      }
      if (b.invoiceNumber) {
        push("references.csv", { ...bc, POS_ZEILE: "", REF_TYP: "ExterneRechnung", REF_NAME: b.invoiceNumber, REF_DATUM: "", REF_KASSE_ID: "", REF_Z_NR: "", REF_BON_ID: "" });
      }
    }
  }
  return Object.fromEntries(TABLES.map((t) => [t.file, toCsv(t, rows[t.file])]));
}

/** ZIP mit allen CSV-Dateien und index.xml. */
export async function buildDsfinvkZip(org: DsfinvkOrg, reg: DsfinvkRegister, closings: DsfinvkClosing[], range: { from: string; to: string }): Promise<Uint8Array> {
  const zip = new JSZip();
  const date = new Date();
  const files = buildDsfinvkFiles(org, reg, closings);
  for (const [name, content] of Object.entries(files)) zip.file(name, content, { date });
  zip.file("index.xml", indexXml({ supplier: org.name, location: [org.zip, org.city].filter(Boolean).join(" ") || "Deutschland", from: range.from, to: range.to }), { date });
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
