import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { IMPRINT_FIELD_LABELS, type ImprintField } from "@/lib/imprint";

/**
 * „Online-Buchung gesperrt: Impressumsangaben fehlen“ (§ 5 DDG, src/lib/imprint.ts) – auf Heute und in den
 * Einstellungen, nur für Rollen mit settings.manage. Daten: bookingBlockedByImprint() (src/server/portal-booking.ts).
 */
export function BookingImprintNotice({ missing }: { missing: ImprintField[] }) {
  return (
    <div role="status" className="flex gap-3 rounded-xl border border-warn-soft-text/40 bg-warn-soft p-4 text-sm text-warn-soft-text">
      <AlertTriangle size={20} aria-hidden className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="font-semibold">Online-Buchung gesperrt: Impressumsangaben fehlen</p>
        <p className="mt-1">
          Es fehlen: {missing.map((f) => IMPRINT_FIELD_LABELS[f]).join(", ")}. Bis alles ausgefüllt ist, ist deine Buchungsseite für Patient:innen
          nicht erreichbar und der Knopf „Termin online buchen“ fehlt auf deiner Website.
        </p>
        <Link href="/einstellungen/praxis#impressum" className="mt-1 inline-flex min-h-11 items-center font-semibold underline underline-offset-2">
          Impressum ergänzen →
        </Link>
      </div>
    </div>
  );
}
