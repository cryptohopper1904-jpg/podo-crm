import { CalendarDays, FileText, Gift } from "lucide-react";
import { Card, Empty, LinkButton } from "@/components/ui";
import { requestMeta } from "@/lib/auth/session";
import { dateDe, money, timeDe, weekdayLong } from "@/lib/format";
import { dueLabel } from "@/lib/invoice-view";
import { INVOICE_DOC_LABEL } from "@/lib/invoice-labels";
import { clientKey } from "@/lib/rate-limit";
import { currentPortalLink, loadPortalView, portalFailLimiter, portalLimiter } from "@/server/portal-core";
import { CancelAppointmentButton } from "./cancel-button";
import { PortalShell } from "./shell";

export const metadata = { title: "Patientenportal", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

const Shell = PortalShell;

/**
 * Öffentliches Patientenportal. Zugang nur über die kurzlebige Sitzung (Cookie), die beim Öffnen des
 * persönlichen Links /portal/<token> gesetzt wird. Zeigt nur Vorname, künftige Termine,
 * offene Rechnungen (PDF) und Gutscheinguthaben – keine Befunde/Doku.
 */
export default async function PortalPage() {
  const key = clientKey(await requestMeta());
  if (portalFailLimiter.exceeded(key) || portalLimiter.limited(`view:${key}`)) {
    return (
      <Shell>
        <Empty title="Zu viele Aufrufe">Bitte versuchen Sie es in einigen Minuten erneut.</Empty>
      </Shell>
    );
  }
  const link = await currentPortalLink();
  const view = link ? await loadPortalView(link) : null;
  if (!link || !view) {
    return (
      <Shell>
        {/* Ohne gültigen Link kennen wir die Praxis nicht – deshalb konkrete nächste Schritte statt Kontaktdaten */}
        <Empty title="Sitzung abgelaufen oder Link ungültig">
          <ol className="mx-auto mt-1 flex max-w-sm list-decimal flex-col gap-2 pl-5 text-left text-[15px]">
            <li>Öffnen Sie die Nachricht Ihrer Praxis erneut und tippen Sie auf Ihren persönlichen Link.</li>
            <li>Ist der Link abgelaufen, rufen Sie bitte Ihre Praxis an – dort erhalten Sie einen neuen.</li>
          </ol>
        </Empty>
      </Shell>
    );
  }
  const { practice } = view;

  return (
    <Shell>
      <div>
        <p className="text-sm text-muted">{practice.name}</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Hallo{view.firstName ? ` ${view.firstName}` : ""}!</h1>
      </div>

      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
            <CalendarDays size={20} aria-hidden /> Ihre nächsten Termine
          </h2>
          <LinkButton href="/portal/buchen">Termin buchen</LinkButton>
        </div>
        {view.appointments.length === 0 ? (
          <p className="text-sm text-muted">Keine Termine geplant.{practice.phone ? ` Oder telefonisch: ${practice.phone}` : ""}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {view.appointments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-semibold">{weekdayLong(a.startsAt)}, {timeDe(a.startsAt)} Uhr</p>
                  <p className="text-sm text-muted">{a.services.length ? a.services.join(", ") : "Termin"}</p>
                </div>
                {a.cancellable ? (
                  <div className="flex flex-wrap items-start gap-2">
                    <LinkButton href={`/portal/buchen?verschieben=${a.id}`} variant="secondary">Verschieben</LinkButton>
                    <CancelAppointmentButton appointmentId={a.id} label={`${dateDe(a.startsAt)}, ${timeDe(a.startsAt)} Uhr`} />
                  </div>
                ) : (
                  <p className="max-w-56 text-sm text-muted">Absage/Verschieben nur noch telefonisch{practice.phone ? `: ${practice.phone}` : ""}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-semibold">
          <FileText size={20} aria-hidden /> Offene Rechnungen
        </h2>
        {view.invoices.length === 0 ? (
          <p className="text-sm text-muted">Keine offenen Rechnungen.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {view.invoices.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-semibold">{INVOICE_DOC_LABEL[i.kind] ?? "Rechnung"} {i.number}</p>
                  <p className="text-sm text-muted">
                    vom {dateDe(i.issuedAt)} · offen {money(i.totalCents - i.paidCents)}{i.dueAt ? ` · fällig ${dueLabel(i, dateDe)}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <a href={`/portal/rechnung/${i.id}`} className="inline-flex h-11 items-center rounded-xl border border-border bg-surface px-4 text-[15px] font-semibold hover:bg-surface-2">
                    PDF
                  </a>
                  {i.paymentLinkUrl ? (
                    <a href={i.paymentLinkUrl} target="_blank" rel="noreferrer noopener" className="inline-flex h-11 items-center rounded-xl bg-primary px-4 text-[15px] font-semibold text-on-primary hover:bg-primary-hover">
                      Online bezahlen
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {view.vouchers.length ? (
        <Card>
          <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-semibold">
            <Gift size={20} aria-hidden /> Gutscheine
          </h2>
          <ul className="flex flex-col divide-y divide-border">
            {view.vouchers.map((v) => (
              <li key={v.code} className="flex justify-between gap-3 py-2">
                <span>{v.code} <span className="text-sm text-muted">· gültig bis {dateDe(v.validUntil)}</span></span>
                <span className="font-semibold tabular-nums">{money(v.balanceCents)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <p className="text-xs text-muted">
        Ihre Sitzung endet nach spätestens 2 Stunden; den persönlichen Link können Sie bis zu seinem Ablauf erneut öffnen. Bitte nicht weitergeben.
        {practice.phone ? ` Fragen? ${practice.phone}` : ""}{practice.email ? ` · ${practice.email}` : ""}
      </p>
    </Shell>
  );
}
