/**
 * Kürzel archivierter Leistungen (reine Funktionen): Archivieren gibt das Kürzel frei – „AN“ → „AN_archiv“, bei
 * Kollision „AN_archiv2“, „AN_archiv3“ … Wiederherstellen nimmt den Zusatz wieder ab.
 */
const ARCHIVE_SUFFIX = /_archiv(\d*)$/i;

export function isArchivedCode(code: string): boolean {
  return ARCHIVE_SUFFIX.test(code);
}

/** Kandidaten in Prüf-Reihenfolge: AN_archiv, AN_archiv2 … AN_archiv99 */
export function archivedCodeCandidates(code: string): string[] {
  const base = restoredCode(code);
  return [`${base}_archiv`, ...Array.from({ length: 98 }, (_, i) => `${base}_archiv${i + 2}`)];
}

/** Ursprüngliches Kürzel ohne Archiv-Zusatz */
export function restoredCode(code: string): string {
  return code.replace(ARCHIVE_SUFFIX, "");
}
