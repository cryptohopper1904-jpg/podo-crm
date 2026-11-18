/** reiner negativer Betrag (z. B. „-12,50“, „-12.50“, „-5“) – keine Formel, bleibt eine Zahl (Paket C Review R1-15) */
const NEGATIVE_NUMBER = /^-\d{1,15}(?:[.,]\d{1,4})?$/;

/**
 * Schutz vor CSV-/Formel-Injection (Excel, LibreOffice): Textzellen, die mit = + - @ Tab oder CR
 * beginnen, bekommen ein vorangestelltes Apostroph. Zahlen bleiben unverändert – auch negative Beträge als Text
 * („-12,50“), sonst würde die Tabellenkalkulation sie als Text statt Zahl lesen. Alles andere mit „-“ (z. B. „-1+1“)
 * wird weiter entschärft. Das CSV-Quoting (Anführungszeichen, Trennzeichen, Zeilenumbrüche) übernimmt danach writeCsv.
 */
export function neutralizeCsvCell<T>(value: T): T | string {
  if (typeof value !== "string") return value;
  if (NEGATIVE_NUMBER.test(value)) return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function neutralizeCsvRows(rows: unknown[][]): unknown[][] {
  return rows.map((r) => r.map(neutralizeCsvCell));
}
