import Link from "next/link";
import { hiddenAreaHint, type GkvArea } from "@/lib/features";

/** Hinweis bei Direktaufruf eines ausgeblendeten Kassen-Bereichs (Praxis nur für Privat-/Selbstzahler). */
export function HiddenAreaNotice({ area, settingsLink = true }: { area: GkvArea; settingsLink?: boolean }) {
  return (
    <p role="status" className="mb-4 rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">
      {hiddenAreaHint(area)}
      {settingsLink ? (
        <>
          {" "}
          <Link href="/einstellungen/praxis" className="font-semibold underline">Zu den Praxisdaten</Link>
        </>
      ) : null}
    </p>
  );
}
