/**
 * Datenmodell einer Abrechnung nach § 302 SGB V für Heilmittelerbringer der Podologie (Abrechnungscode 71/72).
 * Feldnamen orientieren sich an TA1 (Segment_Feld); Beträge immer in Cent (ganzzahlig), Datumsangaben als
 * ISO-Text "JJJJ-MM-TT". Für jedes Feld ist das Zielsegment angegeben.
 */
import type { Dateiart, Verarbeitungskennzeichen, Verordnungsart, Zuzahlungskennzeichen } from "./schluessel";

export type TaVersion = "21" | "22";

/** ISO-Datum "JJJJ-MM-TT" */
export type IsoDatum = string;

export interface Anschrift {
  strasse: string;
  plz: string;
  ort: string;
}

/** Praxis = Leistungserbringer (Rechnungssteller in Rechnungsart 1/2) */
export interface Praxis {
  /** IK des Leistungserbringers (SLGA/SLLA FKT); je Filiale eigenes IK (Richtlinien § 5 Abs. 3) */
  ik: string;
  /** NAM Name 1 (..30): Name bzw. Firmenbezeichnung */
  name: string;
  /** NAM Name 2/3 (..30): ggf. Ansprechpartner und Telefonnummer */
  ansprechpartner?: string;
  telefon?: string;
  /** NAM Name 4 (..70): E-Mail-Adresse (Buchstaben/Ziffern, keine Umlaute) */
  email?: string;
  /** für den Begleitzettel (Anlage 4) */
  anschrift: Anschrift;
  /** EHE Leistungserbringergruppe: Abrechnungscode (Anlage 3 8.1.5.1), Podologie = "71" */
  abrechnungscode: "71" | "72";
  /** EHE Leistungserbringergruppe: Tarifkennzeichen (Anlage 3 8.1.5.2), 5 Stellen, aus Zulassung/Vertrag */
  tarifkennzeichen: string;
  /**
   * MWS nur, wenn der Vertrag Nettopreis + MwSt vorsieht (TA1 V21 5.5.3.3 MWS, S. 56). Podologische Heilbehandlungen
   * sind in der Regel nach § 4 Nr. 14 Buchst. a UStG umsatzsteuerfrei; deshalb ist das MWS-Segment bei
   * Abrechnungscode 71/72 nur mit dieser ausdrücklichen Freischaltung erlaubt.
   */
  mehrwertsteuerVereinbart?: boolean;
  /** UST (Kann-Segment): Steuernummer bzw. USt-IdNr. */
  umsatzsteuer?: { steuernummer: string; befreit: boolean };
  /** SKO (Kann-Segment, 0–9×) */
  skonto?: { prozent: number; zahlungszielTage: number }[];
}

export interface Versicherter {
  /** INV Versicherten-Nummer (..12) */
  versichertennummer?: string;
  /** INV Versichertenstatus wie bedruckt; 5 Stellen werden erzeugt (siehe statusFuerInv) */
  versichertenstatus?: string;
  /** NAD */
  nachname: string;
  vorname: string;
  /** "JJJJ-MM-TT"; für unbekannte Tage/Monate bei ausländischen Versicherten "JJJJ-MM-00" bzw. "JJJJ-00-00" */
  geburtsdatum: string;
  strasse?: string;
  plz?: string;
  ort?: string;
  /** Anlage 3 Schlüssel 8.5 (nur Auslandsanschrift) */
  laenderkennzeichen?: string;
}

/** Leitsymptomatik nach Heilmittelkatalog (ZHE, 4 Stellen) */
export type Leitsymptomatik =
  | { art: "heilmittelrichtlinie"; a: boolean; b: boolean; c: boolean; patientenindividuell: boolean }
  /** Verordnung unterliegt nicht der HeilM-RL (Ärzte) → "9999" */
  | { art: "ausserhalbHeilmRl" };

export interface Diagnose {
  /** DIA Diagnoseschlüssel: ICD-10-Code (..12) */
  icd10?: string;
  /** DIA Diagnosetext (..70); nötig, wenn kein ICD-10-Code auf der Verordnung steht */
  text?: string;
}

export interface Verordnung {
  /** ZHE Betriebsstättennummer; fehlt sie auf der Verordnung: "999999999" */
  betriebsstaettennummer?: string;
  /** ZHE Lebenslange Arztnummer; fehlt sie: "999999999" (kein Auffüllen auf 9 Stellen) */
  lanr?: string;
  verordnungsdatum: IsoDatum;
  /** ZHE Diagnosegruppe (z. B. "DF", "NF", "QF"); fehlt sie: "9999" */
  diagnosegruppe?: string;
  /** ZHE Kennzeichen Verordnungsart (Anlage 3 8.1.12) */
  verordnungsart: Verordnungsart;
  /** ZHE Kennzeichen Verordnungsbesonderheiten (Anlage 3 8.1.11) */
  verordnungsbesonderheit?: "1" | "2" | "4" | "7" | "9";
  /** ZHE Unfallkennzeichen (Anlage 3 8.1.2) */
  unfallkennzeichen?: "1" | "2" | "3";
  /** ZHE Kennzeichen BVG/Sonstiges/SER (Anlage 3 8.1.2.1) */
  bvgSer?: boolean;
  therapieberichtAngefordert: boolean;
  /** ZHE Hausbesuch: „1“, wenn der Verordner das Feld angekreuzt hat */
  hausbesuch: boolean;
  leitsymptomatik: Leitsymptomatik;
  /** ZHE Patientenindividuelle Leitsymptomatik (..70) */
  leitsymptomatikText?: string;
  dringlicherBehandlungsbedarf: boolean;
  /** ZHE Heilmittel-Bereich (Kann-Feld); Podologie = "2" */
  heilmittelbereich?: "2";
  /** ZHE Therapiefrequenz; bei Podologie laut TA1 „0“ */
  therapiefrequenz: number;
  /** DIA (1–n) */
  diagnosen: Diagnose[];
  /** SKZ (0–1) Genehmigung eines langfristigen Heilmittelbedarfs */
  genehmigung?: { kennzeichen: string; datum: IsoDatum; art: "B2" };
}

export interface Einzelleistung {
  /** EHE Abrechnungspositionsnummer (5 Stellen, bundeseinheitliches Heilmittelpositionsnummernverzeichnis) */
  positionsnummer: string;
  /** EHE Anzahl/Menge (..4,2), z. B. 1 oder bei Wegegeld je km die Kilometer */
  anzahl: number;
  /** EHE Einzelbetrag (vereinbarter Preis je Einheit) in Cent; bei Netto-Preis + MwSt der Nettopreis */
  einzelpreisCent: number;
  /** EHE Datum der Leistungserbringung */
  datum: IsoDatum;
  /** EHE Gefahrene Kilometer (..6), wenn Kilometer in einer Pauschale abgerechnet werden (Wegegeld) */
  gefahreneKilometer?: number;
  /** TXT (0–1) Begründung/Beschreibung (..70) */
  text?: string;
  /** MWS (0–1) nur wenn dem Einzelbetrag MwSt hinzuzurechnen ist; Satz in Prozent, z. B. 19 */
  mehrwertsteuerProzent?: number;
  /**
   * Eigenschaft der Abrechnungsposition laut Vergütungsliste/Vertrag: ob die Position der gesetzlichen Zuzahlung
   * unterliegt. Standard ja (undefined = ja); `false` für Positionen ohne Zuzahlung (Vergütungsliste Podologie
   * Anlage 2: Zuzahlungsspalte „-“ bzw. leer). Positionen mit `false` erhalten nie einen Zuzahlungsbetrag (EHE „sofern dieser vom Versicherten zu entrichten
   * ist“, TA1 V21 5.5.3.3, S. 67).
   */
  zuzahlungsfaehig?: boolean;
  /**
   * Zeitbezug je Position: bei Zuzahlungskennzeichen 2, 4 oder 5 (VKZ ≠ 03) und bei VKZ 03 mit ZK 5, ob der Termin
   * in den zuzahlungspflichtigen Zeitraum fällt (Pflicht). Bei VKZ 03 mit ZK 1/2 optional: `false` nimmt die
   * Position von der Forderung aus. Bei "3" gilt ja, bei "0"/"1" nein.
   */
  zuzahlungspflichtig?: boolean;
}

/** URI: Bezug auf die ursprüngliche Rechnung (Verarbeitungskennzeichen 02, 03, 04) */
export interface UrspruenglicheRechnung {
  ikLeistungserbringer: string;
  sammelRechnungsnummer: string;
  einzelRechnungsnummer: string;
  rechnungsdatum: IsoDatum;
  belegnummer: string;
}

/** Ein Abrechnungsfall = eine Verordnung (INV … BES) */
export interface Abrechnungsfall {
  /** INV Belegnummer (..10), eindeutig in der Gesamtrechnung, auch auf die Verordnung aufzudrucken */
  belegnummer: string;
  /** INV Beleginformation (Anlage 3 8.1.18), z. B. "1" = Belege per Post */
  beleginformation?: "0" | "1" | "2";
  /** INV Kennzeichen Besondere Versorgungsform (..25) */
  besondereVersorgungsform?: string;
  /** EVO eVO-ID (22..256), nur bei elektronischer Verordnung */
  eVoId?: string;
  versicherter: Versicherter;
  verordnung: Verordnung;
  /** ZHE Zuzahlungskennzeichen (Anlage 3 8.1.3) */
  zuzahlungskennzeichen: Zuzahlungskennzeichen;
  /**
   * Bei Zuzahlungskennzeichen 2, 4, 5 (VKZ ≠ 03) und bei VKZ 03 mit ZK 5: ob die Pauschale (10,00 €) je Verordnung
   * anfällt (Pflicht). Bei VKZ 03 mit ZK 1/2 optional: Standard ja, `false` nimmt die Pauschale von der Forderung aus.
   */
  pauschaleZuzahlung?: boolean;
  /**
   * Nur VKZ 03 (Zuzahlungsforderung nach § 43c SGB V): Nachweis über den erfolglosen Einzugsversuch, der
   * parallel zum Datensatz an den Kostenträger geht (TA1 V21 7.4.2.1, S. 167; Vordruck „TP5_KorVer_43cSGBV“).
   * Die Bibliothek erzeugt den Nachweis nicht; sie verlangt nur die Referenz auf das abgelegte Dokument.
   */
  nachweisErfolgloserEinzug?: { referenz: string; datum: IsoDatum };
  /** EHE (1–n) */
  leistungen: Einzelleistung[];
  /** nur bei Verarbeitungskennzeichen ≠ 01 */
  urspruenglich?: UrspruenglicheRechnung;
  /** BES Pauschale Korrekturabzug (nur Verarbeitungskennzeichen 04, sofern vertraglich vereinbart) */
  pauschalerKorrekturabzugCent?: number;
  /** Anzahl Papier-Urbelege für den Begleitzettel; Standard 1, bei eVO 0 */
  anzahlUrbelege?: number;
}

/** Gesamtrechnung je IK der Krankenkasse (KV-Karte bzw. Verordnung): ein Paar SLGA + SLLA */
export interface Gesamtrechnung {
  /** FKT IK der Krankenkasse von der KV-Karte bzw. der Verordnung */
  kasseIk: string;
  /** für den Begleitzettel (Anlage 4): Name der Krankenkasse, z. B. aus der Kostenträgerdatei (NAM) */
  kasseName?: string;
  /**
   * REC Rechnungsnummer (..14). Ohne Sammelrechnung die (Sammel-)Rechnungsnummer, Einzel-Rechnungsnummer wird „0“.
   * Mit Sammelrechnung wird die Sammel-Rechnungsnummer des Kostenträgers verwendet und hier die
   * Einzel-Rechnungsnummer (..6) erwartet.
   */
  rechnungsnummer: string;
  rechnungsdatum: IsoDatum;
  verarbeitungskennzeichen: Verarbeitungskennzeichen;
  faelle: Abrechnungsfall[];
}

export interface KostentraegerAbrechnung {
  /** FKT IK des Kostenträgers (laut Kostenträgerdatei, VKG Art 01) */
  kostentraegerIk: string;
  /** optionale Sammelrechnung je Kostenträger (TA1 5.3.2) */
  sammelrechnung?: { rechnungsnummer: string; rechnungsdatum: IsoDatum };
  rechnungen: Gesamtrechnung[];
}

export interface LeistungserbringerAbrechnung {
  praxis: Praxis;
  kostentraeger: KostentraegerAbrechnung[];
}

/** Eine Nutzdatendatei (UNB … UNZ) je Datenannahmestelle mit Entschlüsselungsbefugnis und Kassenart */
export interface Nutzdatendatei {
  taVersion: TaVersion;
  /** UNB Absender: IK des Absenders; Selbstabrechner "S" oder Abrechnungsstelle "A" (Anhang 1 4.2) */
  absender: { ik: string; art: "S" | "A"; /** bei "A" Pflicht (Begleitzettel) */ name?: string; anschrift?: Anschrift };
  /** UNB Empfänger: IK der Datenannahmestelle mit Entschlüsselungsbefugnis (Kostenträgerdatei VKG Art 03) */
  empfaengerIk: string;
  /** UNB Datum/Uhrzeit der Erstellung */
  erstellt: { datum: IsoDatum; uhrzeit: string };
  /** UNB Datenaustauschreferenz: fortlaufend je Absender/Empfänger, 1–99999 */
  datenaustauschreferenz: number;
  dateiart: Dateiart;
  /** Abrechnungsmonat für den logischen Dateinamen (1–12) */
  abrechnungsmonat: number;
  /** REC Rechnungsart (Anlage 3 8.1.4): 1 = Leistungserbringer selbst, 2 = Abrechnungsstelle ohne Inkasso */
  rechnungsart: "1" | "2";
  /**
   * Prozentsatz der gesetzlichen Zuzahlung (Berechnungsregel EHE „mal Zuzahlungsprozentsatz“). Die TA1 nennt
   * den Wert nicht; er ergibt sich aus § 61 SGB V und ist von der Praxis/vom Vertrag zu bestätigen.
   */
  zuzahlungProzent: number;
  /** Pauschaler Zuzahlungsbetrag je Verordnungsblatt in Cent (TA1 BES: 10,00 Euro) */
  zuzahlungPauschaleCent?: number;
  leistungserbringer: LeistungserbringerAbrechnung[];
  /** Segmente durch Zeilenumbruch trennen (nur zur Lesbarkeit; die TA1 sieht das nicht vor) */
  zeilenumbruch?: boolean;
}
