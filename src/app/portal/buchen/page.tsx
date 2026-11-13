import Link from "next/link";
import { Empty } from "@/components/ui";
import { requestMeta } from "@/lib/auth/session";
import { dateDe, timeDe } from "@/lib/format";
import { clientKey } from "@/lib/rate-limit";
import { portalBookingOptions } from "@/server/portal-booking";
import { currentPortalLink, portalFailLimiter, portalLimiter } from "@/server/portal-core";
import { PortalShell } from "../shell";
import { PortalBookingForm } from "./booking-form";

export const metadata = { title: "Termin buchen – Patientenportal", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

/**
 * Buchung bzw. Verschieben im Patientenportal (nur mit gültiger Portal-Sitzung).
 * Freie Zeiten der nächsten 6 Wochen; Regeln in src/lib/portal-booking.ts.
 */
export default async function PortalBookingPage(props: PageProps<"/portal/buchen">) {
  const sp = await props.searchParams;
  const rescheduleId = typeof sp.verschieben === "string" ? sp.verschieben : null;
  const key = clientKey(await requestMeta());
  if (portalFailLimiter.exceeded(key) || portalLimiter.limited(`view:${key}`)) {
    return (
      <PortalShell>
        <Empty title="Zu viele Aufrufe">Bitte versuchen Sie es in einigen Minuten erneut.</Empty>
      </PortalShell>
    );
  }
  const link = await currentPortalLink();
  const opts = link ? await portalBookingOptions(link, { rescheduleId }) : null;
  if (!link || !opts) {
    return (
      <PortalShell>
        <Empty title="Sitzung abgelaufen oder Link ungültig">Bitte öffnen Sie den persönlichen Link aus der Nachricht Ihrer Praxis erneut.</Empty>
      </PortalShell>
    );
  }
  const back = (
    <Link href="/portal" className="text-sm font-semibold text-primary hover:underline">
      ← Zurück zur Übersicht
    </Link>
  );
  return (
    <PortalShell>
      <div>
        {back}
        <p className="mt-3 text-sm text-muted">{opts.practice.name}</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight">{opts.reschedule ? "Termin verschieben" : "Termin buchen"}</h1>
        {opts.reschedule ? (
          <p className="mt-1 text-muted">
            Bisher: {dateDe(opts.reschedule.startsAt)}, {timeDe(opts.reschedule.startsAt)} Uhr{opts.reschedule.services.length ? ` · ${opts.reschedule.services.join(", ")}` : ""}
          </p>
        ) : null}
      </div>
      {opts.blocked ? (
        <Empty title="Online-Buchung nicht möglich">{opts.blocked}{!opts.blocked.includes("anrufen") && opts.practice.phone ? ` Telefon: ${opts.practice.phone}` : ""}</Empty>
      ) : (
        <PortalBookingForm
          services={opts.services}
          days={opts.days}
          reschedule={opts.reschedule ? { id: opts.reschedule.id, durationMin: opts.reschedule.durationMin } : null}
          phone={opts.practice.phone}
        />
      )}
    </PortalShell>
  );
}
