/**
 * Hinweis „Frequenzabweichung“ in Doku und Besuchstag (PR #111 Review-Runde 2): Text laut Seitenstand der gewählten
 * Verordnung, sonst der Hinweis des Servers aus dem letzten Speichern – aber nur, solange die Auswahl seitdem nicht
 * gewechselt wurde (`serverStale`); sonst gehört er zu einer anderen Verordnung.
 */
export function deviationHint(input: { selected: boolean; pageText?: string | null; serverText?: string | null; serverStale: boolean }): string | null {
  if (!input.selected) return null;
  return input.pageText ?? (input.serverStale ? null : (input.serverText ?? null));
}
