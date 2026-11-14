/** Patientensuche im Formular „Neuer Termin“ (Kalender) – reine Logik ohne DB. */

export type PickerPatient = { id: string; number: number; firstName: string | null; lastName: string };

/**
 * Treffer für die Suche: alle Wörter müssen in Nachname, Vorname oder Nummer vorkommen (Groß-/Kleinschreibung egal).
 * Treffer, deren Nach- oder Vorname mit dem ersten Wort beginnt (oder deren Nummer es ist), stehen vorne.
 */
export function matchPatients(patients: readonly PickerPatient[], query: string, max = 8): PickerPatient[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = patients.filter((p) => {
    const hay = `${p.lastName} ${p.firstName ?? ""} ${p.number}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const first = words[0];
  const starts = (p: PickerPatient) => p.lastName.toLowerCase().startsWith(first) || (p.firstName ?? "").toLowerCase().startsWith(first) || String(p.number) === first;
  return [...hits.filter(starts), ...hits.filter((p) => !starts(p))].slice(0, max);
}
