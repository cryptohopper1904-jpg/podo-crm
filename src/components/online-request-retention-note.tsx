import { cx } from "@/components/ui";

/**
 * Hinweis zur Speicherdauer von Online-Anfragen (/buchen) – gleiche Aussage wie in den Datenschutzhinweisen der
 * Buchungsseite und in der AVV (§ 3 Nr. 4); Löschlauf: src/server/online-request-retention.ts.
 * Erscheint in Einstellungen → Praxis (Online-Buchung) und im Posteingang bei Online-Anfragen, deren Termin noch
 * keiner Person zugeordnet ist.
 */
export function OnlineRequestRetentionNote({ className }: { className?: string }) {
  return (
    <p className={cx("rounded-xl bg-info-soft p-3 text-sm text-info-soft-text", className)}>
      Online-Anfragen, die nicht zu einem Termin oder einer Behandlung geführt haben, werden 6 Monate nach Eingang automatisch gelöscht – so steht es
      auch in den Datenschutzhinweisen deiner Buchungsseite. Ordne Anfragen, die du behalten musst, rechtzeitig einer Person zu (der Termin wird dabei
      mit zugeordnet).
    </p>
  );
}
