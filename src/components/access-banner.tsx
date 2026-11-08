import Link from "next/link";
import type { AuthContext } from "@/lib/auth/session";
import { dateDe, timeDe } from "@/lib/format";
import { READONLY_REASON_LABELS } from "@/lib/plans";
import { exitSupportAction } from "@/app/(app)/plattform/actions";

/** Hinweisleiste im App-Layout: Support-Zugriff (rot), Nur-Lesen-Modus, Zahlung offen, Testphase. */
export function AccessBanner({ auth }: { auth: AuthContext }) {
  if (auth.support) {
    return (
      <div role="alert" className="no-print flex flex-wrap items-center gap-3 border-b-2 border-danger bg-accent-soft px-4 py-2.5 text-sm font-semibold text-danger lg:px-8">
        <span className="flex-1">
          Support-Zugriff ({auth.support.scope === "write" ? "lesen + Konfiguration" : "nur lesen"}) – endet um {timeDe(auth.support.expiresAt)}
          {dateDe(auth.support.expiresAt) !== dateDe(new Date()) ? ` am ${dateDe(auth.support.expiresAt)}` : ""} · Jede Ansicht wird im Protokoll der Praxis vermerkt.
        </span>
        <form action={exitSupportAction}>
          <button type="submit" className="rounded-lg border border-danger px-3 py-1 text-danger hover:bg-surface">Support beenden</button>
        </form>
      </div>
    );
  }
  const owner = auth.role === "owner";
  const a = auth.access;
  if (a.mode === "readonly") {
    return (
      <div role="status" className="no-print flex flex-wrap items-center gap-3 bg-accent-soft px-4 py-2.5 text-sm font-medium text-accent-soft-text lg:px-8">
        <span className="flex-1">
          <strong>Nur-Lesen-Modus:</strong> {READONLY_REASON_LABELS[a.reason]} Alle Daten bleiben lesbar und exportierbar; Änderungen sind gesperrt.
        </span>
        {owner ? <Link href="/einstellungen/abo" className="font-semibold underline">Tarif wählen</Link> : null}
      </div>
    );
  }
  if (a.graceEndsAt) {
    return (
      <div role="status" className="no-print flex flex-wrap items-center gap-3 bg-warn-soft px-4 py-2.5 text-sm font-medium text-warn-soft-text lg:px-8">
        <span className="flex-1">Zahlung offen – ohne Zahlung wechselt die Praxis am {dateDe(a.graceEndsAt)} in den Nur-Lesen-Modus.</span>
        {owner ? <Link href="/einstellungen/abo" className="font-semibold underline">Zahlung prüfen</Link> : null}
      </div>
    );
  }
  if (a.trialDaysLeft !== undefined) {
    return (
      <div role="status" className="no-print flex flex-wrap items-center gap-3 bg-info-soft px-4 py-2 text-sm text-info-soft-text lg:px-8">
        <span className="flex-1">Testphase: noch {a.trialDaysLeft} {a.trialDaysLeft === 1 ? "Tag" : "Tage"} mit allen Funktionen.</span>
        {owner ? <Link href="/einstellungen/abo" className="font-semibold underline">Tarif wählen</Link> : null}
      </div>
    );
  }
  return null;
}
