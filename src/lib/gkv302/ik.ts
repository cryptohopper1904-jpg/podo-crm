/**
 * Institutionskennzeichen (IK): 9 Stellen = 2 Klassifikation + 2 Regionalbereich + 4 Seriennummer + 1 Prüfziffer.
 *
 * Prüfziffer: Stellen 3 bis 8 werden von rechts beginnend abwechselnd mit 1 und 2 gewichtet, Produkte über 9
 * werden um 9 vermindert (Quersumme), die Summe modulo 10 ist die Prüfziffer.
 *
 * Quelle: Die Primärquelle (Gemeinsames Rundschreiben IK, 07/2018) war beim Bau nicht abrufbar (HTTP 404).
 * Das Verfahren stammt aus der Sekundärquelle dewiki.de „Institutionskennzeichen“ (Beispiel 260326822) und wurde
 * gegen alle elf IKs geprüft, die in der Broschüre TP5 (Stand 04.11.2026) abgedruckt sind (alle stimmig).
 * Siehe docs/GKV-302.md, Abschnitt „Quellen“.
 */

export function ikPruefziffer(ersteAchtStellen: string): number {
  if (!/^\d{8}$/.test(ersteAchtStellen)) throw new Error("Für die IK-Prüfziffer werden genau 8 Ziffern benötigt.");
  const stellen3bis8 = ersteAchtStellen.slice(2, 8);
  let summe = 0;
  for (let i = 0; i < 6; i++) {
    // Stelle 3 (i=0) … Stelle 8 (i=5); von rechts gesehen trägt Stelle 8 die Gewichtung 1.
    const gewicht = (5 - i) % 2 === 0 ? 1 : 2;
    const produkt = Number(stellen3bis8[i]) * gewicht;
    summe += produkt > 9 ? produkt - 9 : produkt;
  }
  return summe % 10;
}

/** true, wenn das IK 9 Ziffern hat und die Prüfziffer stimmt. */
export function istGueltigesIk(ik: string): boolean {
  return /^\d{9}$/.test(ik) && ikPruefziffer(ik.slice(0, 8)) === Number(ik[8]);
}

/** Hängt die Prüfziffer an 8 Ziffern an (für Testdaten). */
export function ikMitPruefziffer(ersteAchtStellen: string): string {
  return ersteAchtStellen + String(ikPruefziffer(ersteAchtStellen));
}
