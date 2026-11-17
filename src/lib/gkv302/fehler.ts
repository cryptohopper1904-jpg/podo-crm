/**
 * Fehlerliste der § 302-Bibliothek. Alle Meldungen sind deutsch und nennen Segment/Feld bzw. den Pfad im Eingabemodell.
 */

export type FehlerArt =
  /** Muss-Feld (M) bzw. Pflichtangabe fehlt */
  | "pflichtfeld"
  /** Feldlänge überschritten oder feste Länge nicht eingehalten */
  | "laenge"
  /** Feldtyp verletzt (z. B. Buchstabe in numerischem Feld, falsches Datumsformat) */
  | "format"
  /** Wert nicht im Schlüsselverzeichnis (Anlage 3) bzw. für Heilmittel/Podologie nicht zulässig */
  | "schluessel"
  /** Zeichen nicht im Zeichensatz UNOC darstellbar */
  | "zeichensatz"
  /** Kombinationsprüfung über mehrere Felder (Prüfstufe 3) */
  | "kombination"
  /** Institutionskennzeichen mit falscher Prüfziffer */
  | "pruefziffer";

export interface Gkv302Fehler {
  art: FehlerArt;
  /** Fundstelle, z. B. "leistungserbringer[0].kostentraeger[0].rechnungen[0].faelle[2].leistungen[0].einzelpreisCent" oder "SLLA/EHE/Einzelbetrag" */
  pfad: string;
  meldung: string;
}

export class Gkv302ValidierungsFehler extends Error {
  readonly fehler: Gkv302Fehler[];
  constructor(fehler: Gkv302Fehler[]) {
    super(
      `Abrechnungsdaten nach § 302 SGB V sind fehlerhaft (${fehler.length} Fehler):\n` +
        fehler.map((f) => `- ${f.pfad}: ${f.meldung}`).join("\n"),
    );
    this.name = "Gkv302ValidierungsFehler";
    this.fehler = fehler;
  }
}
