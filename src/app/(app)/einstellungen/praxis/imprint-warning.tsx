import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { IMPRINT_FIELD_LABELS, missingImprintFields, type ImprintBase } from "@/lib/imprint";
import { parseOnlineBookingSettings } from "@/lib/portal-booking";

/**
 * Warnung, solange Impressums-Pflichtangaben fehlen (§ 5 DDG): Website-Impressum unvollständig. Erscheint in
 * Einstellungen → Praxis und → Website. Ist die Online-Buchung eingeschaltet, zeigt schon das Einstellungen-Layout
 * „Online-Buchung gesperrt: Impressumsangaben fehlen“ (components/booking-imprint-notice.tsx) – dann hier nichts doppelt.
 */
export function ImprintWarning({ org, settings }: { org: ImprintBase; settings: Record<string, unknown> | null }) {
  const missing = missingImprintFields(org, settings);
  if (!missing.length || parseOnlineBookingSettings(settings).enabled) return null;
  return (
    <div className="flex gap-3 rounded-xl border border-warn-soft-text/40 bg-warn-soft p-4 text-sm text-warn-soft-text">
      <AlertTriangle size={20} aria-hidden className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="font-semibold">Impressum unvollständig</p>
        <p className="mt-1">
          Für das Impressum (§ 5 DDG) fehlen: {missing.map((f) => IMPRINT_FIELD_LABELS[f]).join(", ")}. Schaltest du die Online-Buchung ein, bleibt sie
          ohne diese Angaben gesperrt.
        </p>
        <Link href="/einstellungen/praxis#impressum" className="mt-1 inline-flex min-h-11 items-center font-semibold underline underline-offset-2">
          Pflichtangaben ergänzen →
        </Link>
      </div>
    </div>
  );
}
