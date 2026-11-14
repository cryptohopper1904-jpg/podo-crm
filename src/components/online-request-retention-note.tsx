import { cx } from "@/components/ui";

/**
 * Hinweis zur Speicherdauer von Online-Anfragen (/buchen) – gleiche Aussage wie in den Datenschutzhinweisen der
 * Buchungsseite und in der AVV (§ 3 Nr. 4); Löschlauf: src/server/online-request-retention.ts.
 * Erscheint in Einstellungen → Praxis (Online-Buchung) und im Posteingang bei nicht zugeordneten Online-Anfragen.
 */
export function OnlineRequestRetentionNote({ className }: { className?: string }) {
  return (
    <p className={cx("rounded-xl bg-info-soft p-3 text-sm text-info-soft-text", className)}>
      Online-Anfragen, die du nicht in eine Patientenakte übernimmst, werden 6 Monate nach Eingang automatisch gelöscht – so steht es auch in den
      Datenschutzhinweisen deiner Buchungsseite. Übernimm Anfragen, die du behalten musst, rechtzeitig in eine Akte.
    </p>
  );
}
