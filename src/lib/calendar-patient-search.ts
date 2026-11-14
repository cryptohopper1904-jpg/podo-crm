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

/**
 * Suchtext → Vorschlag für eine neue Patient:in: letztes Wort = Nachname, davor Vorname(n); „Nachname, Vorname“
 * wird erkannt. Ziffern (Patientennummer gesucht) ergeben keinen Namen.
 */
export function splitNewName(query: string): { firstName: string; lastName: string } {
  const q = query.trim().replace(/\s+/g, " ");
  if (!q || /^\d+$/.test(q)) return { firstName: "", lastName: "" };
  if (q.includes(",")) {
    const [last, ...rest] = q.split(",");
    return { firstName: rest.join(" ").trim(), lastName: last.trim() };
  }
  const words = q.split(" ");
  if (words.length === 1) return { firstName: "", lastName: words[0] };
  return { firstName: words.slice(0, -1).join(" "), lastName: words.at(-1)! };
}
