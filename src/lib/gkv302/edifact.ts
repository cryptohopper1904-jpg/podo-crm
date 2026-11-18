/**
 * EDIFACT-Grundlagen nach TA1 (Technische Anlage 1 zu § 302 SGB V), Kap. 5.1 und 5.2:
 *  - Steuerzeichen (5.1 Abs. 11, S. 12): ":" Gruppentrenner, "+" Datenelementtrenner, "," Dezimalzeichen,
 *    "?" Aufhebungszeichen, "'" Segmentende.
 *  - Aufhebung (S. 13): Doppelpunkt, Plus, Komma, Fragezeichen und Apostroph in Textinhalten erhalten ein "?" davor.
 *    Achtung: Die TA1 nennt ausdrücklich auch das Komma – abweichend von ISO 9735. Wir maskieren es deshalb in
 *    AN-Feldern; in numerischen Feldern ist das Komma das Dezimalzeichen und wird nicht maskiert.
 *  - Leere Kann-Felder (5.2 Abs. 3): Trennzeichen bleibt stehen, am Segmentende entfallen leere Felder.
 *  - Feldtypen/Feldarten (5.1 Abs. 8): AN/N, M/K; "5" = feste Länge, "..35" = Höchstlänge.
 *  - Beträge (5.1 Abs. 9/10): Minus und Komma zählen nicht zur Länge; Nachkommastellen immer vollständig.
 *
 * Zeichensatz: UNB Syntax "UNOC:3" (TA1 5.4, S. 20: „Groß- und Kleinbuchstaben, Umlaute“). Die TA1 nennt keine
 * Norm; UNOC entspricht nach ISO 9735 dem Zeichensatz ISO 8859-1 (Latin-1). Die Auftragsdatei (GGT Anlage 2)
 * verwendet ebenfalls ISO 8859-1 („I1“). Zulässig sind deshalb nur druckbare Latin-1-Zeichen.
 */
import type { Gkv302Fehler } from "./fehler";

export const TRENNER = { gruppe: ":", element: "+", dezimal: ",", aufhebung: "?", segmentende: "'" } as const;

/** Prüft, ob ein Zeichen in UNOC (ISO 8859-1, druckbar) darstellbar ist. */
function istUnocZeichen(code: number): boolean {
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff);
}

/** Liefert das erste nicht darstellbare Zeichen oder null. */
export function unzulaessigesZeichen(text: string): string | null {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (!istUnocZeichen(code)) return ch;
  }
  return null;
}

/** Maskiert die Steuerzeichen nach TA1 5.1 (inkl. Komma). */
export function maskiere(text: string): string {
  return text.replace(/[?:+,']/g, (c) => "?" + c);
}

/** Kodiert eine Zeichenkette in ISO 8859-1. Wirft, wenn ein Zeichen nicht darstellbar ist. */
export function alsLatin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) throw new Error(`Zeichen „${text[i]}“ ist in ISO 8859-1 nicht darstellbar.`);
    bytes[i] = code;
  }
  return bytes;
}

/** Dekodiert ISO 8859-1. */
export function ausLatin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// ───────────────────────── Feldbeschreibung ─────────────────────────

export type FeldTyp = "AN" | "N";
export type FeldArt = "M" | "K";

export interface FeldSpez {
  /** Feldbezeichnung wie in der TA (für Fehlermeldungen) */
  name: string;
  typ: FeldTyp;
  art: FeldArt;
  /** feste Länge (z. B. 9 für ein IK) */
  laenge?: number;
  /**
   * Höchstlänge (z. B. 35 für "..35"); bei Beträgen (dezimal gesetzt) die Zahl der Stellen insgesamt einschließlich
   * der Nachkommastellen ("..10,2" → höchstens 10 Ziffern, davon 2 nach dem Komma; Minus/Komma zählen nicht)
   */
  max?: number;
  /**
   * Einzige dokumentierte Ausnahme (SKO „..2,2“, Skonto z. B. 2,00 %): `max` zählt hier nur die Vorkommastellen,
   * weil „2 Stellen insgesamt“ nur 0,xx % zuließe. Erprobungsfrage, siehe docs/GKV-302.md „Auslegungen“.
   */
  maxNurVorkomma?: boolean;
  /** Mindestlänge (z. B. 22 bei EVO "22..256") */
  min?: number;
  /** Nachkommastellen bei Beträgen (z. B. 2 für "..10,2"); Wert wird dann als Zahl übergeben */
  dezimal?: number;
  /** zulässige Schlüsselwerte */
  schluessel?: readonly string[];
}

export interface GruppenSpez {
  name: string;
  art: FeldArt;
  teile: FeldSpez[];
}

export type ElementSpez = FeldSpez | GruppenSpez;
export interface SegmentSpez {
  kennung: string;
  elemente: ElementSpez[];
}

/** Wert eines Feldes: Text, Zahl (bei dezimal) oder leer. */
export type FeldWert = string | number | undefined | null;
export type ElementWert = FeldWert | FeldWert[];

function istGruppe(e: ElementSpez): e is GruppenSpez {
  return "teile" in e;
}

/** Formatiert einen Betrag/Dezimalwert: feste Nachkommastellen, Dezimalkomma, Minus voran. */
export function formatDezimal(wert: number, nachkomma: number): string {
  if (!Number.isFinite(wert)) throw new Error("Ungültiger Zahlenwert.");
  const s = Math.abs(wert).toFixed(nachkomma).replace(".", ",");
  return (wert < 0 ? "-" : "") + s;
}

/** Cent-Betrag als "..,2"-Wert (ohne Gleitkomma-Rundung). */
export function centZuText(cent: number): string {
  if (!Number.isInteger(cent)) throw new Error("Cent-Beträge müssen ganzzahlig sein.");
  const neg = cent < 0;
  const abs = Math.abs(cent);
  const euro = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  return (neg ? "-" : "") + `${euro},${rest}`;
}

function pruefeFeld(spez: FeldSpez, roh: FeldWert, ort: string, fehler: Gkv302Fehler[]): string {
  if (roh === undefined || roh === null || roh === "") {
    if (spez.art === "M") fehler.push({ art: "pflichtfeld", pfad: ort, meldung: `Muss-Feld „${spez.name}“ fehlt.` });
    return "";
  }
  let text: string;
  if (spez.dezimal !== undefined) {
    // Beträge werden als Text in der Form -?\d+,\d{n} erwartet (bereits formatiert) oder als Zahl
    text = typeof roh === "number" ? formatDezimal(roh, spez.dezimal) : roh;
    const re = new RegExp(`^-?\\d+,\\d{${spez.dezimal}}$`);
    if (!re.test(text)) {
      fehler.push({ art: "format", pfad: ort, meldung: `„${spez.name}“ muss eine Zahl mit ${spez.dezimal} Nachkommastellen sein (z. B. 12,30), erhalten: „${text}“.` });
      return text;
    }
    // Lesart „..m,n“: höchstens m Stellen insgesamt, davon genau n Nachkommastellen; Minus und Komma zählen nicht
    // (TA1 V21 5.1 Abs. 8–10, S. 11–12: „Anzahl Stellen … höchstmögliche Stellenbelegung“, „Das Minuszeichen und das
    // Dezimalzeichen werden bei der Ermittlung der maximalen Länge … nicht mitgezählt“). Führende Nullen zählen nicht
    // (Abs. 10: „+,15+“ zulässig). Einzige Ausnahme: SKO „..2,2“ (`maxNurVorkomma`), Erprobungsfrage.
    const vorkomma = text.replace(/^-/, "").split(",")[0].replace(/^0+/, "");
    const stellen = spez.maxNurVorkomma ? vorkomma.length : vorkomma.length + spez.dezimal;
    if (spez.max !== undefined && stellen > spez.max) {
      fehler.push({
        art: "laenge",
        pfad: ort,
        meldung: spez.maxNurVorkomma
          ? `„${spez.name}“ hat ${vorkomma.length} Vorkommastellen, erlaubt sind höchstens ${spez.max} (Format ..${spez.max},${spez.dezimal}, Ausnahme: Vorkommastellen).`
          : `„${spez.name}“ hat ${stellen} Stellen, erlaubt sind höchstens ${spez.max} einschließlich ${spez.dezimal} Nachkommastellen (Format ..${spez.max},${spez.dezimal}).`,
      });
    }
    return text;
  }
  text = String(roh);
  const zeichen = unzulaessigesZeichen(text);
  if (zeichen !== null) {
    fehler.push({ art: "zeichensatz", pfad: ort, meldung: `„${spez.name}“ enthält das Zeichen „${zeichen}“, das im Zeichensatz UNOC (ISO 8859-1) nicht darstellbar ist.` });
  }
  if (spez.typ === "N" && !/^\d+$/.test(text)) {
    fehler.push({ art: "format", pfad: ort, meldung: `„${spez.name}“ ist numerisch und darf nur Ziffern enthalten, erhalten: „${text}“.` });
  }
  if (spez.laenge !== undefined && text.length !== spez.laenge) {
    fehler.push({ art: "laenge", pfad: ort, meldung: `„${spez.name}“ muss genau ${spez.laenge} Stellen haben, erhalten: ${text.length} („${text}“).` });
  }
  if (spez.max !== undefined && text.length > spez.max) {
    fehler.push({ art: "laenge", pfad: ort, meldung: `„${spez.name}“ darf höchstens ${spez.max} Stellen haben, erhalten: ${text.length}.` });
  }
  if (spez.min !== undefined && text.length < spez.min) {
    fehler.push({ art: "laenge", pfad: ort, meldung: `„${spez.name}“ muss mindestens ${spez.min} Stellen haben, erhalten: ${text.length}.` });
  }
  if (spez.schluessel && !spez.schluessel.includes(text)) {
    fehler.push({ art: "schluessel", pfad: ort, meldung: `„${spez.name}“: Wert „${text}“ ist nicht zulässig (erlaubt: ${spez.schluessel.join(", ")}).` });
  }
  return spez.typ === "AN" ? maskiere(text) : text;
}

/**
 * Baut ein Segment nach Spezifikation. Prüft Typ, Länge, Muss/Kann und Schlüssel (Prüfstufen 2/3 auf Feldebene).
 * Gibt den Segmenttext inkl. Segmentendezeichen zurück. Leere Kann-Felder am Ende entfallen (TA1 5.2 Abs. 3).
 */
export function baueSegment(spez: SegmentSpez, werte: ElementWert[], ort: string, fehler: Gkv302Fehler[]): string {
  if (werte.length > spez.elemente.length) {
    throw new Error(`Segment ${spez.kennung}: zu viele Werte (${werte.length} > ${spez.elemente.length}).`);
  }
  const teile: string[] = [spez.kennung];
  spez.elemente.forEach((el, i) => {
    const wert = werte[i];
    const feldOrt = `${ort}/${spez.kennung}/${el.name}`;
    if (istGruppe(el)) {
      const arr = Array.isArray(wert) ? wert : [];
      const leer = arr.every((v) => v === undefined || v === null || v === "");
      if (leer) {
        if (el.art === "M") fehler.push({ art: "pflichtfeld", pfad: feldOrt, meldung: `Muss-Datenelementgruppe „${el.name}“ fehlt.` });
        teile.push("");
        return;
      }
      const komponenten = el.teile.map((t, j) => pruefeFeld(t, arr[j], `${feldOrt}/${t.name}`, fehler));
      while (komponenten.length > 1 && komponenten[komponenten.length - 1] === "") komponenten.pop();
      teile.push(komponenten.join(TRENNER.gruppe));
    } else {
      if (Array.isArray(wert)) throw new Error(`Segment ${spez.kennung}/${el.name}: einfacher Wert erwartet.`);
      teile.push(pruefeFeld(el, wert, feldOrt, fehler));
    }
  });
  while (teile.length > 1 && teile[teile.length - 1] === "") teile.pop();
  return teile.join(TRENNER.element) + TRENNER.segmentende;
}

// ───────────────────────── Zerlegung (Parser) ─────────────────────────

export interface Trennzeichen {
  gruppe: string;
  element: string;
  dezimal: string;
  aufhebung: string;
  segmentende: string;
}

/** Ein zerlegtes Segment: kennung + Elemente, jedes Element als Liste seiner Komponenten (bereits entmaskiert). */
export interface RohSegment {
  kennung: string;
  elemente: string[][];
  /** laufende Nummer in der Datei (1-basiert), für Fehlermeldungen */
  nr: number;
}

/** Obergrenzen für die Vorprüfung vor dem Zerlegen (Speicher-DoS, Review-Runde 2 AppSec H1) */
export interface EdifactGrenzen {
  maxSegmente: number;
  /** Datenelemente je Segment (inkl. Kennung) */
  maxElemente: number;
  /** Gruppendatenelemente (Komponenten) je Datenelement */
  maxGruppen: number;
  /** Zeichen je Segment */
  maxSegmentLaenge: number;
  /** Datenelemente in der ganzen Datei */
  maxDatenelementeGesamt: number;
}

/**
 * Vorprüfung in einem Durchlauf ohne Objekte je Trennzeichen: Die Datei muss mit UNA oder UNB beginnen, und Segmente,
 * Datenelemente und Komponenten müssen unter den Grenzen bleiben – sonst `Error` mit deutscher Meldung, bevor
 * `zerlegeEdifact` Speicher anlegt (8 MB nur aus „'“ hätten sonst rund 820 MB Heap gekostet, nur aus „+“ rund 1,8 GB).
 * Aufgehobene Zeichen (Aufhebungszeichen davor) zählen nicht.
 */
export function vorpruefeEdifact(inhalt: string, g: EdifactGrenzen): void {
  let text = inhalt.startsWith("\ufeff") ? inhalt.slice(1) : inhalt;
  let t: Trennzeichen = { ...TRENNER };
  if (text.startsWith("UNA")) {
    if (text.length < 9) throw new Error("UNA-Segment unvollständig.");
    t = { gruppe: text[3], element: text[4], dezimal: text[5], aufhebung: text[6], segmentende: text[8] };
    text = text.slice(9);
  }
  if (!/^\s*UNB/.test(text.slice(0, 16))) throw new Error("Die Datei beginnt nicht mit UNA oder UNB.");
  let segmente = 0;
  let elemente = 1;
  let gruppen = 1;
  let laenge = 0;
  let gesamt = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    laenge++;
    if (laenge > g.maxSegmentLaenge) throw new Error(`Segment zu lang (mehr als ${g.maxSegmentLaenge} Zeichen).`);
    if (c === t.aufhebung) {
      i++;
      laenge++;
      continue;
    }
    if (c === t.segmentende) {
      if (++segmente > g.maxSegmente) throw new Error(`Die Datei hat zu viele Segmente (mehr als ${g.maxSegmente}).`);
      elemente = 1;
      gruppen = 1;
      laenge = 0;
      continue;
    }
    if (c === t.element) {
      if (++elemente > g.maxElemente) throw new Error(`Segment ${segmente + 1} hat zu viele Datenelemente (mehr als ${g.maxElemente}).`);
      if (++gesamt > g.maxDatenelementeGesamt) throw new Error(`Die Datei hat zu viele Datenelemente (mehr als ${g.maxDatenelementeGesamt}).`);
      gruppen = 1;
      continue;
    }
    if (c === t.gruppe && ++gruppen > g.maxGruppen) throw new Error(`Segment ${segmente + 1} hat zu viele Gruppendatenelemente (mehr als ${g.maxGruppen}).`);
  }
}

/**
 * Zerlegt eine EDIFACT-Datei in Segmente. Unterstützt ein optionales UNA-Festlegungssegment
 * (Kostenträgerdatei, Anhang 3 Kap. 7.1) und Zeilenumbrüche zwischen Segmenten.
 */
export function zerlegeEdifact(inhalt: string): RohSegment[] {
  let t: Trennzeichen = { ...TRENNER };
  let text = inhalt.replace(/^﻿/, "");
  if (text.startsWith("UNA")) {
    // UNA + 6 Zeichen: Gruppe, Element, Dezimal, Aufhebung, reserviert, Segmentende
    t = { gruppe: text[3], element: text[4], dezimal: text[5], aufhebung: text[6], segmentende: text[8] };
    text = text.slice(9);
  }
  const segmente: RohSegment[] = [];
  let element: string[] = [];
  let elemente: string[][] = [];
  let feld = "";
  let nr = 0;
  const abschliessenElement = () => {
    element.push(feld);
    elemente.push(element);
    element = [];
    feld = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === t.aufhebung) {
      i++;
      if (i < text.length) feld += text[i];
      continue;
    }
    if (c === t.segmentende) {
      abschliessenElement();
      const kennung = (elemente[0]?.[0] ?? "").trim();
      nr++;
      segmente.push({ kennung, elemente: elemente.slice(1), nr });
      elemente = [];
      continue;
    }
    if (c === t.element) {
      abschliessenElement();
      continue;
    }
    if (c === t.gruppe) {
      element.push(feld);
      feld = "";
      continue;
    }
    if ((c === "\r" || c === "\n") && feld === "" && element.length === 0 && elemente.length === 0) continue;
    feld += c;
  }
  if ((feld.trim() !== "" || elemente.length > 0) && text.trim() !== "") {
    throw new Error("Die Datei endet nicht mit einem Segmentendezeichen.");
  }
  return segmente;
}

/** Komponente j von Element i (0-basiert, ohne Kennung) oder "" */
export function wert(seg: RohSegment, i: number, j = 0): string {
  return seg.elemente[i]?.[j] ?? "";
}
