import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileDown } from "lucide-react";
import QRCode from "qrcode";
import { Badge, Card } from "@/components/ui";
import { PortalLinkButton } from "@/components/portal-link-button";
import { PracticeLogo } from "@/components/practice-logo";
import { PrintButton } from "@/components/print-button";
import { isMockMode } from "@/integrations/registry";
import { fiscalIsTestMode } from "@/integrations/tse";
import { requireAuth } from "@/lib/auth/session";
import { dateDe, dateTimeDe, money } from "@/lib/format";
import { invoicePaymentQr, isValidIban } from "@/lib/epc-qr";
import { computeTotals } from "@/lib/invoice-math";
import {
  INVOICE_KIND_LABEL,
  INVOICE_STATUS_LABEL,
  INVOICE_STATUS_TONE,
  NOTE_DEPOSIT,
  NOTE_NO_SHOW,
  NOTE_SMALL_BUSINESS,
  NOTE_VAT_EXEMPT,
  PAYMENT_METHOD_LABEL,
} from "@/lib/invoice-labels";
import {
  formatIban,
  hasExemptNote,
  internalNotes as internalNoteLines,
  invoiceHeading,
  paymentNoteLines,
  invoiceRecipient,
  isReceiptLike,
  dueImmediately,
  dueLabel,
  paymentSummary,
  publicNotes as publicNoteText,
  qtyDe,
  senderLine as senderLineOf,
  showsDueDate,
} from "@/lib/invoice-view";
import { invoiceBookingLink, practiceWebsite, readDocumentSettings, shortUrl } from "@/lib/practice-documents";
import { loadConnection } from "@/server/integrations";
import { getInvoice } from "@/server/invoices";
import { CancelPanel, EmailInvoiceButton, LexofficeButton, PaymentPanel, SumupPanel } from "./invoice-actions";

export const metadata = { title: "Rechnung" };

const qty = qtyDe;

/** Druck: A4, Papierfarben unabhängig vom Dunkelmodus. */
const PRINT_CSS = `
@page { size: A4; margin: 14mm 16mm; }
@media print {
  main { padding: 0 !important; }
  .invoice-sheet { border: 0 !important; padding: 0 !important; max-width: none !important; }
  .invoice-sheet, .invoice-sheet * { color: #000 !important; background: transparent !important; border-color: #bbb !important; }
}`;

export default async function InvoicePage(props: PageProps<"/rechnungen/[id]">) {
  const { id } = await props.params;
  const auth = await requireAuth("invoices.read");
  const data = await getInvoice(auth, id);
  if (!data) notFound();
  const { invoice: inv, lines, organization: o, patient: p, billingContact: b } = data;

  const totals = computeTotals(lines);
  const open = inv.totalCents - inv.paidCents;
  const canPay = auth.can("invoices.write") && (inv.status === "issued" || inv.status === "partially_paid") && open !== 0;
  const canCancel = auth.can("invoices.write") && inv.kind !== "credit_note" && inv.status !== "cancelled" && inv.status !== "draft";
  const hasExempt = hasExemptNote(o, inv, lines);
  const publicNotes = publicNoteText(inv.notes);
  const internalNotes = internalNoteLines(inv.notes);
  const recipient = invoiceRecipient(p, b);
  const senderLine = senderLineOf(o);
  const { heading, serviceDateNote } = invoiceHeading(inv, data.serviceDates, dateDe, data.cancels?.number);
  const settings = (o.settings ?? {}) as Record<string, unknown>;
  const docSettings = readDocumentSettings(settings);
  const website = practiceWebsite(settings);
  const giro = isValidIban(o.iban) ? invoicePaymentQr(inv, o) : null;
  const booking = inv.kind !== "credit_note" ? invoiceBookingLink(settings, { slug: o.slug, publicUrl: process.env.PUBLIC_URL }) : null;
  // qrcode erzeugt reines SVG aus Pfaden (keine Eingabe-Texte im Markup)
  const qrSvg = (payload: string) => QRCode.toString(payload, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
  const qrBlocks = [
    ...(giro ? [{ key: "giro", title: "Bezahlen per GiroCode", sub: [`${money(open)} an ${o.accountHolder || o.legalName || o.name}`, `Verwendungszweck: Rechnung ${inv.number}`], svg: await qrSvg(giro) }] : []),
    ...(booking ? [{ key: "booking", title: booking.label, sub: [], svg: await qrSvg(booking.url) }] : []),
  ];
  const payNotes = paymentNoteLines(inv, data.payments, o, { dateDe, money }, { giroCode: !!giro });
  const canWrite = auth.can("invoices.write");
  const isOpen = (inv.status === "issued" || inv.status === "partially_paid") && open > 0;
  const sumupMock = canWrite && isOpen ? isMockMode(await loadConnection(o.id, "sumup")) : false;
  const recipientEmail = b?.email || p?.email || null;
  const linkChannels: { value: "email" | "sms" | "whatsapp"; label: string }[] = [];
  if (recipientEmail) linkChannels.push({ value: "email", label: `E-Mail (${recipientEmail})` });
  if (p?.phoneMobile) linkChannels.push({ value: "sms", label: "SMS" }, { value: "whatsapp", label: "WhatsApp (nur mit Einwilligung)" });

  return (
    <div className="mx-auto max-w-5xl">
      <style>{PRINT_CSS}</style>
      <div className="no-print mb-6 flex flex-col gap-4">
        <Link href="/rechnungen" className="inline-flex h-11 items-center gap-2 self-start text-sm font-semibold text-muted hover:text-text">
          <ArrowLeft size={18} aria-hidden /> Alle Rechnungen
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-3xl font-semibold tracking-tight">{inv.number ?? "Entwurf"}</h1>
          <Badge tone={INVOICE_STATUS_TONE[inv.status]}>{INVOICE_STATUS_LABEL[inv.status]}</Badge>
          <Badge tone="info">{INVOICE_KIND_LABEL[inv.kind]}</Badge>
          {data.cancelledBy ? (
            <Link href={`/rechnungen/${data.cancelledBy.id}`} className="text-sm font-semibold text-primary underline">
              storniert durch {data.cancelledBy.number}
            </Link>
          ) : null}
          {data.cancels ? (
            <Link href={`/rechnungen/${data.cancels.id}`} className="text-sm font-semibold text-primary underline">
              Storno zu {data.cancels.number}
            </Link>
          ) : null}
          {inv.kind === "deposit" ? (
            data.creditedTo && data.creditedTo.status !== "cancelled" ? (
              <Link href={`/rechnungen/${data.creditedTo.id}`} className="text-sm font-semibold text-primary underline">
                angerechnet auf {data.creditedTo.number}
              </Link>
            ) : inv.status === "paid" ? (
              <Badge tone="warn">noch nicht auf eine Sammelrechnung angerechnet</Badge>
            ) : null
          ) : null}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <PrintButton />
          {inv.status !== "draft" ? (
            <a
              href={`/api/invoices/${inv.id}/pdf`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 text-[15px] font-semibold hover:bg-surface-2"
            >
              <FileDown size={18} aria-hidden /> PDF
            </a>
          ) : null}
          {canWrite && inv.status !== "draft" ? (
            <EmailInvoiceButton invoiceId={inv.id} sentTo={inv.sentTo} sentAt={inv.sentAt ? dateTimeDe(inv.sentAt) : null} recipientEmail={recipientEmail} />
          ) : null}
          {canWrite && inv.status !== "draft" && inv.kind !== "deposit" ? <LexofficeButton invoiceId={inv.id} /> : null}
          {canPay ? <PaymentPanel invoiceId={inv.id} openCents={open} /> : null}
          {canCancel && inv.number ? <CancelPanel invoiceId={inv.id} number={inv.number} /> : null}
          {p && auth.can("patients.write") ? <PortalLinkButton patientId={p.id} /> : null}
          {p ? (
            <Link href={`/kunden/${p.id}`} className="inline-flex h-11 items-center px-3 text-sm font-semibold text-primary">
              Zur Patientenakte
            </Link>
          ) : null}
        </div>
        {internalNotes.length ? (
          <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-muted">{internalNotes.join(" · ")}</p>
        ) : null}
        {canPay && fiscalIsTestMode() ? (
          <p className="rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn-soft-text">
            Kasse/TSE im Testmodus: Barzahlungen erhalten nur eine Test-Signatur. Vor dem echten Bargeldeinsatz ist ein Vertrag mit einer
            zertifizierten TSE (z. B. fiskaly SIGN DE) und die Kassenmeldung ans Finanzamt Pflicht (KassenSichV, § 146a AO).
          </p>
        ) : null}
        {canWrite && isOpen ? <SumupPanel invoiceId={inv.id} paymentLinkUrl={inv.paymentLinkUrl} mock={sumupMock} channels={linkChannels} /> : null}
      </div>

      <article className="invoice-sheet mx-auto max-w-[210mm] rounded-[var(--radius-card)] border border-border bg-surface p-6 text-[14px] leading-relaxed sm:p-10">
        <div className="mb-6 flex justify-center">
          <PracticeLogo organizationId={o.id} kind={isReceiptLike(inv.kind) ? "compact" : "full"} alt={o.name} className={isReceiptLike(inv.kind) ? "h-14" : "h-24 max-w-[60%]"} />
        </div>
        <header className="flex flex-wrap justify-between gap-6">
          <div className="min-w-0 flex-1">
            <p className="mb-2 text-[11px] text-muted underline">{senderLine}</p>
            <address className="not-italic">
              <p className="font-semibold">{recipient.name}</p>
              {recipient.care ? <p>für {recipient.care}</p> : null}
              {recipient.street ? <p>{recipient.street}</p> : null}
              {recipient.city ? <p>{recipient.city}</p> : null}
            </address>
          </div>
          <div className="text-right">
            <p className="font-display text-lg font-semibold">{o.name}</p>
            {o.legalName && o.legalName !== o.name ? <p>{o.legalName}</p> : null}
            {o.street ? <p>{o.street}</p> : null}
            <p>{[o.zip, o.city].filter(Boolean).join(" ")}</p>
            {o.phone || o.email ? <p className="mt-2 text-xs text-muted underline">Terminvereinbarung</p> : null}
            {o.phone ? <p>Tel. {o.phone}{docSettings.whatsapp ? " (auch WhatsApp)" : ""}</p> : null}
            {o.email ? <p>{o.email}</p> : null}
          </div>
        </header>

        <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted">{isReceiptLike(inv.kind) ? "Quittungsnummer" : "Rechnungsnummer"}</dt>
            <dd className="font-semibold tabular-nums">{inv.number}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Datum</dt>
            <dd className="tabular-nums">{dateDe(inv.issuedAt)}</dd>
          </div>
          {p ? (
            <div>
              <dt className="text-xs text-muted">Patientennummer</dt>
              <dd className="tabular-nums">{p.number}</dd>
            </div>
          ) : null}
          {showsDueDate(inv) ? (
            <div>
              <dt className="text-xs text-muted">{dueImmediately(inv) ? "Zahlbar" : "Zahlbar bis"}</dt>
              <dd className="font-semibold tabular-nums">{dueLabel(inv, dateDe)}</dd>
            </div>
          ) : null}
        </dl>

        <h2 className="mt-8 font-display text-2xl font-semibold">{heading}</h2>
        {serviceDateNote ? <p className="mt-1 text-muted">{serviceDateNote}</p> : null}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-left [&_td]:border-b [&_td]:border-border [&_td]:py-2 [&_td]:pr-3 [&_th]:border-b-2 [&_th]:border-border-strong [&_th]:py-2 [&_th]:pr-3 [&_th]:text-xs [&_th]:font-semibold [&_th]:text-muted">
            <thead>
              <tr>
                <th>Pos.</th>
                <th>Leistung / Heilmittel</th>
                <th className="text-right">Menge</th>
                <th className="text-right">Faktor</th>
                <th className="text-right">Einzelpreis</th>
                <th className="text-right">USt</th>
                <th className="text-right">Gesamt</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.id}>
                  <td className="tabular-nums">{i + 1}</td>
                  <td>{l.description}</td>
                  <td className="text-right tabular-nums">{qty(l.quantity)}</td>
                  <td className="text-right tabular-nums">{qty(l.factor)}</td>
                  <td className="text-right tabular-nums">{money(l.unitPriceCents)}</td>
                  <td className="text-right tabular-nums">{l.vatRate} %</td>
                  <td className="text-right tabular-nums">{money(l.totalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <dl className="mt-4 ml-auto grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1">
          {totals.groups.map((g) => (
            <div key={g.rate} className="contents">
              <dt>Netto {g.rate} %</dt>
              <dd className="text-right tabular-nums">{money(g.netCents)}</dd>
              {g.rate ? (
                <>
                  <dt>USt {g.rate} %</dt>
                  <dd className="text-right tabular-nums">{money(g.vatCents)}</dd>
                </>
              ) : null}
            </div>
          ))}
          <dt className="border-t border-border-strong pt-1 font-semibold">Gesamtbetrag</dt>
          <dd className="border-t border-border-strong pt-1 text-right font-display text-lg font-bold tabular-nums">{money(inv.totalCents)}</dd>
          {paymentSummary(inv, data.deposits, dateDe).map((r) => (
            <div key={r.label} className="contents">
              <dt>{r.label}</dt>
              <dd className="text-right tabular-nums">{money(r.cents)}</dd>
            </div>
          ))}
          {inv.status !== "cancelled" && open !== 0 ? (
            <>
              <dt className="font-semibold">{open < 0 ? "zu erstatten" : "offen"}</dt>
              <dd className="text-right font-semibold tabular-nums">{money(Math.abs(open))}</dd>
            </>
          ) : null}
        </dl>

        {data.payments.length ? (
          <section className="mt-6">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Zahlungen</h3>
            <ul className="mt-1">
              {data.payments.map((pay) => (
                <li key={pay.id} className="flex justify-between gap-4 tabular-nums">
                  <span>
                    {dateTimeDe(pay.paidAt)} · {PAYMENT_METHOD_LABEL[pay.method]}
                    {pay.voucherCode ? ` ${pay.voucherCode}` : ""}
                  </span>
                  <span>{money(pay.amountCents)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="mt-6 flex flex-col gap-2 text-[13px]">
          {o.smallBusiness ? <p>{NOTE_SMALL_BUSINESS}</p> : null}
          {hasExempt ? <p>{NOTE_VAT_EXEMPT}</p> : null}
          {inv.kind === "no_show_fee" ? <p>{NOTE_NO_SHOW}</p> : null}
          {inv.kind === "deposit" ? <p>{NOTE_DEPOSIT}</p> : null}
          {publicNotes ? <p className="whitespace-pre-line">{publicNotes}</p> : null}
          {payNotes.map((n) => <p key={n}>{n}</p>)}
          {inv.kind !== "credit_note" && inv.status !== "cancelled" ? <p className="mt-2">Vielen Dank für Ihr Vertrauen</p> : null}
        </section>

        {qrBlocks.length ? (
          <section className="mt-6 grid gap-6 sm:grid-cols-2">
            {qrBlocks.map((q) => (
              <div key={q.key} className="flex items-center gap-3">
                <div className="size-28 shrink-0 bg-white" dangerouslySetInnerHTML={{ __html: q.svg }} />
                <div className="text-[13px]">
                  <p className="font-semibold">{q.title}</p>
                  {q.sub.map((x) => <p key={x} className="break-all text-muted">{x}</p>)}
                </div>
              </div>
            ))}
          </section>
        ) : null}

        <footer className="mt-10 grid gap-3 border-t border-border pt-4 text-[11px] text-muted sm:grid-cols-3">
          <div>
            <p className="font-semibold">{o.legalName ?? o.name}</p>
            <p>{o.street}</p>
            <p>{[o.zip, o.city].filter(Boolean).join(" ")}</p>
          </div>
          <div className="text-center">
            {o.phone ? <p>Tel. {o.phone}</p> : null}
            {website ? <p>{shortUrl(website)}</p> : o.email ? <p>{o.email}</p> : null}
          </div>
          <div>
            {o.iban ? <p>IBAN: {formatIban(o.iban)}</p> : null}
            {o.bic ? <p>BIC: {o.bic}</p> : null}
            {o.bankName ? <p>Bank: {o.bankName}</p> : null}
            {o.iban && (o.accountHolder || o.legalName) ? <p>Kontoinhaber: {o.accountHolder || o.legalName}</p> : null}
            {o.taxNumber ? <p>Steuernummer: {o.taxNumber}</p> : null}
            {o.vatId ? <p>USt-IdNr.: {o.vatId}</p> : null}
          </div>
          {docSettings.qualification ? <p className="text-center italic sm:col-span-3">{docSettings.qualification}</p> : null}
        </footer>
      </article>

      {data.payments.length === 0 && inv.status === "issued" ? (
        <Card className="no-print mx-auto mt-4 max-w-[210mm] text-sm text-muted">
          Noch keine Zahlung erfasst. Kartenzahlung über SumUp wird nach erfolgreicher Zahlung als „Karte (SumUp)“ gebucht.
        </Card>
      ) : null}
    </div>
  );
}
