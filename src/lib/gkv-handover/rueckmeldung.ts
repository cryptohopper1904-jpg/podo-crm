/**
 * Rückmeldung eines Abrechnungszentrums (GKV Paket E, neutrales Format – docs/GKV-ABRECHNUNGSZENTRUM.md, Abschnitt
 * „Rückmeldung“): je Verordnung ausgezahlter Kassenbetrag und ggf. Absetzung (Betrag, Code, Grund), dazu Datum der
 * Auszahlung und Sammelrechnungsnummer. CSV (UTF-8, mit oder ohne BOM, Semikolon oder Komma) oder JSON.
 *
 * Reine Prüfung ohne Datenbank: strikt (feste Spalten, ganze Cent, echte Kalenderdaten, Grenzen für Größe und
 * Zeilenzahl), Fehler je Zeile mit Zeilennummer. Inhalte werden nie ausgewertet (keine Formeln) – Textfelder bleiben
 * Text, Steuerzeichen werden entfernt. Bei Fehlern liefert die Funktion keine Zeilen (alles oder nichts).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { detectDelimiter, parseCsvWithLines, stripBom } from "@/integrations/csv";
import { cleanText, DEDUCTION_MAX_CENTS } from "@/lib/rules/gkv-billing";
import { normalizeId } from "@/lib/rules/gkv-ids";

export const RUECKMELDUNG_SCHEMA = "podohero-rueckmeldung/1";
/** größte Datei: 1 MB (5.000 Zeilen à ~150 Byte passen bequem) */
export const RUECKMELDUNG_MAX_BYTES = 1_048_576;
export const RUECKMELDUNG_MAX_ZEILEN = 5_000;
/** höchster Auszahlungsbetrag je Verordnung (100.000 €) – Plausibilitätsgrenze */
export const AUSZAHLUNG_MAX_CENT = 10_000_000;
const MAX_FEHLER = 50;

export const RUECKMELDUNG_SPALTEN = [
  "Verordnung-ID",
  "Lauf-ID",
  "Versichertennummer",
  "Ausstellungsdatum",
  "Ausgezahlt EUR",
  "Absetzung EUR",
  "Absetzung Code",
  "Absetzung Grund",
  "Auszahlungsdatum",
  "Sammelrechnungsnummer",
] as const;
/** optionale Spalten (dürfen fehlen) */
export const RUECKMELDUNG_OPTIONAL = ["Gebühr EUR"] as const;

export type RueckmeldungZeile = {
  /** Zeilennummer in der Datei (CSV: Kopf = 1) bzw. Position (JSON: ab 1) */
  zeile: number;
  verordnungId: string | null;
  laufId: string | null;
  versichertennummer: string | null;
  ausstellungsdatum: string | null;
  ausgezahltCent: number;
  /** vom Abrechnungszentrum einbehaltene Gebühr (optional, 0 = keine Angabe) */
  gebuehrCent: number;
  absetzung: { betragCent: number; code: string | null; grund: string } | null;
};

export type Rueckmeldung = {
  format: "csv" | "json" | null;
  sha256: string;
  groesse: number;
  auszahlungsdatum: string | null;
  sammelrechnungsnummer: string | null;
  /** leer, sobald es Fehler gibt */
  zeilen: RueckmeldungZeile[];
  fehler: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSICHERTENNUMMER = /^[A-Z0-9]{1,20}$/;
/** Euro-Betrag ohne Vorzeichen und Tausendertrennzeichen, höchstens 2 Nachkommastellen */
const EURO = /^\d{1,9}(?:[.,]\d{1,2})?$/;

function echtesDatum(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/** JJJJ-MM-TT oder TT.MM.JJJJ → ISO; sonst null */
export function datumAus(v: string): string | null {
  const s = v.trim();
  const de = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  const iso = de ? `${de[3]}-${de[2]}-${de[1]}` : s;
  return echtesDatum(iso) ? iso : null;
}

/** „123,45“ / „123.45“ / „5“ → Cent; sonst null (kein Vorzeichen, keine Tausenderpunkte, keine Formeln) */
export function centAus(v: string): number | null {
  const s = v.trim();
  if (!EURO.test(s)) return null;
  const [ganz, nach = ""] = s.replace(",", ".").split(".");
  return Number(ganz) * 100 + Number(nach.padEnd(2, "0"));
}

const text = (v: string | undefined, max: number) => cleanText(v ?? "", max + 1);

function leer(sha256: string, groesse: number, fehler: string[], format: Rueckmeldung["format"] = null): Rueckmeldung {
  return { format, sha256, groesse, auszahlungsdatum: null, sammelrechnungsnummer: null, zeilen: [], fehler };
}

type Roh = {
  zeile: number;
  verordnungId: string;
  laufId: string;
  versichertennummer: string;
  ausstellungsdatum: string;
  ausgezahlt: string | number | undefined;
  gebuehr: string | number | undefined;
  absetzungBetrag: string | number | undefined;
  absetzungCode: string;
  absetzungGrund: string;
  auszahlungsdatum: string;
  sammelrechnungsnummer: string;
};

/** Prüft eine Zeile (CSV-Werte als Text, JSON-Werte als Cent-Zahlen) – Meldungen mit Präfix */
function pruefeZeile(r: Roh, praefix: string, heute: string, fehler: string[]): RueckmeldungZeile | null {
  const f: string[] = [];
  const vo = r.verordnungId.trim();
  if (vo && !UUID.test(vo)) f.push("Verordnung-ID ist keine gültige ID");
  const lauf = r.laufId.trim();
  if (lauf && !UUID.test(lauf)) f.push("Lauf-ID ist keine gültige ID");
  const vnr = normalizeId(r.versichertennummer);
  if (vnr && !VERSICHERTENNUMMER.test(vnr)) f.push("Versichertennummer ungültig (Buchstaben/Ziffern, höchstens 20)");
  const ausgestellt = r.ausstellungsdatum.trim() ? datumAus(r.ausstellungsdatum) : null;
  if (r.ausstellungsdatum.trim() && !ausgestellt) f.push("Ausstellungsdatum ungültig (JJJJ-MM-TT oder TT.MM.JJJJ)");
  if (!vo && !(vnr && r.ausstellungsdatum.trim())) f.push("Zuordnung fehlt – Verordnung-ID oder Versichertennummer und Ausstellungsdatum angeben");
  const cent = (v: string | number | undefined) => (typeof v === "number" ? (Number.isInteger(v) && v >= 0 ? v : null) : v === undefined ? null : centAus(v));
  const ausgezahlt = cent(r.ausgezahlt);
  if (ausgezahlt === null) f.push("Ausgezahlt EUR fehlt oder ist ungültig (z. B. 123,45 – ohne Vorzeichen und Tausenderpunkt)");
  else if (ausgezahlt > AUSZAHLUNG_MAX_CENT) f.push("Ausgezahlt EUR über 100.000 € – bitte prüfen");
  const hatGebuehr = r.gebuehr !== undefined && String(r.gebuehr).trim() !== "";
  const gebuehr = hatGebuehr ? cent(r.gebuehr) : 0;
  if (gebuehr === null) f.push("Gebühr EUR ungültig (z. B. 3,50)");
  else if (gebuehr > AUSZAHLUNG_MAX_CENT) f.push("Gebühr über 100.000 € – bitte prüfen");
  const hatAbsetzung = r.absetzungBetrag !== undefined && String(r.absetzungBetrag).trim() !== "";
  const absBetrag = hatAbsetzung ? cent(r.absetzungBetrag) : 0;
  if (absBetrag === null) f.push("Absetzung EUR ungültig (z. B. 12,50)");
  else if (absBetrag > DEDUCTION_MAX_CENTS) f.push("Absetzung über 10.000 € – bitte prüfen");
  const code = text(r.absetzungCode, 20);
  if (code.length > 20) f.push("Absetzung Code: höchstens 20 Zeichen");
  const grund = text(r.absetzungGrund, 500);
  if (grund.length > 500) f.push("Absetzung Grund: höchstens 500 Zeichen");
  if (absBetrag && grund.length < 3) f.push("Absetzung ohne Grund – bitte den Grund angeben (mindestens 3 Zeichen)");
  if (!absBetrag && (code || grund)) f.push("Absetzung Code/Grund ohne Absetzungsbetrag");
  const datum = datumAus(r.auszahlungsdatum);
  if (!datum || datum < "2000-01-01") f.push("Auszahlungsdatum fehlt oder ist ungültig");
  else if (datum > heute) f.push("Auszahlungsdatum liegt in der Zukunft");
  if (text(r.sammelrechnungsnummer, 60).length > 60) f.push("Sammelrechnungsnummer: höchstens 60 Zeichen");
  if (f.length) {
    for (const m of f) fehler.push(`${praefix}: ${m}`);
    return null;
  }
  return {
    zeile: r.zeile,
    verordnungId: vo ? vo.toLowerCase() : null,
    laufId: lauf ? lauf.toLowerCase() : null,
    versichertennummer: vnr || null,
    ausstellungsdatum: ausgestellt,
    ausgezahltCent: ausgezahlt!,
    gebuehrCent: gebuehr!,
    absetzung: absBetrag ? { betragCent: absBetrag, code: code || null, grund } : null,
  };
}

const jsonPosition = z
  .object({
    verordnung_id: z.string().max(40).optional(),
    lauf_id: z.string().max(40).optional(),
    versichertennummer: z.string().max(30).optional(),
    ausstellungsdatum: z.string().max(10).optional(),
    ausgezahlt_cent: z.number().int().min(0),
    gebuehr_cent: z.number().int().min(0).optional(),
    absetzung: z.object({ betrag_cent: z.number().int().min(1), code: z.string().max(40).optional(), grund: z.string().max(600) }).strict().optional(),
  })
  .strict();
const jsonDatei = z
  .object({
    schema: z.string(),
    sammelrechnungsnummer: z.string().max(80).optional(),
    auszahlungsdatum: z.string().max(10),
    positionen: z.array(z.unknown()).max(RUECKMELDUNG_MAX_ZEILEN, `höchstens ${RUECKMELDUNG_MAX_ZEILEN} Positionen je Datei`),
  })
  .strict();

/**
 * Prüft und liest eine Rückmeldung. `heute` (Berliner Datum) für „Auszahlungsdatum in der Zukunft“.
 * Format: Dateiendung .json bzw. Inhalt beginnt mit „{“ → JSON, sonst CSV.
 */
export function parseRueckmeldung(bytes: Uint8Array, dateiname: string, heute = new Date().toISOString().slice(0, 10)): Rueckmeldung {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const groesse = bytes.length;
  if (groesse > RUECKMELDUNG_MAX_BYTES) return leer(sha256, groesse, [`Datei zu groß (höchstens ${RUECKMELDUNG_MAX_BYTES / 1_048_576} MB).`]);
  let inhalt: string;
  try {
    inhalt = stripBom(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return leer(sha256, groesse, ["Datei ist kein gültiges UTF-8 – bitte als „CSV UTF-8“ bzw. JSON speichern."]);
  }
  if (inhalt.includes("\u0000")) return leer(sha256, groesse, ["Datei enthält Binärdaten – bitte CSV oder JSON hochladen."]);
  const istJson = /\.json$/i.test(dateiname) || inhalt.trimStart().startsWith("{");
  const fehler: string[] = [];
  const roh: Roh[] = [];
  let format: Rueckmeldung["format"];

  if (istJson) {
    format = "json";
    let daten: unknown;
    try {
      daten = JSON.parse(inhalt);
    } catch {
      return leer(sha256, groesse, ["JSON ist nicht lesbar."], format);
    }
    const kopf = jsonDatei.safeParse(daten);
    if (!kopf.success) return leer(sha256, groesse, kopf.error.issues.slice(0, 10).map((i) => `JSON: ${i.path.join(".") || "Datei"} – ${i.message}`), format);
    if (kopf.data.schema !== RUECKMELDUNG_SCHEMA) return leer(sha256, groesse, [`Unbekanntes Schema „${cleanText(kopf.data.schema, 40)}“ – erwartet ${RUECKMELDUNG_SCHEMA}.`], format);
    if (!kopf.data.positionen.length) return leer(sha256, groesse, ["Die Rückmeldung enthält keine Zeilen."], format);
    kopf.data.positionen.forEach((p, i) => {
      const pos = jsonPosition.safeParse(p);
      if (!pos.success) {
        for (const iss of pos.error.issues.slice(0, 5)) fehler.push(`Position ${i + 1}: ${iss.path.join(".") || "Eintrag"} – ${iss.message}`);
        return;
      }
      const d = pos.data;
      roh.push({
        zeile: i + 1,
        verordnungId: d.verordnung_id ?? "",
        laufId: d.lauf_id ?? "",
        versichertennummer: d.versichertennummer ?? "",
        ausstellungsdatum: d.ausstellungsdatum ?? "",
        ausgezahlt: d.ausgezahlt_cent,
        gebuehr: d.gebuehr_cent,
        absetzungBetrag: d.absetzung?.betrag_cent,
        absetzungCode: d.absetzung?.code ?? "",
        absetzungGrund: d.absetzung?.grund ?? "",
        auszahlungsdatum: kopf.data.auszahlungsdatum,
        sammelrechnungsnummer: kopf.data.sammelrechnungsnummer ?? "",
      });
    });
  } else {
    format = "csv";
    const zeilen = parseCsvWithLines(inhalt, detectDelimiter(inhalt));
    if (!zeilen.length) return leer(sha256, groesse, ["Die Rückmeldung enthält keine Zeilen."], format);
    const kopf = zeilen[0].fields.map((h) => h.trim().toLowerCase());
    const bekannt = new Map([...RUECKMELDUNG_SPALTEN, ...RUECKMELDUNG_OPTIONAL].map((s) => [s.toLowerCase(), s]));
    const fehlend = RUECKMELDUNG_SPALTEN.filter((s) => !kopf.includes(s.toLowerCase()));
    if (fehlend.length) return leer(sha256, groesse, [`Spalte(n) fehlen: ${fehlend.join(", ")}.`], format);
    const unbekannt = kopf.filter((h) => h && !bekannt.has(h));
    if (unbekannt.length) return leer(sha256, groesse, [`Unbekannte Spalte(n): ${unbekannt.slice(0, 5).map((h) => cleanText(h, 40)).join(", ")} – erwartet: ${RUECKMELDUNG_SPALTEN.join("; ")}.`], format);
    if (new Set(kopf).size !== kopf.length) return leer(sha256, groesse, ["Spalte doppelt im Kopf."], format);
    const daten = zeilen.slice(1);
    if (!daten.length) return leer(sha256, groesse, ["Die Rückmeldung enthält keine Zeilen."], format);
    if (daten.length > RUECKMELDUNG_MAX_ZEILEN) return leer(sha256, groesse, [`Zu viele Zeilen: höchstens ${RUECKMELDUNG_MAX_ZEILEN} je Datei.`], format);
    type Spalte = (typeof RUECKMELDUNG_SPALTEN)[number] | (typeof RUECKMELDUNG_OPTIONAL)[number];
    const idx = (s: Spalte) => kopf.indexOf(s.toLowerCase());
    // Zeilennummer = echte Dateizeile (Leerzeilen und Umbrüche in Feldern mitgezählt)
    daten.forEach(({ line, fields: z }) => {
      if (z.length > kopf.length) {
        fehler.push(`Zeile ${line}: mehr Felder als Spalten im Kopf`);
        return;
      }
      const v = (s: Spalte) => (idx(s) < 0 ? "" : (z[idx(s)] ?? ""));
      roh.push({
        zeile: line,
        verordnungId: v("Verordnung-ID"),
        laufId: v("Lauf-ID"),
        versichertennummer: v("Versichertennummer"),
        ausstellungsdatum: v("Ausstellungsdatum"),
        ausgezahlt: v("Ausgezahlt EUR"),
        gebuehr: v("Gebühr EUR"),
        absetzungBetrag: v("Absetzung EUR"),
        absetzungCode: v("Absetzung Code"),
        absetzungGrund: v("Absetzung Grund"),
        auszahlungsdatum: v("Auszahlungsdatum"),
        sammelrechnungsnummer: v("Sammelrechnungsnummer"),
      });
    });
  }

  const ok: RueckmeldungZeile[] = [];
  const gesehen = new Map<string, number>();
  for (const r of roh) {
    const praefix = format === "json" ? `Position ${r.zeile}` : `Zeile ${r.zeile}`;
    // doppelte Zuordnung (gleiche Verordnung bzw. gleiche Versichertennummer + Ausstellungsdatum) – auch bei sonst fehlerhaften Zeilen
    const schluessel = r.verordnungId.trim() ? `id:${r.verordnungId.trim().toLowerCase()}` : `vnr:${normalizeId(r.versichertennummer)}|${datumAus(r.ausstellungsdatum) ?? r.ausstellungsdatum.trim()}`;
    if (schluessel !== "vnr:|") {
      const vorher = gesehen.get(schluessel);
      if (vorher !== undefined) fehler.push(`${praefix}: Verordnung mehrfach in der Datei (zuerst ${format === "json" ? "Position" : "Zeile"} ${vorher})`);
      else gesehen.set(schluessel, r.zeile);
    }
    const z = pruefeZeile(r, praefix, heute, fehler);
    if (z) ok.push(z);
  }
  // eine Auszahlung je Datei: gleiches Datum und gleiche Sammelrechnungsnummer in allen Zeilen
  const daten = new Set(roh.map((r) => datumAus(r.auszahlungsdatum) ?? r.auszahlungsdatum.trim()));
  const nummern = new Set(roh.map((r) => text(r.sammelrechnungsnummer, 60)));
  if (daten.size > 1 || nummern.size > 1) fehler.push("Unterschiedliche Auszahlungsdaten oder Sammelrechnungsnummern – bitte eine Auszahlung je Datei einlesen.");
  if (fehler.length) {
    const gekuerzt = fehler.length > MAX_FEHLER ? [...fehler.slice(0, MAX_FEHLER), `… und ${fehler.length - MAX_FEHLER} weitere Fehler`] : fehler;
    return leer(sha256, groesse, gekuerzt, format);
  }
  const erste = roh[0];
  return {
    format,
    sha256,
    groesse,
    auszahlungsdatum: datumAus(erste.auszahlungsdatum),
    sammelrechnungsnummer: text(erste.sammelrechnungsnummer, 60) || null,
    zeilen: ok,
    fehler: [],
  };
}
