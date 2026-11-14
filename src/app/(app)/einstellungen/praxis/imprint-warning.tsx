import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { IMPRINT_FIELD_LABELS, missingImprintFields, type ImprintBase } from "@/lib/imprint";

/**
 * Warnung, solange Impressums-Pflichtangaben fehlen (§ 5 DDG): Online-Buchung ist dann gesperrt, Website-Impressum
 * unvollständig. Erscheint in Einstellungen → Praxis und → Website, unabhängig davon, ob eine Website veröffentlicht ist.
 */
export function ImprintWarning({ org, settings }: { org: ImprintBase; settings: Record<string, unknown> | null }) {
  const missing = missingImprintFields(org, settings);
  if (!missing.length) return null;
  return (
    <div className="flex gap-3 rounded-xl border border-warn-soft-text/40 bg-warn-soft p-4 text-sm text-warn-soft-text">
      <AlertTriangle size={20} aria-hidden className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="font-semibold">Impressum unvollständig – Online-Buchung gesperrt</p>
        <p className="mt-1">
          Für Impressum (§ 5 DDG) und Online-Buchung fehlen: {missing.map((f) => IMPRINT_FIELD_LABELS[f]).join(", ")}. Bis alles ausgefüllt ist,
          ist deine Buchungsseite für Patient:innen nicht erreichbar.
        </p>
        <Link href="/einstellungen/praxis#impressum" className="mt-1 inline-flex min-h-11 items-center font-semibold underline underline-offset-2">
          Pflichtangaben ergänzen →
        </Link>
      </div>
    </div>
  );
}
