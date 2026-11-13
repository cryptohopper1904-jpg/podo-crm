/**
 * Schnelleingabe von Leistungen über ihr Kürzel (z. B. „PK“, „AN“) in Rechnungspositionen.
 * Nur exakte Treffer (ohne Groß-/Kleinschreibung, Leerzeichen egal) – kein Präfix-Raten,
 * damit „PK“ nicht versehentlich „PKB“ wählt.
 */
export function normalizeServiceCode(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

export function findServiceByCode<T extends { code: string }>(services: readonly T[], input: string): T | undefined {
  const needle = normalizeServiceCode(input);
  if (!needle) return undefined;
  return services.find((s) => normalizeServiceCode(s.code) === needle);
}
