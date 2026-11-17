/**
 * Auftragsdatei (Auftragssatz Version 01, 348 Byte) nach GGT Anlage 2 „Auftragsdatei“ (gültig ab 01.01.2025,
 * Stand 10.10.2024), Kap. 2.1–2.4. Zeichensatz ISO 8859-1 („I1“), N rechtsbündig mit Nullen, A/AN linksbündig mit
 * Leerzeichen; nicht genutzte Felder mit Default (N = '0', A/AN = ' ').
 */
import { alsLatin1 } from "./edifact";
import { physikalischerDateiname, verfahrenskennung } from "./dateiname";
import type { Dateiart } from "./schluessel";

export const AUFTRAGSSATZ_LAENGE = 348;

export interface AuftragsdateiDaten {
  dateiart: Dateiart;
  /** laufende Transfernummer 0–999 (Stellen 25–27), bei fehlgeschlagener Übertragung beibehalten */
  transfernummer: number;
  /** IK der verschlüsselnden Stelle (Stellen 33–47) */
  absenderEigner: string;
  /** tatsächlicher Absender (Stellen 48–62); Standard = absenderEigner */
  absenderPhysikalisch?: string;
  /** Datenannahmestelle mit Entschlüsselungsbefugnis laut Kostenträgerdatei (Stellen 63–77) */
  empfaengerNutzer: string;
  /** nächster physikalischer Empfänger, z. B. weiterleitende DAV (Stellen 78–92); Standard = empfaengerNutzer */
  empfaengerPhysikalisch?: string;
  /** logischer Dateiname (Stellen 105–115) */
  dateiname: string;
  /** Erstellungszeitpunkt (Stellen 116–129) als "JJJJ-MM-TT HH:MM:SS" */
  erstellt: string;
  /** Start der Übermittlung (Stellen 130–143), vom Absender gefüllt; Standard = erstellt */
  gesendet?: string;
  /** Größe der unverschlüsselten Nutzdatei in Byte (Stellen 179–190) */
  groesseNutzdaten: number;
  /** Größe nach Signatur/Verschlüsselung in Byte (Stellen 191–202) */
  groesseUebertragung: number;
  /** PKCS#7 signiert und verschlüsselt (03+03) oder keines von beiden (00+00) – Stellen 207–210 */
  verschluesselt: boolean;
  /** optionale E-Mail-Adresse des Absenders (Stellen 275–344, max. 70 Zeichen) */
  emailAbsender?: string;
}

function n(wert: number, laenge: number, feld: string): string {
  if (!Number.isInteger(wert) || wert < 0) throw new Error(`Auftragsdatei ${feld}: nicht negative ganze Zahl erwartet.`);
  const s = String(wert);
  if (s.length > laenge) throw new Error(`Auftragsdatei ${feld}: Wert ${s} länger als ${laenge} Stellen.`);
  return s.padStart(laenge, "0");
}

function an(wert: string, laenge: number, feld: string): string {
  if (wert.length > laenge) throw new Error(`Auftragsdatei ${feld}: „${wert}“ länger als ${laenge} Stellen.`);
  return wert.padEnd(laenge, " ");
}

/** "JJJJ-MM-TT HH:MM:SS" → "JHJJMMTThhmmss" (14 Stellen) */
function zeitstempel(s: string, feld: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`Auftragsdatei ${feld}: Zeitpunkt im Format JJJJ-MM-TT HH:MM:SS erwartet.`);
  // plausibel: echtes Kalenderdatum, Stunde 00–23, Minute/Sekunde 00–59 (GGT Anlage 2 Kap. 2.1, S. 6: Format JHJJMMTThhmmss)
  const [j, mo, t, h, mi, se] = m.slice(1).map(Number);
  const d = new Date(Date.UTC(j, mo - 1, t));
  if (d.getUTCFullYear() !== j || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== t || h > 23 || mi > 59 || se > 59) {
    throw new Error(`Auftragsdatei ${feld}: „${s}“ ist kein gültiger Zeitpunkt.`);
  }
  return m.slice(1).join("");
}

/** Erzeugt den Auftragssatz als Text (348 Zeichen). */
export function erzeugeAuftragssatz(a: AuftragsdateiDaten): string {
  const kennung = verfahrenskennung(a.dateiart);
  if (!/^\d{9}$/.test(a.absenderEigner) || !/^\d{9}$/.test(a.empfaengerNutzer)) throw new Error("Auftragsdatei: IKs müssen 9 Ziffern haben.");
  if (a.dateiname.length !== 11) throw new Error("Auftragsdatei: logischer Dateiname muss 11 Stellen haben.");
  const email = a.emailAbsender ?? "";
  if (email.length > 70) throw new Error("Auftragsdatei: E-Mail-Adresse höchstens 70 Zeichen.");
  if (/[^\x20-\x7e]/.test(email)) throw new Error("Auftragsdatei: E-Mail-Adresse nur mit ASCII-Zeichen.");
  const erstellt = zeitstempel(a.erstellt, "DATUM_ERSTELLUNG");
  const felder = [
    "500000", //                                      01–06 IDENTIFIKATOR
    "01", //                                          07–08 VERSION
    n(AUFTRAGSSATZ_LAENGE, 8, "LÄNGE_AUFTRAG"), //    09–16
    "000", //                                         17–19 SEQUENZ_NR (nicht segmentiert)
    an(kennung, 5, "VERFAHREN_KENNUNG"), //           20–24
    n(a.transfernummer, 3, "TRANSFER_NUMMER"), //     25–27
    an("", 5, "VERFAHREN_KENNUNG_SPEZIFIKATION"), //  28–32
    an(a.absenderEigner, 15, "ABSENDER_EIGNER"), //   33–47
    an(a.absenderPhysikalisch ?? a.absenderEigner, 15, "ABSENDER_PHYSIKALISCH"), // 48–62
    an(a.empfaengerNutzer, 15, "EMPFÄNGER_NUTZER"), // 63–77
    an(a.empfaengerPhysikalisch ?? a.empfaengerNutzer, 15, "EMPFÄNGER_PHYSIKALISCH"), // 78–92
    "000000", //                                      93–98 FEHLER_NUMMER
    "000000", //                                      99–104 FEHLER_MASSNAHME
    an(a.dateiname, 11, "DATEINAME"), //              105–115
    erstellt, //                                      116–129 DATUM_ERSTELLUNG
    a.gesendet ? zeitstempel(a.gesendet, "DATUM_ÜBERTRAGUNG_GESENDET") : erstellt, // 130–143
    "0".repeat(14), //                                144–157 DATUM_ÜBERTRAGUNG_EMPFANGEN_START (vom Empfänger)
    "0".repeat(14), //                                158–171 DATUM_ÜBERTRAGUNG_EMPFANGEN_ENDE (vom Empfänger)
    "000000", //                                      172–177 DATEIVERSION
    "0", //                                           178 KORREKTUR
    n(a.groesseNutzdaten, 12, "DATEIGRÖSSE_NUTZDATEN"), // 179–190
    n(a.groesseUebertragung, 12, "DATEIGRÖSSE_ÜBERTRAGUNG"), // 191–202
    "I1", //                                          203–204 ZEICHENSATZ ISO 8859-1
    "00", //                                          205–206 KOMPRIMIERUNG keine
    a.verschluesselt ? "03" : "00", //                207–208 VERSCHLÜSSELUNGSART
    a.verschluesselt ? "03" : "00", //                209–210 ELEKTRONISCHE_UNTERSCHRIFT
    "   ", //                                         211–213 SATZFORMAT (DFÜ: Leerzeichen)
    "00000", //                                       214–218 SATZLÄNGE (DFÜ)
    "00000000", //                                    219–226 BLOCKLÄNGE (DFÜ)
    " ", //                                           227 Status (KKS, Abrechnungssystem: Leerzeichen)
    "00", //                                          228–229 Wiederholung (KKS, Default)
    "0", //                                           230 Übertragungsweg (KKS, Default)
    "0".repeat(10), //                                231–240 Verzögerter Versand (Default)
    "000000", //                                      241–246 Info- und Fehlerfelder
    " ".repeat(28), //                                247–274 Variables Infofeld
    an(email, 70, "E-MAIL-ADRESSE_ABSENDER"), //      275–344 (E-Mail-Feld bis Stelle 344 erweitert)
    " ".repeat(4), //                                 345–348 Rest DATEI_BEZEICHNUNG (kein Dateisplitting)
  ];
  const satz = felder.join("");
  if (satz.length !== AUFTRAGSSATZ_LAENGE) throw new Error(`Auftragssatz hat ${satz.length} statt ${AUFTRAGSSATZ_LAENGE} Zeichen.`);
  return satz;
}

export interface Auftragsdatei {
  /** Dateiname der Auftragsdatei, z. B. "TSOL0001.AUF" */
  name: string;
  /** physikalischer Dateiname der zugehörigen (verschlüsselten) Nutzdatei, z. B. "TSOL0001" */
  nutzdateiName: string;
  text: string;
  bytes: Uint8Array;
}

export function erzeugeAuftragsdatei(a: AuftragsdateiDaten): Auftragsdatei {
  const text = erzeugeAuftragssatz(a);
  const physisch = physikalischerDateiname(a.dateiart, a.transfernummer);
  return { name: `${physisch}.AUF`, nutzdateiName: physisch, text, bytes: alsLatin1(text) };
}

/** Liest einen Auftragssatz (z. B. aus einer Rückmeldung) in seine wichtigsten Felder. */
export function leseAuftragssatz(satz: string) {
  if (satz.length !== AUFTRAGSSATZ_LAENGE) throw new Error(`Auftragssatz muss ${AUFTRAGSSATZ_LAENGE} Zeichen haben, hat ${satz.length}.`);
  const f = (von: number, bis: number) => satz.slice(von - 1, bis);
  return {
    identifikator: f(1, 6),
    version: f(7, 8),
    verfahrenKennung: f(20, 24),
    transfernummer: f(25, 27),
    absenderEigner: f(33, 47).trim(),
    absenderPhysikalisch: f(48, 62).trim(),
    empfaengerNutzer: f(63, 77).trim(),
    empfaengerPhysikalisch: f(78, 92).trim(),
    fehlerNummer: f(93, 98),
    fehlerMassnahme: f(99, 104),
    dateiname: f(105, 115).trim(),
    datumErstellung: f(116, 129),
    groesseNutzdaten: Number(f(179, 190)),
    groesseUebertragung: Number(f(191, 202)),
    zeichensatz: f(203, 204),
    verschluesselungsart: f(207, 208),
    elektronischeUnterschrift: f(209, 210),
    emailAbsender: f(275, 344).trim(),
  };
}
