import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight, ClipboardList, FileText, Info, NotebookPen, Receipt, UserPlus } from "lucide-react";
import { SOURCE, STATUS } from "@/components/appointment-row";
import { Badge, Card, CardTitle, LinkButton, pageTitleBox, pageTitleCls, BackLink } from "@/components/ui";
import { StatusButtons } from "../../status-buttons";
import { requireAuth } from "@/lib/auth/session";
import { durationMinutes } from "@/lib/appointment-edit";
import { depositAllowed } from "@/lib/deposit-rules";
import { berlinDateIso, dateDe, fullName, money, timeDe, weekdayLong } from "@/lib/format";
import { INVOICE_KIND_LABEL, INVOICE_STATUS_LABEL, INVOICE_STATUS_TONE, RECEIPT_COLLECTIVE_HINT } from "@/lib/invoice-labels";
import { billingFromSource } from "@/server/appointment-billing";
import { getAppointment, therapists } from "@/server/appointments";
import { RescheduleForm } from "./reschedule-form";
import { backHref } from "@/lib/back-link";

export const metadata = { title: "Termin" };

/** Weitere Elternseiten eines Termins neben dem Kalender (Terminzeilen auf „Heute“ und „Behandlung“) */
const TERM_PARENTS = ["/heute", "/doku"] as const;
const termBack = (href: string) => ({ href, label: href.startsWith("/heute") ? "Heute" : href.startsWith("/doku") ? "Behandlung" : "Kalender" });

export default async function AppointmentPage(props: PageProps<"/kalender/termin/[id]">) {
  const { id } = await props.params;
  const { von } = await props.searchParams;
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
  // Künftiger Termin (ab morgen, nicht abgesagt, ohne Doku): nur Anzahlung (Vorauszahlung). Erbrachte Behandlungen
  // (heute/früher bzw. dokumentiert) bekommen Rechnung oder Quittung.
  const depositOk = depositAllowed({ appointmentDay: date, today: berlinDateIso(), hasRecord: !!(billing?.patient && billing.recordId), appointmentStatus: a.status });

  // Aktionsleiste (wie die Terminzeile): offener Termin → Doku (primär), Anamnese, Nicht da, Absagen;
  // erledigt und noch nicht abgerechnet → Quittung (primär; steht dann nicht noch einmal unter „Abrechnung“)
  const canEdit = auth.can("appointments.write");
  const open = a.status !== "cancelled" && a.status !== "done";
  const showDoc = auth.can("medical.write") && !!patient && open;
  const assign = canEdit && !!data.feed && !patient && a.status !== "cancelled";
  const showDrive = canEdit && !!patient && a.homeVisit && open;
  const showStatus = canEdit && open && !auth.readOnly;
  const showCancel = showStatus && !data.feed;
  const receiptFirst = !!billing?.patient && a.status === "done" && !billing.billedBy.length && !openDeposit && !depositOk;
  const name = patient ? fullName(patient) : (a.title ?? "Termin");
  const hasActions = showDoc || assign || showDrive || showStatus || receiptFirst;

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-6 flex flex-wrap items-end gap-3">
        <div className={pageTitleBox}>
          <BackLink {...termBack(backHref(`/kalender?datum=${date}`, von, TERM_PARENTS))} />
          <p className="text-sm text-muted">{weekdayLong(a.startsAt)} · {timeDe(a.startsAt)}–{timeDe(a.endsAt)} Uhr</p>
          <h1 className={pageTitleCls}>
            {patient ? (
              <Link href={`/kunden/${patient.id}`} className="group inline text-primary decoration-2 underline-offset-4 hover:underline" title="Akte öffnen">
                {name}
                <ArrowUpRight size={24} aria-hidden className="ml-1 inline-block align-[-0.1em] transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                <span className="sr-only"> – Akte öffnen</span>
              </Link>
            ) : (
              name
            )}
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone="neutral">{SOURCE[a.source] ?? a.source}</Badge>
          {st ? <Badge tone={st.tone}>{st.label}</Badge> : null}
        </div>
      </header>

      {hasActions ? (
        <nav aria-label="Aktionen zum Termin" className="mb-6 flex flex-wrap gap-2">
          {showDoc && patient ? (
            <>
              <LinkButton href={`/kunden/${patient.id}/doku/neu?termin=${a.id}`}>
                <NotebookPen size={18} aria-hidden /> Doku
              </LinkButton>
              <LinkButton variant="secondary" href={`/kunden/${patient.id}/anamnese/bogen?termin=${a.id}`} title="Anamnesebogen am iPad – Datum und Name sind vorausgefüllt">
                <ClipboardList size={18} aria-hidden /> Anamnese
              </LinkButton>
            </>
          ) : null}
          {receiptFirst ? (
            <LinkButton href={`/rechnungen/neu?termin=${a.id}&art=quittung`} title="Zahlung jetzt annehmen">
              <Receipt size={18} aria-hidden /> Quittung
            </LinkButton>
          ) : null}
          {assign ? (
            <LinkButton variant="secondary" href={`/kalender/zuordnen/${a.id}`}>
              <UserPlus size={18} aria-hidden /> Patient:in zuordnen
            </LinkButton>
          ) : null}
          {showDrive ? (
            <LinkButton variant="secondary" href={`/touren/losfahren?termin=${a.id}`}>
              Losfahren
            </LinkButton>
          ) : null}
          {showStatus ? (
            <StatusButtons
              id={a.id}
              label={`${timeDe(a.startsAt)} ${name}`}
              noShow
              cancel={showCancel}
              className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 text-[15px] font-semibold whitespace-nowrap text-text hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
          ) : null}
        </nav>
      ) : null}

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
            ) : openDeposit && depositOk ? (
              <p className="w-full text-sm text-muted">
                Anzahlung {openDeposit.number} erhalten – nach der Behandlung bei der Rechnung bzw. Sammelrechnung anrechnen.
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
            ) : depositOk ? (
              <LinkButton href={`/rechnungen/anzahlung?termin=${a.id}`} variant="secondary">
                <Receipt size={18} aria-hidden /> Anzahlung (Vorauszahlung)
              </LinkButton>
            ) : (
              <>
                <LinkButton href={`/rechnungen/neu?termin=${a.id}`} variant={receiptFirst ? "secondary" : "primary"}>
                  <FileText size={18} aria-hidden /> Rechnung erstellen
                </LinkButton>
                {/* erledigt: „Quittung“ steht schon oben in der Aktionsleiste */}
                {receiptFirst ? null : (
                  <LinkButton href={`/rechnungen/neu?termin=${a.id}&art=quittung`} variant="secondary">
                    <Receipt size={18} aria-hidden /> Quittung
                  </LinkButton>
                )}
              </>
            )}
          </div>
          {!billing.billedBy.length && !openDeposit ? (
            <p className="mt-3 text-xs text-muted">
              {depositOk
                ? "Der Termin liegt in der Zukunft – Rechnung oder Quittung gibt es nach der Behandlung. Anzahlung (Vorauszahlung): für Zahlungen vor der Behandlung, z. B. Nagelspange – wird später auf die Rechnung bzw. Sammelrechnung angerechnet."
                : `Rechnung: mit den Leistungen des Termins vorausgefüllt – weitere Positionen können Sie vor dem Ausstellen ergänzen. Quittung: Zahlung jetzt annehmen. ${RECEIPT_COLLECTIVE_HINT}`}
            </p>
          ) : null}
        </Card>
      ) : billing && billing.error ? (
        <Card><p className="text-sm text-muted">{billing.error}</p></Card>
      ) : null}
    </div>
  );
}
