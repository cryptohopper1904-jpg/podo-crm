/**
 * Dateinamen nach Anhang 1 zur Anlage 1 (Stand 31.08.2017), Kap. 4.2 und 4.3, sowie Anhang 2 Kap. 5/6.
 */
import type { Dateiart } from "./schluessel";

/**
 * Logischer Dateiname (UNB Anwendungsreferenz und Auftragsdatei DATEINAME), 11 Stellen:
 * "SL" + Stellen 3–8 des Absender-IK + "S"/"A" + Abrechnungsmonat "MM".
 */
export function logischerDateiname(absenderIk: string, art: "S" | "A", abrechnungsmonat: number): string {
  if (!/^\d{9}$/.test(absenderIk)) throw new Error("Absender-IK muss 9 Ziffern haben.");
  if (!Number.isInteger(abrechnungsmonat) || abrechnungsmonat < 1 || abrechnungsmonat > 12) {
    throw new Error("Abrechnungsmonat muss zwischen 1 und 12 liegen.");
  }
  return `SL${absenderIk.slice(2, 8)}${art}${String(abrechnungsmonat).padStart(2, "0")}`;
}

/**
 * Verfahrenskennung (Auftragsdatei Stellen 20–24) = Stellen 1–5 des physikalischen Dateinamens:
 * "E" Echtdaten bzw. "T" Testdaten + "SOL" + "0". Test- und Erprobungsdateien werden laut Anhang 2
 * Kap. 5 und 6 als Testdateien („z. B. TSOL“) gekennzeichnet.
 */
export function verfahrenskennung(dateiart: Dateiart): string {
  return `${dateiart === "echt" ? "E" : "T"}SOL0`;
}

/** Physikalischer Dateiname: Verfahrenskennung + laufende Transfernummer (3 Stellen, 000–999). */
export function physikalischerDateiname(dateiart: Dateiart, transfernummer: number): string {
  if (!Number.isInteger(transfernummer) || transfernummer < 0 || transfernummer > 999) {
    throw new Error("Transfernummer muss zwischen 0 und 999 liegen.");
  }
  return verfahrenskennung(dateiart) + String(transfernummer).padStart(3, "0");
}

/** Dateiname der Auftragsdatei (GGT Anlage 7, Beispiel „EREH0321.AUF“): physikalischer Name + ".AUF" */
export function auftragsdateiName(physikalisch: string): string {
  return `${physikalisch}.AUF`;
}
