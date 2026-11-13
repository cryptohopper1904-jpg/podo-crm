import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileText, Info, Receipt } from "lucide-react";
import { SOURCE, STATUS } from "@/components/appointment-row";
import { Badge, Card, CardTitle, LinkButton } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { durationMinutes } from "@/lib/appointment-edit";
import { berlinDateIso, dateDe, fullName, money, timeDe, weekdayLong } from "@/lib/format";
import { INVOICE_KIND_LABEL, INVOICE_STATUS_LABEL, INVOICE_STATUS_TONE } from "@/lib/invoice-labels";
import { billingFromSource } from "@/server/appointment-billing";
import { getAppointment, therapists } from "@/server/appointments";
import { RescheduleForm } from "./reschedule-form";

export const metadata = { title: "Termin" };

export default async function AppointmentPage(props: PageProps<"/kalender/termin/[id]">) {
  const { id } = await props.params;
  const auth = await requireAuth("appointments.read");
  const data = await getAppointment(auth, id);
  if (!data) notFound();
  const { appointment: a, patient, lock } = data;
  const canMove = auth.can("appointments.write") && !lock;
  const team = canMove ? await therapists(auth) : [];
  const billing = auth.can("invoices.write") && patient ? await billingFromSource(auth, { appointmentId: a.id }) : null;
  // offene Anzahlung zum Termin (bezahlt, noch nicht angerechnet): keine zweite Quittung, bei der Rechnung anrechnen
  const openDeposit = billing?.patient ? (billing.documents.find((d) => d.kind === "deposit" && d.status === "paid" && !d.collectiveInvoiceId) ?? null) : null;
  const st = STATUS[a.status];
  const date = berlinDateIso(a.startsAt);

  return (
    <div className="mx-auto max-w-4xl">
      <Link href={`/kalender?datum=${date}`} className="mb-4 inline-flex h-11 items-center gap-2 text-sm font-semibold text-muted hover:text-text">
        <ArrowLeft size={18} aria-hidden /> Kalender
      </Link>
      <header className="mb-6 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted">{weekdayLong(a.startsAt)} · {timeDe(a.startsAt)}–{timeDe(a.endsAt)} Uhr</p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">
            {patient ? <Link href={`/kunden/${patient.id}`} className="hover:text-primary">{fullName(patient)}</Link> : a.title ?? "Termin"}
          </h1>
        </div>
        <Badge tone="neutral">{SOURCE[a.source] ?? a.source}</Badge>
        {st ? <Badge tone={st.tone}>{st.label}</Badge> : null}
      </header>

      <Card className="mb-6">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Leistungen</dt>
            <dd className="mt-1">{data.services.length ? data.services.map((s) => `${s.code} · ${s.name}`).join(", ") : a.title ?? "–"}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Behandler:in</dt>
            <dd className="mt-1">{data.therapist ?? "–"}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Dauer</dt>
            <dd className="mt-1">{durationMinutes(a.startsAt, a.endsAt)} Minuten{a.homeVisit ? " · Hausbesuch" : ""}</dd>
          </div>
          {data.feed ? (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Herkunft</dt>
              <dd className="mt-1">Kalender-Abo „{data.feed.label}“</dd>
            </div>
          ) : null}
          {a.notes ? (
            <div className="sm:col-span-2">
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Notiz</dt>
              <dd className="mt-1 whitespace-pre-wrap">{a.notes}</dd>
            </div>
          ) : null}
        </dl>
      </Card>

      {auth.can("appointments.write") ? (
        <Card className="mb-6">
          <CardTitle>Datum und Uhrzeit ändern</CardTitle>
          {lock ? (
            <p className="flex gap-2 rounded-xl bg-info-soft p-3 text-sm text-info-soft-text">
              <Info size={18} className="mt-0.5 shrink-0" aria-hidden />
              <span>{lock.message}</span>
            </p>
          ) : (
            <RescheduleForm
              id={a.id}
              team={team.map((t) => ({ id: t.id, name: t.name }))}
              defaults={{ date, time: timeDe(a.startsAt), durationMin: durationMinutes(a.startsAt, a.endsAt), therapistId: [a.therapistId, auth.user.id].find((id) => team.some((t) => t.id === id)) ?? team[0]?.id ?? "" }}
            />
          )}
        </Card>
      ) : null}

      {billing && billing.patient ? (
        <Card>
          <CardTitle>Abrechnung</CardTitle>
          {billing.prescription ? (
            <p className="mb-3 rounded-xl bg-info-soft p-3 text-sm text-info-soft-text">
              Dieser Termin gehört zu einer Verordnung – die Leistung wird über die Krankenkasse abgerechnet (Verordnungen → Abrechnung). Eine Rechnung an die Patient:in nur für Zusatzleistungen.
            </p>
          ) : null}
          {billing.documents.length ? (
            <ul className="mb-4 flex flex-col gap-2">
              {billing.documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <Link href={`/rechnungen/${d.id}`} className="font-semibold text-primary hover:underline">{INVOICE_KIND_LABEL[d.kind]} {d.number}</Link>
                  <span className="text-muted">vom {dateDe(d.issuedAt)} · {money(d.totalCents)}</span>
                  <Badge tone={INVOICE_STATUS_TONE[d.status]}>{INVOICE_STATUS_LABEL[d.status]}</Badge>
                  {(d.kind === "deposit" || d.kind === "receipt") && d.status === "paid" && !d.collectiveInvoiceId ? (
                    <Badge tone="warn">kann in die Sammelrechnung übernommen werden</Badge>
                  ) : null}
                  {(d.kind === "deposit" || d.kind === "receipt") && d.collectiveInvoiceId && d.status !== "cancelled" ? <Badge tone="info">auf Sammelrechnung angerechnet</Badge> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-4 text-sm text-muted">Für diesen Termin gibt es noch keinen Beleg.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {billing.billedBy.length ? (
              <p className="w-full text-sm font-semibold">
                abgerechnet:{" "}
                {billing.billedBy.map((d, i) => (
                  <span key={d.id}>
                    {i ? ", " : ""}
                    <Link href={`/rechnungen/${d.id}`} className="text-primary hover:underline">{INVOICE_KIND_LABEL[d.kind]} {d.number}</Link>
                  </span>
                ))}
              </p>
            ) : openDeposit ? (
              <>
                <p className="w-full text-sm text-muted">
                  Bezahlt mit Anzahlung {openDeposit.number} – wird auf die Rechnung bzw. Sammelrechnung angerechnet (keine zweite Quittung).
                </p>
                <LinkButton href={`/rechnungen/neu?termin=${a.id}`}>
                  <FileText size={18} aria-hidden /> Rechnung erstellen (Anzahlung anrechnen)
                </LinkButton>
              </>
            ) : (
              <>
                <LinkButton href={`/rechnungen/neu?termin=${a.id}`}>
                  <FileText size={18} aria-hidden /> Rechnung erstellen
                </LinkButton>
                <LinkButton href={`/rechnungen/neu?termin=${a.id}&art=quittung`} variant="secondary">
                  <Receipt size={18} aria-hidden /> Quittung (sofort bezahlt)
                </LinkButton>
                <LinkButton href={`/rechnungen/anzahlung?termin=${a.id}`} variant="secondary">
                  <Receipt size={18} aria-hidden /> Quittung für Sammelrechnung
                </LinkButton>
              </>
            )}
          </div>
          {!billing.billedBy.length && !openDeposit ? (
            <p className="mt-3 text-xs text-muted">
              Rechnung: mit den Leistungen des Termins vorausgefüllt – weitere Positionen können Sie vor dem Ausstellen ergänzen. Quittung (sofort bezahlt) und Quittung für
              Sammelrechnung: Zahlung jetzt annehmen. Kann später in die Sammelrechnung übernommen werden – der Betrag wird dort als „bereits bezahlt“ angerechnet.
            </p>
          ) : null}
        </Card>
      ) : billing && billing.error ? (
        <Card><p className="text-sm text-muted">{billing.error}</p></Card>
      ) : null}
    </div>
  );
}
