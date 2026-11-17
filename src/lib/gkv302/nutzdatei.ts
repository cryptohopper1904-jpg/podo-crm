/**
 * Erzeugung einer Nutzdatendatei (UNB … UNZ) mit SLGA und SLLA:B (Heilmittel) nach TA1 V21/V22.
 *
 * Dateistruktur Rechnungsart 1/2 (TA1 5.3.2/5.3.3, S. 15–17):
 *   UNB
 *   je Leistungserbringer (nur RA 2 mehrere): je Kostenträger:
 *     [Sammelrechnungs-SLGA]            (optional)
 *     je IK der Krankenkasse: SLGA (Gesamtrechnung) + SLLA
 *   UNZ
 * SLLA:B Segmentfolge (TA1 5.5.3.1/5.5.3.3, S. 39–75):
 *   FKT REC { INV [URI] NAD [EVO] { EHE [TXT] [MWS] } ZHE { DIA } [SKZ] (BES | GZF) }
 * Rechnungsart 3 (Abrechnungsstelle mit Inkassovollmacht) und das Imageverfahren (IMG) sind nicht umgesetzt.
 */
import { baueSegment, centZuText, type ElementWert, type SegmentSpez, alsLatin1, unzulaessigesZeichen } from "./edifact";
import { type Gkv302Fehler, Gkv302ValidierungsFehler } from "./fehler";
import { fallBetraege, type FallBetraege } from "./betraege";
import { istGueltigesIk } from "./ik";
import { logischerDateiname } from "./dateiname";
import {
  istGueltigesTarifkennzeichen,
  SAMMELGRUPPE_HEILMITTEL,
  summenstatusAus,
  TESTINDIKATOR,
  type Summenstatus,
} from "./schluessel";
import * as S from "./segmente";
import type { Abrechnungsfall, Gesamtrechnung, IsoDatum, Nutzdatendatei, Praxis, TaVersion } from "./typen";

/** Pauschaler Zuzahlungsbetrag laut TA1 5.5.3.3 BES: „10,00 Euro, jedoch höchstens …“ */
export const ZUZAHLUNG_PAUSCHALE_CENT = 1000;

/**
 * Gültigkeit der Nachrichtenversionen SLGA/SLLA, geprüft gegen das Erstelldatum im UNB:
 * TA1 V22 Deckblatt („Anzuwenden ab: 01.02.2027 / Version 21 verliert Gültigkeit: 30.04.2027“) und Kap. 5.5.1, S. 29
 * (Tabelle: SLGA/SLLA 21 01.10.2025–30.04.2027, 22 ab 01.02.2027).
 */
export const TA_GUELTIGKEIT: Record<TaVersion, { ab: IsoDatum; bis?: IsoDatum }> = {
  "21": { ab: "2025-10-01", bis: "2027-04-30" },
  "22": { ab: "2027-02-01" },
};

function deDatum(iso: IsoDatum): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

// ───────────────────────── Hilfen ─────────────────────────

function datumGueltig(iso: string, nullenErlaubt = false): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [j, mo, t] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (nullenErlaubt && mo === 0 && t === 0) return true;
  if (nullenErlaubt && t === 0 && mo >= 1 && mo <= 12) return true;
  const d = new Date(Date.UTC(j, mo - 1, t));
  return d.getUTCFullYear() === j && d.getUTCMonth() === mo - 1 && d.getUTCDate() === t;
}

/** "JJJJ-MM-TT" → "JJJJMMTT" */
export function edDatum(iso: IsoDatum): string {
  return iso.replace(/-/g, "");
}

/**
 * Versichertenstatus für INV (TA1 S. 46): alle lesbaren Zeichen nacheinander, auf 5 Stellen mit Nullen ergänzt
 * (Beispiel „10000“); bei 7-stelliger Bedruckung die Stellen 1–5 („1000100“ → „10001“).
 */
export function statusFuerInv(status: string | undefined): string | undefined {
  if (!status) return undefined;
  const zeichen = status.replace(/\s/g, "");
  if (!zeichen) return undefined;
  return zeichen.slice(0, 5).padEnd(5, "0");
}

/** Rechnungsnummer: Buchstaben/Ziffern, „-“ und „/“ nur als einzelne Gliederungszeichen innen (TA1 S. 33) */
export function pruefeRechnungsnummer(nr: string): string | null {
  if (!nr) return "Rechnungsnummer fehlt.";
  if (!/^[A-Za-z0-9/-]+$/.test(nr)) return `Rechnungsnummer „${nr}“ enthält unzulässige Zeichen (erlaubt: Buchstaben, Ziffern, „-“ und „/“).`;
  if (/^[-/]|[-/]$/.test(nr)) return `Rechnungsnummer „${nr}“ darf nicht mit „-“ oder „/“ beginnen oder enden.`;
  if (/[-/]{2}/.test(nr)) return `Rechnungsnummer „${nr}“ enthält aufeinanderfolgende Gliederungszeichen.`;
  return null;
}

function leitsymptomatikWert(fall: Abrechnungsfall): string {
  const l = fall.verordnung.leitsymptomatik;
  if (l.art === "ausserhalbHeilmRl") return "9999";
  return [l.a, l.b, l.c, l.patientenindividuell].map((x) => (x ? "1" : "0")).join("");
}

// ───────────────────────── Ergebnis ─────────────────────────

export interface GesamtrechnungErgebnis {
  leistungserbringerIk: string;
  kostentraegerIk: string;
  kasseIk: string;
  sammelRechnungsnummer: string;
  einzelRechnungsnummer: string;
  rechnungsdatum: IsoDatum;
  verarbeitungskennzeichen: string;
  /** GES-Werte je Summenstatus, 00 zuerst */
  summen: { status: Summenstatus; rechnungsbetragCent: number; bruttoCent: number; zuzahlungCent: number }[];
  faelle: { belegnummer: string; betraege: FallBetraege }[];
}

export interface NutzdateiErgebnis {
  /** Inhalt als Text (für Anzeige/Tests) */
  text: string;
  /** Inhalt in ISO 8859-1 (UNOC) – das ist die zu verschlüsselnde Nutzdatei */
  bytes: Uint8Array;
  logischerDateiname: string;
  anzahlNachrichten: number;
  gesamtrechnungen: GesamtrechnungErgebnis[];
}

// ───────────────────────── fachliche Prüfung (Prüfstufe 3, Kombinationen) ─────────────────────────

function pruefeIk(ik: string, pfad: string, name: string, fehler: Gkv302Fehler[]) {
  if (!/^\d{9}$/.test(ik ?? "")) fehler.push({ art: "format", pfad, meldung: `${name} muss aus 9 Ziffern bestehen, erhalten: „${ik ?? ""}“.` });
  else if (!istGueltigesIk(ik)) fehler.push({ art: "pruefziffer", pfad, meldung: `${name} „${ik}“ hat eine ungültige Prüfziffer.` });
}

function pruefeDatum(d: string | undefined, pfad: string, name: string, fehler: Gkv302Fehler[], nullenErlaubt = false) {
  if (!d) fehler.push({ art: "pflichtfeld", pfad, meldung: `${name} fehlt.` });
  else if (!datumGueltig(d, nullenErlaubt)) fehler.push({ art: "format", pfad, meldung: `${name} „${d}“ ist kein gültiges Datum (Format JJJJ-MM-TT).` });
}

function pruefePraxis(p: Praxis, pfad: string, fehler: Gkv302Fehler[]) {
  pruefeIk(p.ik, `${pfad}.ik`, "IK der Praxis", fehler);
  if (p.abrechnungscode !== "71" && p.abrechnungscode !== "72") {
    fehler.push({ art: "schluessel", pfad: `${pfad}.abrechnungscode`, meldung: `Abrechnungscode „${p.abrechnungscode}“ ist für Podologie nicht zulässig (71 Podologen, 72 Med. Fußpfleger).` });
  }
  if (!istGueltigesTarifkennzeichen(p.tarifkennzeichen ?? "")) {
    fehler.push({ art: "schluessel", pfad: `${pfad}.tarifkennzeichen`, meldung: `Tarifkennzeichen „${p.tarifkennzeichen ?? ""}“ ist ungültig (5 Stellen: Tarifbereich laut Anlage 3 8.1.5.2 + Sondertarif, Buchstaben nur groß).` });
  }
  if (p.email && /[^\x20-\x7e]/.test(p.email)) {
    fehler.push({ art: "zeichensatz", pfad: `${pfad}.email`, meldung: "E-Mail-Adresse (NAM Name 4) darf keine Umlaute enthalten." });
  }
  if (!p.anschrift?.strasse || !p.anschrift?.plz || !p.anschrift?.ort) {
    fehler.push({ art: "pflichtfeld", pfad: `${pfad}.anschrift`, meldung: "Anschrift der Praxis fehlt (für den Begleitzettel nach Anlage 4)." });
  }
}

interface FallKontext {
  vkz: string;
  praxis: Praxis;
  zuzahlungProzent: number;
  pauschaleCent: number;
}

function pruefeFall(fall: Abrechnungsfall, k: FallKontext, pfad: string, fehler: Gkv302Fehler[]) {
  const vkz = k.vkz;
  const v = fall.verordnung;
  const vers = fall.versicherter;
  if (!fall.leistungen?.length) fehler.push({ art: "pflichtfeld", pfad: `${pfad}.leistungen`, meldung: "Mindestens eine Abrechnungsposition (EHE) ist nötig." });
  if (!v.diagnosen?.length) fehler.push({ art: "pflichtfeld", pfad: `${pfad}.verordnung.diagnosen`, meldung: "Mindestens eine Diagnose (DIA) ist nötig." });
  v.diagnosen?.forEach((d, i) => {
    if (!d.icd10 && !d.text) fehler.push({ art: "pflichtfeld", pfad: `${pfad}.verordnung.diagnosen[${i}]`, meldung: "Diagnose braucht einen ICD-10-Code oder, wenn keiner auf der Verordnung steht, den Diagnosetext." });
  });
  pruefeDatum(v.verordnungsdatum, `${pfad}.verordnung.verordnungsdatum`, "Verordnungsdatum", fehler);
  pruefeDatum(vers.geburtsdatum, `${pfad}.versicherter.geburtsdatum`, "Geburtsdatum", fehler, true);
  // Anschrift zwingend, wenn Versichertennummer/-status unbekannt (TA1 S. 47/48)
  if (!vers.versichertennummer || !vers.versichertenstatus) {
    const ausland = !!vers.laenderkennzeichen;
    if (!vers.strasse || !vers.ort || (!ausland && !vers.plz)) {
      fehler.push({ art: "kombination", pfad: `${pfad}.versicherter`, meldung: "Ohne Versichertennummer und -status ist die Anschrift (Straße, PLZ, Ort; im Ausland Länderkennzeichen) zwingend." });
    }
  }
  if (vers.plz && !vers.laenderkennzeichen && !/^\d{5}$/.test(vers.plz)) {
    fehler.push({ art: "format", pfad: `${pfad}.versicherter.plz`, meldung: `Inlands-PLZ muss 5-stellig sein, erhalten: „${vers.plz}“.` });
  }
  for (const [feld, wert] of [["betriebsstaettennummer", v.betriebsstaettennummer], ["lanr", v.lanr]] as const) {
    if (wert !== undefined && !/^\d+$/.test(wert)) {
      fehler.push({ art: "format", pfad: `${pfad}.verordnung.${feld}`, meldung: `${feld === "lanr" ? "Lebenslange Arztnummer" : "Betriebsstättennummer"}: nur Ziffern 0–9 zulässig.` });
    }
  }
  if (v.diagnosegruppe !== undefined && !/^[A-Za-z0-9]+$/.test(v.diagnosegruppe)) {
    fehler.push({ art: "format", pfad: `${pfad}.verordnung.diagnosegruppe`, meldung: "Diagnosegruppe: nur Ziffern und Buchstaben ohne Umlaute, keine Leer- oder Sonderzeichen." });
  }
  const ls = leitsymptomatikWert(fall);
  if ((ls[3] === "1" || ls === "0000") && !v.leitsymptomatikText) {
    fehler.push({ art: "kombination", pfad: `${pfad}.verordnung.leitsymptomatikText`, meldung: "Patientenindividuelle Leitsymptomatik als Text ist zwingend, wenn sie angekreuzt ist oder keine Leitsymptomatik angekreuzt wurde (0000)." });
  }
  if (v.therapiefrequenz !== 0) {
    fehler.push({ art: "kombination", pfad: `${pfad}.verordnung.therapiefrequenz`, meldung: "Bei Podologie ist als Therapiefrequenz „0“ anzugeben (TA1 5.5.3.3 ZHE)." });
  }
  if (v.genehmigung) pruefeDatum(v.genehmigung.datum, `${pfad}.verordnung.genehmigung.datum`, "Datum der Genehmigung", fehler);
  // Korrekturverfahren
  if (vkz === "01" && fall.urspruenglich) fehler.push({ art: "kombination", pfad: `${pfad}.urspruenglich`, meldung: "Angaben zur ursprünglichen Rechnung (URI) nur im Korrekturverfahren (Verarbeitungskennzeichen ≠ 01)." });
  if (vkz !== "01" && !fall.urspruenglich) fehler.push({ art: "pflichtfeld", pfad: `${pfad}.urspruenglich`, meldung: "Im Korrekturverfahren sind die Angaben zur ursprünglichen Rechnung (URI) Pflicht." });
  if (fall.urspruenglich) {
    pruefeIk(fall.urspruenglich.ikLeistungserbringer, `${pfad}.urspruenglich.ikLeistungserbringer`, "Ursprüngliches IK des Leistungserbringers", fehler);
    pruefeDatum(fall.urspruenglich.rechnungsdatum, `${pfad}.urspruenglich.rechnungsdatum`, "Ursprüngliches Rechnungsdatum", fehler);
  }
  if (fall.pauschalerKorrekturabzugCent !== undefined && vkz !== "04") {
    fehler.push({ art: "kombination", pfad: `${pfad}.pauschalerKorrekturabzugCent`, meldung: "Pauschaler Korrekturabzug nur bei Verarbeitungskennzeichen 04." });
  }
  // Zuzahlung
  const zk = fall.zuzahlungskennzeichen;
  if (vkz === "03") {
    // TA1 V21 7.4.2.1–7.4.2.4 (S. 167–168): VKZ 03 nur mit Grund 1 (Befreiung nachträglich), 2 (Zahlung verweigert)
    // oder 5 (Übergang zuzahlungsfrei → zuzahlungspflichtig)
    if (!["1", "2", "5"].includes(zk)) {
      fehler.push({ art: "kombination", pfad: `${pfad}.zuzahlungskennzeichen`, meldung: `Bei Verarbeitungskennzeichen 03 (Zuzahlungsforderung) ist als Zuzahlungskennzeichen nur 1, 2 oder 5 zulässig, erhalten: „${zk}“ (TA1 Kap. 7.4.2).` });
    }
    // § 43c SGB V: Nachweis über den erfolglosen Einzugsversuch parallel zum Datensatz (TA1 V21 7.4.2.1, S. 167)
    if ((zk === "2" || zk === "5") && !fall.nachweisErfolgloserEinzug?.referenz) {
      fehler.push({ art: "pflichtfeld", pfad: `${pfad}.nachweisErfolgloserEinzug`, meldung: "Zuzahlungsforderung nach § 43c SGB V: Nachweis über den erfolglosen Einzugsversuch (Referenz auf das Dokument) fehlt (TA1 Kap. 7.4.2.1)." });
    }
    if (fall.nachweisErfolgloserEinzug) pruefeDatum(fall.nachweisErfolgloserEinzug.datum, `${pfad}.nachweisErfolgloserEinzug.datum`, "Datum des Nachweises", fehler);
  } else if (fall.nachweisErfolgloserEinzug) {
    fehler.push({ art: "kombination", pfad: `${pfad}.nachweisErfolgloserEinzug`, meldung: "Nachweis über den erfolglosen Einzug nur bei Verarbeitungskennzeichen 03." });
  }
  if (vkz !== "03" && ["2", "4", "5"].includes(zk)) {
    if (fall.pauschaleZuzahlung === undefined) fehler.push({ art: "pflichtfeld", pfad: `${pfad}.pauschaleZuzahlung`, meldung: `Bei Zuzahlungskennzeichen ${zk} muss angegeben werden, ob die Pauschale je Verordnung anfällt.` });
    fall.leistungen?.forEach((l, i) => {
      if (l.zuzahlungspflichtig === undefined) fehler.push({ art: "pflichtfeld", pfad: `${pfad}.leistungen[${i}].zuzahlungspflichtig`, meldung: `Bei Zuzahlungskennzeichen ${zk} muss je Position angegeben werden, ob Zuzahlung anfällt.` });
    });
  }
  if (vkz === "03" && fall.leistungen?.length) {
    const b = fallBetraege(fall, k.zuzahlungProzent, k.pauschaleCent, vkz);
    if (b.gesetzlicheZuzahlungCent <= 0) fehler.push({ art: "kombination", pfad: `${pfad}`, meldung: "Zuzahlungsforderung (VKZ 03): die geforderte Zuzahlung muss größer 0 sein." });
  }
  // Mehrwertsteuer (TA1 V21 5.5.3.3 MWS, S. 56): nur bei vertraglich vereinbarter MwSt
  fall.leistungen?.forEach((l, i) => {
    if (l.mehrwertsteuerProzent === undefined) return;
    if (k.praxis.umsatzsteuer?.befreit) {
      fehler.push({ art: "kombination", pfad: `${pfad}.leistungen[${i}].mehrwertsteuerProzent`, meldung: "Die Praxis ist als umsatzsteuerbefreit gekennzeichnet (UST „J“); ein MWS-Segment ist dann unzulässig." });
    } else if (!k.praxis.mehrwertsteuerVereinbart) {
      fehler.push({ art: "kombination", pfad: `${pfad}.leistungen[${i}].mehrwertsteuerProzent`, meldung: "MWS nur, wenn für die Position Mehrwertsteuer vertraglich vereinbart ist; bei Podologie (71/72) dafür „mehrwertsteuerVereinbart“ an der Praxis setzen." });
    }
  });
  // Positionen
  const gesehen = new Set<string>();
  fall.leistungen?.forEach((l, i) => {
    const lp = `${pfad}.leistungen[${i}]`;
    if (!/^.{5}$/.test(l.positionsnummer ?? "")) fehler.push({ art: "laenge", pfad: `${lp}.positionsnummer`, meldung: `Abrechnungspositionsnummer muss 5-stellig sein, erhalten: „${l.positionsnummer ?? ""}“.` });
    pruefeDatum(l.datum, `${lp}.datum`, "Datum der Leistungserbringung", fehler);
    if (!(l.anzahl > 0) || Math.abs(l.anzahl * 100 - Math.round(l.anzahl * 100)) > 1e-9) fehler.push({ art: "format", pfad: `${lp}.anzahl`, meldung: "Anzahl muss größer 0 sein und höchstens 2 Nachkommastellen haben." });
    if (!Number.isInteger(l.einzelpreisCent) || l.einzelpreisCent < 0) fehler.push({ art: "format", pfad: `${lp}.einzelpreisCent`, meldung: "Einzelpreis muss ein nicht negativer ganzzahliger Cent-Betrag sein." });
    if (l.gefahreneKilometer !== undefined && (!Number.isInteger(l.gefahreneKilometer) || l.gefahreneKilometer < 0)) fehler.push({ art: "format", pfad: `${lp}.gefahreneKilometer`, meldung: "Gefahrene Kilometer müssen eine ganze Zahl ≥ 0 sein." });
    const schluessel = `${l.positionsnummer}|${l.datum}`;
    if (gesehen.has(schluessel)) {
      fehler.push({ art: "kombination", pfad: lp, meldung: `Position ${l.positionsnummer} am ${l.datum} doppelt: gleiche Positionen am selben Tag sind in einem EHE-Segment zusammenzufassen.` });
    }
    gesehen.add(schluessel);
  });
}

/** Prüft das Eingabemodell vollständig (ohne Segmentbau). Liefert alle Fehler. */
export function pruefeNutzdatendatei(d: Nutzdatendatei): Gkv302Fehler[] {
  const fehler: Gkv302Fehler[] = [];
  if (d.taVersion !== "21" && d.taVersion !== "22") fehler.push({ art: "schluessel", pfad: "taVersion", meldung: `TA-Version „${d.taVersion}“ wird nicht unterstützt (21 oder 22).` });
  pruefeIk(d.absender?.ik, "absender.ik", "IK des Absenders", fehler);
  pruefeIk(d.empfaengerIk, "empfaengerIk", "IK der Datenannahmestelle", fehler);
  pruefeDatum(d.erstellt?.datum, "erstellt.datum", "Erstelldatum", fehler);
  const gueltig = TA_GUELTIGKEIT[d.taVersion];
  if (gueltig && d.erstellt?.datum && datumGueltig(d.erstellt.datum)) {
    if (d.erstellt.datum < gueltig.ab) fehler.push({ art: "kombination", pfad: "taVersion", meldung: `TA-Version ${d.taVersion} gilt erst ab ${deDatum(gueltig.ab)}; Erstelldatum ist ${deDatum(d.erstellt.datum)}.` });
    if (gueltig.bis && d.erstellt.datum > gueltig.bis) fehler.push({ art: "kombination", pfad: "taVersion", meldung: `TA-Version ${d.taVersion} gilt nur bis ${deDatum(gueltig.bis)}; Erstelldatum ist ${deDatum(d.erstellt.datum)}.` });
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.erstellt?.uhrzeit ?? "")) fehler.push({ art: "format", pfad: "erstellt.uhrzeit", meldung: "Uhrzeit im Format HH:MM erwartet." });
  if (!Number.isInteger(d.datenaustauschreferenz) || d.datenaustauschreferenz < 1 || d.datenaustauschreferenz > 99999) fehler.push({ art: "format", pfad: "datenaustauschreferenz", meldung: "Datenaustauschreferenz muss zwischen 1 und 99999 liegen." });
  if (!Number.isInteger(d.abrechnungsmonat) || d.abrechnungsmonat < 1 || d.abrechnungsmonat > 12) fehler.push({ art: "format", pfad: "abrechnungsmonat", meldung: "Abrechnungsmonat muss zwischen 1 und 12 liegen." });
  if (!(d.dateiart in TESTINDIKATOR)) fehler.push({ art: "schluessel", pfad: "dateiart", meldung: "Dateiart muss test, erprobung oder echt sein." });
  if (d.rechnungsart !== "1" && d.rechnungsart !== "2") fehler.push({ art: "schluessel", pfad: "rechnungsart", meldung: `Rechnungsart „${d.rechnungsart}“ wird nicht unterstützt (1 oder 2; 3 = Inkasso ist nicht umgesetzt).` });
  if (!(d.zuzahlungProzent >= 0 && d.zuzahlungProzent <= 100)) fehler.push({ art: "format", pfad: "zuzahlungProzent", meldung: "Zuzahlungsprozentsatz muss zwischen 0 und 100 liegen." });
  if (d.absender?.art === "A" && (!d.absender.name || !d.absender.anschrift)) fehler.push({ art: "pflichtfeld", pfad: "absender", meldung: "Abrechnungsstelle: Name und Anschrift sind für den Begleitzettel (Anlage 4) nötig." });
  if (!d.leistungserbringer?.length) fehler.push({ art: "pflichtfeld", pfad: "leistungserbringer", meldung: "Die Datei enthält keine Abrechnung." });
  if (d.rechnungsart === "1") {
    if (d.leistungserbringer?.length !== 1) fehler.push({ art: "kombination", pfad: "leistungserbringer", meldung: "Rechnungsart 1: genau ein Leistungserbringer je Datei." });
    else if (d.leistungserbringer[0].praxis.ik !== d.absender.ik) fehler.push({ art: "kombination", pfad: "absender.ik", meldung: "Rechnungsart 1: IK des Absenders muss das IK des Leistungserbringers sein (sonst Rechnungsart 2)." });
    if (d.absender?.art !== "S") fehler.push({ art: "kombination", pfad: "absender.art", meldung: "Rechnungsart 1: der Leistungserbringer rechnet selbst ab, Dateiidentifizierer „S“." });
  }
  // Je Verarbeitungskennzeichen eine eigene Datei (TA1 V21 Kap. 7.3, S. 166)
  const alleRechnungen = d.leistungserbringer?.flatMap((le) => le.kostentraeger?.flatMap((kt) => kt.rechnungen ?? []) ?? []) ?? [];
  const vkzInDatei = new Set(alleRechnungen.map((r) => r.verarbeitungskennzeichen));
  if (vkzInDatei.size > 1) fehler.push({ art: "kombination", pfad: "verarbeitungskennzeichen", meldung: `Innerhalb einer Datei ist nur ein Verarbeitungskennzeichen zulässig, enthalten: ${[...vkzInDatei].sort().join(", ")}. Je Verarbeitungskennzeichen ist eine eigene Datei zu übermitteln (TA1 Kap. 7.3).` });
  // Kein Mischen von Einzel- und Sammelrechnungen in einer Datei (TA1 V21 5.3.2, S. 15; 5.3.3, S. 16)
  const alleKt = d.leistungserbringer?.flatMap((le) => le.kostentraeger ?? []) ?? [];
  const mitSammel = alleKt.filter((kt) => kt.sammelrechnung).length;
  if (mitSammel > 0 && mitSammel < alleKt.length) fehler.push({ art: "kombination", pfad: "leistungserbringer", meldung: "Das Mischen von Einzel- und Sammelrechnungen in einer Datei ist nicht zulässig (TA1 Kap. 5.3.2/5.3.3): entweder alle Kostenträger mit Sammelrechnung oder keiner." });
  const pauschaleCent = d.zuzahlungPauschaleCent ?? ZUZAHLUNG_PAUSCHALE_CENT;
  d.leistungserbringer?.forEach((le, i) => {
    const lp = `leistungserbringer[${i}]`;
    // Rechnungsnummern je Leistungserbringer eindeutig (Sammel:Einzel bzw. Rechnungsnummer:0), auch über Kostenträger
    const nummern = new Map<string, string>();
    pruefePraxis(le.praxis, `${lp}.praxis`, fehler);
    if (!le.kostentraeger?.length) fehler.push({ art: "pflichtfeld", pfad: `${lp}.kostentraeger`, meldung: "Keine Rechnung für diesen Leistungserbringer." });
    le.kostentraeger?.forEach((kt, j) => {
      const kp = `${lp}.kostentraeger[${j}]`;
      pruefeIk(kt.kostentraegerIk, `${kp}.kostentraegerIk`, "IK des Kostenträgers", fehler);
      if (kt.sammelrechnung) {
        const e = pruefeRechnungsnummer(kt.sammelrechnung.rechnungsnummer);
        if (e) fehler.push({ art: "format", pfad: `${kp}.sammelrechnung.rechnungsnummer`, meldung: e });
        pruefeDatum(kt.sammelrechnung.rechnungsdatum, `${kp}.sammelrechnung.rechnungsdatum`, "Rechnungsdatum der Sammelrechnung", fehler);
        // die Sammelrechnungs-SLGA belegt „Sammelnummer:0“ – damit ist auch Einzelnummer „0“ ausgeschlossen
        const sammelKey = `${kt.sammelrechnung.rechnungsnummer}:0`;
        if (nummern.has(sammelKey)) fehler.push({ art: "kombination", pfad: `${kp}.sammelrechnung.rechnungsnummer`, meldung: `Sammel-Rechnungsnummer „${kt.sammelrechnung.rechnungsnummer}“ ist mehrfach vergeben; sie muss je Rechnung eindeutig sein.` });
        nummern.set(sammelKey, kp);
      }
      if (!kt.rechnungen?.length) fehler.push({ art: "pflichtfeld", pfad: `${kp}.rechnungen`, meldung: "Keine Gesamtrechnung für diesen Kostenträger." });
      const kassen = new Set<string>();
      kt.rechnungen?.forEach((r, k) => {
        const rp = `${kp}.rechnungen[${k}]`;
        pruefeIk(r.kasseIk, `${rp}.kasseIk`, "IK der Krankenkasse", fehler);
        if (kassen.has(r.kasseIk)) fehler.push({ art: "kombination", pfad: `${rp}.kasseIk`, meldung: "Je IK der Krankenkasse ist eine Gesamtrechnung zu bilden (doppelt)." });
        kassen.add(r.kasseIk);
        const e = pruefeRechnungsnummer(r.rechnungsnummer);
        if (e) fehler.push({ art: "format", pfad: `${rp}.rechnungsnummer`, meldung: e });
        // B8: doppelte Nummern auch innerhalb einer Sammelrechnung (Einzel-Rechnungsnummern) erkennen
        const voll = kt.sammelrechnung ? `${kt.sammelrechnung.rechnungsnummer}:${r.rechnungsnummer}` : `${r.rechnungsnummer}:0`;
        if (nummern.has(voll)) {
          fehler.push({ art: "kombination", pfad: `${rp}.rechnungsnummer`, meldung: kt.sammelrechnung ? `Einzel-Rechnungsnummer „${r.rechnungsnummer}“ ist in der Sammelrechnung „${kt.sammelrechnung.rechnungsnummer}“ mehrfach vergeben; sie muss je Rechnung eindeutig sein.` : `Rechnungsnummer „${r.rechnungsnummer}“ ist mehrfach vergeben; sie muss je Rechnung eindeutig sein.` });
        }
        nummern.set(voll, rp);
        pruefeDatum(r.rechnungsdatum, `${rp}.rechnungsdatum`, "Rechnungsdatum", fehler);
        if (r.verarbeitungskennzeichen === ("10" as string)) fehler.push({ art: "schluessel", pfad: `${rp}.verarbeitungskennzeichen`, meldung: "Verarbeitungskennzeichen 10 ist laut TA1 Kap. 7.1 nur für Physiotherapie zulässig." });
        if (!r.faelle?.length) fehler.push({ art: "pflichtfeld", pfad: `${rp}.faelle`, meldung: "Die Gesamtrechnung enthält keinen Abrechnungsfall." });
        const belege = new Set<string>();
        r.faelle?.forEach((f, l) => {
          const fp = `${rp}.faelle[${l}]`;
          if (belege.has(f.belegnummer)) fehler.push({ art: "kombination", pfad: `${fp}.belegnummer`, meldung: `Belegnummer „${f.belegnummer}“ ist in der Gesamtrechnung nicht eindeutig.` });
          belege.add(f.belegnummer);
          pruefeFall(f, { vkz: r.verarbeitungskennzeichen, praxis: le.praxis, zuzahlungProzent: d.zuzahlungProzent, pauschaleCent }, fp, fehler);
        });
      });
    });
  });
  return fehler;
}

// ───────────────────────── Erzeugung ─────────────────────────

class Schreiber {
  segmente: string[] = [];
  fehler: Gkv302Fehler[] = [];
  nachrichten = 0;
  private start = 0;
  constructor(private version: string) {}
  seg(spez: SegmentSpez, werte: ElementWert[], ort: string) {
    this.segmente.push(baueSegment(spez, werte, ort, this.fehler));
  }
  beginne(typ: "SLGA" | "SLLA", ort: string) {
    this.nachrichten++;
    this.start = this.segmente.length;
    this.seg(S.unhSpez(this.version), [this.ref(), [typ, this.version, "0", "0"]], ort);
  }
  beende(ort: string) {
    const anzahl = this.segmente.length - this.start + 1;
    this.seg(S.UNT, [String(anzahl).padStart(6, "0"), this.ref()], ort);
  }
  private ref() {
    return String(this.nachrichten).padStart(5, "0");
  }
}

interface Summe {
  rechnungsbetragCent: number;
  bruttoCent: number;
  zuzahlungCent: number;
}

/** GES-Beiträge eines Falls (TA1 5.5.2 S. 36–37) */
function gesBeitrag(vkz: string, b: FallBetraege): Summe {
  if (vkz === "03") {
    return { rechnungsbetragCent: b.gesetzlicheZuzahlungCent, bruttoCent: 0, zuzahlungCent: b.gesetzlicheZuzahlungCent };
  }
  const zuzahlung = b.gesetzlicheZuzahlungCent + (vkz === "04" ? b.korrekturabzugCent : 0);
  return { rechnungsbetragCent: b.bruttoCent - zuzahlung, bruttoCent: b.bruttoCent, zuzahlungCent: zuzahlung };
}

function addiere(a: Summe, b: Summe): Summe {
  return { rechnungsbetragCent: a.rechnungsbetragCent + b.rechnungsbetragCent, bruttoCent: a.bruttoCent + b.bruttoCent, zuzahlungCent: a.zuzahlungCent + b.zuzahlungCent };
}

const NULL_SUMME: Summe = { rechnungsbetragCent: 0, bruttoCent: 0, zuzahlungCent: 0 };
const STATUS_REIHENFOLGE: Summenstatus[] = ["11", "31", "51", "99"];

function gesSegmente(w: Schreiber, summen: Map<Summenstatus, Summe>, ort: string) {
  for (const [status, s] of [...summen.entries()].sort((a, b) => (a[0] === "00" ? -1 : b[0] === "00" ? 1 : STATUS_REIHENFOLGE.indexOf(a[0]) - STATUS_REIHENFOLGE.indexOf(b[0])))) {
    w.seg(S.GES, [status, centZuText(s.rechnungsbetragCent), centZuText(s.bruttoCent), centZuText(s.zuzahlungCent)], ort);
  }
}

function namWerte(p: Praxis): ElementWert[] {
  return [p.name, p.ansprechpartner, p.telefon, p.email];
}

function schreibeFall(w: Schreiber, praxis: Praxis, r: Gesamtrechnung, fall: Abrechnungsfall, b: FallBetraege, ort: string) {
  const vers = fall.versicherter;
  const v = fall.verordnung;
  w.seg(S.INV, [vers.versichertennummer, statusFuerInv(vers.versichertenstatus), fall.beleginformation, fall.belegnummer, fall.besondereVersorgungsform], ort);
  if (fall.urspruenglich) {
    const u = fall.urspruenglich;
    w.seg(S.URI, [u.ikLeistungserbringer, [u.sammelRechnungsnummer, u.einzelRechnungsnummer], edDatum(u.rechnungsdatum), u.belegnummer], ort);
  }
  w.seg(S.NAD, [vers.nachname, vers.vorname, edDatum(vers.geburtsdatum), vers.strasse, vers.plz, vers.ort, vers.laenderkennzeichen], ort);
  if (fall.eVoId) w.seg(S.EVO, [fall.eVoId], ort);
  fall.leistungen.forEach((l, i) => {
    const p = b.positionen[i];
    const lort = `${ort}/Position ${i + 1}`;
    w.seg(S.EHE, [
      [praxis.abrechnungscode, praxis.tarifkennzeichen],
      l.positionsnummer,
      l.anzahl.toFixed(2).replace(".", ","),
      centZuText(l.einzelpreisCent),
      edDatum(l.datum),
      p.zuzahlungJeEinheitCent > 0 ? centZuText(p.zuzahlungJeEinheitCent) : undefined,
      l.gefahreneKilometer !== undefined ? String(l.gefahreneKilometer) : undefined,
    ], lort);
    if (l.text) w.seg(S.TXT, [l.text], lort);
    if (l.mehrwertsteuerProzent !== undefined) w.seg(S.MWS, [l.mehrwertsteuerProzent.toFixed(2).replace(".", ","), centZuText(p.mwstCent)], lort);
  });
  w.seg(S.ZHE, [
    v.betriebsstaettennummer || "999999999",
    v.lanr || "999999999",
    edDatum(v.verordnungsdatum),
    fall.zuzahlungskennzeichen,
    v.diagnosegruppe || "9999",
    v.verordnungsart,
    v.verordnungsbesonderheit,
    v.unfallkennzeichen,
    v.bvgSer ? "6" : undefined,
    undefined, // Behandlungsbeginn: Leerfeld
    v.therapieberichtAngefordert ? "1" : undefined,
    v.hausbesuch ? "1" : undefined,
    leitsymptomatikWert(fall),
    v.leitsymptomatikText,
    v.dringlicherBehandlungsbedarf ? "1" : "0",
    // Kann-Feld; bei Abrechnungscode 71/72 mit „2“ (Podologische Therapie) vorbelegt (TA1 V21 5.5.3.3 ZHE)
    v.heilmittelbereich ?? "2",
    String(v.therapiefrequenz),
  ], ort);
  for (const dia of v.diagnosen) w.seg(S.DIA, [dia.icd10, dia.text], ort);
  if (v.genehmigung) w.seg(S.SKZ, [v.genehmigung.kennzeichen, edDatum(v.genehmigung.datum), v.genehmigung.art], ort);
  const zuz = b.gesetzlicheZuzahlungCent > 0;
  if (r.verarbeitungskennzeichen === "03") {
    w.seg(S.GZF, [centZuText(b.gesetzlicheZuzahlungCent), zuz ? centZuText(b.prozentualeZuzahlungCent) : undefined, zuz ? centZuText(b.pauschaleZuzahlungCent) : undefined], ort);
  } else {
    w.seg(S.BES, [
      centZuText(b.bruttoCent),
      zuz ? centZuText(b.gesetzlicheZuzahlungCent) : undefined,
      zuz ? centZuText(b.prozentualeZuzahlungCent) : undefined,
      zuz ? centZuText(b.pauschaleZuzahlungCent) : undefined,
      r.verarbeitungskennzeichen === "04" && b.korrekturabzugCent > 0 ? centZuText(b.korrekturabzugCent) : undefined,
    ], ort);
  }
}

/**
 * Erzeugt die Nutzdatendatei. Wirft Gkv302ValidierungsFehler mit allen gefundenen Fehlern
 * (fachliche Prüfung + Feldprüfung je Segment), damit nie eine fehlerhafte Datei entsteht (TA1 Kap. 3 Abs. 3).
 */
export function erzeugeNutzdatendatei(d: Nutzdatendatei): NutzdateiErgebnis {
  const vorab = pruefeNutzdatendatei(d);
  if (vorab.length) throw new Gkv302ValidierungsFehler(vorab);

  const w = new Schreiber(d.taVersion);
  const pauschale = d.zuzahlungPauschaleCent ?? ZUZAHLUNG_PAUSCHALE_CENT;
  const logisch = logischerDateiname(d.absender.ik, d.absender.art, d.abrechnungsmonat);
  const dar = String(d.datenaustauschreferenz).padStart(5, "0");
  w.seg(S.UNB, [
    ["UNOC", "3"],
    d.absender.ik,
    d.empfaengerIk,
    [edDatum(d.erstellt.datum), d.erstellt.uhrzeit.replace(":", "")],
    dar,
    SAMMELGRUPPE_HEILMITTEL,
    logisch,
    TESTINDIKATOR[d.dateiart],
  ], "UNB");

  const gesamtrechnungen: GesamtrechnungErgebnis[] = [];

  d.leistungserbringer.forEach((le, i) => {
    const praxis = le.praxis;
    le.kostentraeger.forEach((kt, j) => {
      // Beträge vorab, damit die Sammelrechnung ihre Summen kennt
      const berechnet = kt.rechnungen.map((r) => ({
        r,
        faelle: r.faelle.map((f) => ({ f, b: fallBetraege(f, d.zuzahlungProzent, pauschale, r.verarbeitungskennzeichen) })),
      }));
      const sammel = kt.sammelrechnung;
      if (sammel) {
        const ort = `LE ${i + 1}/KT ${j + 1}/Sammelrechnung`;
        const vkz = kt.rechnungen[0].verarbeitungskennzeichen;
        const summen = new Map<Summenstatus, Summe>([["00", NULL_SUMME]]);
        for (const { r, faelle } of berechnet) {
          for (const { f, b } of faelle) {
            const s = gesBeitrag(r.verarbeitungskennzeichen, b);
            const st = summenstatusAus(f.versicherter.versichertenstatus);
            summen.set("00", addiere(summen.get("00")!, s));
            summen.set(st, addiere(summen.get(st) ?? NULL_SUMME, s));
          }
        }
        w.beginne("SLGA", ort);
        // IK der Krankenkasse bleibt in der Sammelrechnungs-SLGA leer (TA1 S. 32)
        w.seg(S.SLGA_FKT, [vkz, "J", praxis.ik, kt.kostentraegerIk, undefined, d.absender.ik], ort);
        // Auslegung: Einzel-Rechnungsnummer der Sammelrechnungs-SLGA = "0" (TA1 nennt keinen Wert)
        w.seg(S.REC, [[sammel.rechnungsnummer, "0"], edDatum(sammel.rechnungsdatum), d.rechnungsart], ort);
        for (const sko of praxis.skonto ?? []) w.seg(S.SKO, [sko.prozent.toFixed(2).replace(".", ","), String(sko.zahlungszielTage)], ort);
        gesSegmente(w, summen, ort);
        w.seg(S.NAM, namWerte(praxis), ort);
        w.beende(ort);
      }
      berechnet.forEach(({ r, faelle }) => {
        const ort = `LE ${i + 1}/KT ${j + 1}/Rechnung ${r.rechnungsnummer}`;
        const sammelNr = sammel ? sammel.rechnungsnummer : r.rechnungsnummer;
        const einzelNr = sammel ? r.rechnungsnummer : "0";
        const rec: ElementWert[] = [[sammelNr, einzelNr], edDatum(r.rechnungsdatum), d.rechnungsart];
        const summen = new Map<Summenstatus, Summe>([["00", NULL_SUMME]]);
        for (const { f, b } of faelle) {
          const s = gesBeitrag(r.verarbeitungskennzeichen, b);
          const st = summenstatusAus(f.versicherter.versichertenstatus);
          summen.set("00", addiere(summen.get("00")!, s));
          summen.set(st, addiere(summen.get(st) ?? NULL_SUMME, s));
        }
        // SLGA als Gesamtrechnung
        w.beginne("SLGA", `${ort}/SLGA`);
        w.seg(S.SLGA_FKT, [r.verarbeitungskennzeichen, undefined, praxis.ik, kt.kostentraegerIk, r.kasseIk, d.absender.ik], `${ort}/SLGA`);
        w.seg(S.REC, rec, `${ort}/SLGA`);
        if (praxis.umsatzsteuer) w.seg(S.UST, [praxis.umsatzsteuer.steuernummer, praxis.umsatzsteuer.befreit ? "J" : undefined], `${ort}/SLGA`);
        for (const sko of praxis.skonto ?? []) w.seg(S.SKO, [sko.prozent.toFixed(2).replace(".", ","), String(sko.zahlungszielTage)], `${ort}/SLGA`);
        gesSegmente(w, summen, `${ort}/SLGA`);
        w.seg(S.NAM, namWerte(praxis), `${ort}/SLGA`);
        w.beende(`${ort}/SLGA`);
        // SLLA
        w.beginne("SLLA", `${ort}/SLLA`);
        w.seg(S.SLLA_FKT, [r.verarbeitungskennzeichen, undefined, praxis.ik, kt.kostentraegerIk, r.kasseIk], `${ort}/SLLA`);
        w.seg(S.REC, rec, `${ort}/SLLA`);
        for (const { f, b } of faelle) schreibeFall(w, praxis, r, f, b, `${ort}/SLLA/Beleg ${f.belegnummer}`);
        w.beende(`${ort}/SLLA`);

        gesamtrechnungen.push({
          leistungserbringerIk: praxis.ik,
          kostentraegerIk: kt.kostentraegerIk,
          kasseIk: r.kasseIk,
          sammelRechnungsnummer: sammelNr,
          einzelRechnungsnummer: einzelNr,
          rechnungsdatum: r.rechnungsdatum,
          verarbeitungskennzeichen: r.verarbeitungskennzeichen,
          summen: [...summen.entries()].map(([status, s]) => ({ status, ...s })),
          faelle: faelle.map(({ f, b }) => ({ belegnummer: f.belegnummer, betraege: b })),
        });
      });
    });
  });

  w.seg(S.UNZ, [String(w.nachrichten).padStart(6, "0"), dar], "UNZ");
  if (w.fehler.length) throw new Gkv302ValidierungsFehler(w.fehler);

  const text = w.segmente.join(d.zeilenumbruch ? "\n" : "");
  const zeichen = unzulaessigesZeichen(text.replace(/\n/g, ""));
  if (zeichen !== null) throw new Gkv302ValidierungsFehler([{ art: "zeichensatz", pfad: "Datei", meldung: `Zeichen „${zeichen}“ ist in UNOC nicht darstellbar.` }]);
  return { text, bytes: alsLatin1(text), logischerDateiname: logisch, anzahlNachrichten: w.nachrichten, gesamtrechnungen };
}
