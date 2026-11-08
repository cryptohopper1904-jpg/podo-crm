import { CalendarDays, FileText, Gift } from "lucide-react";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Card, Empty } from "@/components/ui";
import { requestMeta } from "@/lib/auth/session";
import { dateDe, money, timeDe, weekdayLong } from "@/lib/format";
import { INVOICE_KIND_LABEL } from "@/lib/invoice-labels";
import { loadPortalView, portalFailLimiter, portalLimiter, resolvePortalLink } from "@/server/portal-core";
import { CancelAppointmentButton } from "./cancel-button";

export const metadata = { title: "Kundenportal", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-4 py-6">
      <header className="flex items-center justify-between">
        <Logo />
        <ThemeToggle />
      </header>
      {children}
    </div>
  );
}

/**
 * Öffentliches Kundenportal (Link mit Token, 30 Tage gültig). Zeigt nur den Vornamen, künftige Termine,
 * offene Rechnungen (PDF) und Gutscheinguthaben – keine Befunde/Doku.
 */
export default async function PortalPage(props: PageProps<"/portal/[token]">) {
  const { token } = await props.params;
  const ip = (await requestMeta()).ip ?? "unbekannt";
  if (portalFailLimiter.exceeded(ip) || portalLimiter.limited(`view:${ip}`)) {
    return (
      <Shell>
        <Empty title="Zu viele Aufrufe">Bitte versuchen Sie es in einigen Minuten erneut.</Empty>
      </Shell>
    );
  }
  const link = await resolvePortalLink(token);
  const view = link ? await loadPortalView(link) : null;
  if (!link || !view) {
    portalFailLimiter.limited(ip);
    return (
      <Shell>
        <Empty title="Link ungültig oder abgelaufen">Bitte wenden Sie sich an Ihre Praxis, um einen neuen Link zu erhalten.</Empty>
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
        <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-semibold">
          <CalendarDays size={20} aria-hidden /> Ihre nächsten Termine
        </h2>
        {view.appointments.length === 0 ? (
          <p className="text-sm text-muted">Keine Termine geplant.{practice.phone ? ` Termin vereinbaren: ${practice.phone}` : ""}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {view.appointments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-semibold">{weekdayLong(a.startsAt)}, {timeDe(a.startsAt)} Uhr</p>
                  <p className="text-sm text-muted">{a.services.length ? a.services.join(", ") : "Termin"}</p>
                </div>
                {a.cancellable ? (
                  <CancelAppointmentButton token={token} appointmentId={a.id} label={`${dateDe(a.startsAt)}, ${timeDe(a.startsAt)} Uhr`} />
                ) : (
                  <p className="max-w-56 text-sm text-muted">Absage nur noch telefonisch{practice.phone ? `: ${practice.phone}` : ""}</p>
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
                  <p className="font-semibold">{INVOICE_KIND_LABEL[i.kind] ?? "Rechnung"} {i.number}</p>
                  <p className="text-sm text-muted">
                    vom {dateDe(i.issuedAt)} · offen {money(i.totalCents - i.paidCents)}{i.dueAt ? ` · fällig ${dateDe(i.dueAt)}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <a href={`/portal/${token}/rechnung/${i.id}`} className="inline-flex h-11 items-center rounded-xl border border-border bg-surface px-4 text-[15px] font-semibold hover:bg-surface-2">
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
        Dieser persönliche Link ist bis zu seinem Ablauf gültig. Bitte nicht weitergeben.
        {practice.phone ? ` Fragen? ${practice.phone}` : ""}{practice.email ? ` · ${practice.email}` : ""}
      </p>
    </Shell>
  );
}
