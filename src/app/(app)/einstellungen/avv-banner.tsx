"use client";

import { FileText } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { LEGAL_VERSIONS, RETENTION_MIN_AVV, versionAtLeast } from "@/lib/legal";
import { acceptAvvAction } from "./actions";

/**
 * Aktualisierte AVV bestätigen (nur Inhaber:in; über allen Einstellungs-Bereichen und auf „Heute“). Gespeichert werden
 * Version, Zeitpunkt und Person; erst ab RETENTION_MIN_AVV gilt die Standardweisung zur Löschung unbestätigter
 * Online-Anfragen (§ 3 Nr. 4) – der Hinweis dazu erscheint nur, solange die bisherige Zustimmung älter ist.
 */
export function AvvBanner({ previous }: { previous: string | null }) {
  const retentionNew = !versionAtLeast(previous, RETENTION_MIN_AVV);
  return (
    <div role="status" className="flex gap-3 rounded-xl border border-info-soft-text/40 bg-info-soft p-4 text-sm text-info-soft-text">
      <FileText size={20} aria-hidden className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="font-semibold">Auftragsverarbeitungsvertrag (AVV) aktualisiert – Version {LEGAL_VERSIONS.avv}</p>
        <p className="mt-1">
          {previous ? `Du hast bisher Version ${previous} akzeptiert. ` : null}
          {retentionNew ? (
            <>
              Neu ist u. a. die Standardweisung, Online-Anfragen, die nicht zu einem Termin oder einer Behandlung geführt haben, 6 Monate nach Eingang
              automatisch zu löschen (§ 3 Nr. 4). Bis du die neue Fassung akzeptierst, findet diese Löschung für deine Praxis nicht statt. Mit deiner
              Zustimmung werden beim nächsten nächtlichen Lauf auch bestehende Online-Anfragen gelöscht, die älter als 6 Monate sind und keiner Person
              zugeordnet wurden. Anfragen, die du behalten musst, ordne vorher einer Person zu.{" "}
            </>
          ) : null}
          <a href="/avv" target="_blank" rel="noreferrer" className="font-semibold underline underline-offset-2">AVV lesen</a>
        </p>
        <ActionForm action={acceptAvvAction} submit={`AVV ${LEGAL_VERSIONS.avv} akzeptieren`} className="mt-2 flex flex-col gap-2">
          <input type="hidden" name="avv" value={LEGAL_VERSIONS.avv} />
        </ActionForm>
      </div>
    </div>
  );
}
