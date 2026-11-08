/**
 * Schutz vor CSV-/Formel-Injection (Excel, LibreOffice): Textzellen, die mit = + - @ Tab oder CR
 * beginnen, bekommen ein vorangestelltes Apostroph. Zahlen bleiben unverändert.
 * Das CSV-Quoting (Anführungszeichen, Trennzeichen, Zeilenumbrüche) übernimmt danach writeCsv.
 */
export function neutralizeCsvCell<T>(value: T): T | string {
  if (typeof value !== "string") return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function neutralizeCsvRows(rows: unknown[][]): unknown[][] {
  return rows.map((r) => r.map(neutralizeCsvCell));
}
