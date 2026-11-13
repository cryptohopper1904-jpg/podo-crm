/**
 * Termin ändern/verschieben (Kalender → Termin): Welche Termine darf die Praxis in PodoHero verschieben?
 * Reine Funktionen ohne Server-Importe (auch im Browser und in Tests nutzbar).
 *
 * Termine aus Doctolib (Quelle „doctolib“) und aus dem Kalender-Abo (Quelle „extern“ bzw. verknüpft über
 * calendar_feed_events) werden in der Quelle geändert und kommen per Abgleich zurück – eine Änderung in PodoHero
 * würde beim nächsten Abgleich überschrieben bzw. als Konflikt markiert.
 */

export const SYNCED_SOURCES = ["doctolib", "extern"] as const;

export type AppointmentLock = { reason: "doctolib" | "extern" | "cancelled" | "billed"; message: string };

/** billed: Termin steht auf einer ausgestellten, nicht stornierten Rechnung/Quittung (Leistungsdatum ist dort festgeschrieben). */
export function appointmentEditLock(a: { source: string; status: string }, fromCalendarFeed = false, billed = false): AppointmentLock | null {
  if (a.source === "doctolib") {
    return {
      reason: "doctolib",
      message: "Dieser Termin kommt aus Doctolib. Bitte direkt in Doctolib verschieben – die Änderung kommt mit dem nächsten Abgleich automatisch hierher.",
    };
  }
  if (a.source === "extern" || fromCalendarFeed) {
    return {
      reason: "extern",
      message:
        "Dieser Termin kommt aus dem Kalender-Abo (z. B. Google-Kalender). Bitte dort ändern – die Änderung kommt mit dem nächsten Abgleich automatisch hierher.",
    };
  }
  if (billed) {
    return {
      reason: "billed",
      message: "Dieser Termin ist bereits abgerechnet – das Leistungsdatum steht auf der Rechnung. Zum Verschieben die Rechnung zuerst stornieren.",
    };
  }
  if (a.status === "cancelled") {
    return { reason: "cancelled", message: "Abgesagte Termine können nicht verschoben werden. Bitte einen neuen Termin anlegen." };
  }
  return null;
}

/** Dauer in Minuten (gerundet) zwischen Beginn und Ende eines Termins. */
export const durationMinutes = (startsAt: Date, endsAt: Date) => Math.max(5, Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000));
