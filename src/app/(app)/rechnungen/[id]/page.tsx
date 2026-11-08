import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge, Card } from "@/components/ui";
import { PrintButton } from "@/components/print-button";
import { requireAuth } from "@/lib/auth/session";
import { dateDe, dateTimeDe, fullName, money } from "@/lib/format";
import { computeTotals } from "@/lib/invoice-math";
import {
  INTERNAL_NOTE_PREFIX,
  INVOICE_KIND_LABEL,
  INVOICE_STATUS_LABEL,
  INVOICE_STATUS_TONE,
  NOTE_NO_SHOW,
  NOTE_SMALL_BUSINESS,
  NOTE_VAT_EXEMPT,
  PAYMENT_METHOD_LABEL,
} from "@/lib/invoice-labels";
import { getInvoice } from "@/server/invoices";
import { CancelPanel, LexofficeButton, PaymentPanel } from "./invoice-actions";

export const metadata = { title: "Rechnung" };

const qty = (s: string) => Number(s).toLocaleString("de-DE", { maximumFractionDigits: 2 });

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
  const hasExempt = !o.smallBusiness && inv.kind !== "no_show_fee" && lines.some((l) => l.vatRate === 0);
  const publicNotes = (inv.notes ?? "")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith(INTERNAL_NOTE_PREFIX))
    .join("\n");
  const internalNotes = (inv.notes ?? "").split("\n").filter((l) => l.startsWith(INTERNAL_NOTE_PREFIX));

  const recipient = b
    ? { name: b.name, street: b.street, city: [b.zip, b.city].filter(Boolean).join(" "), care: p ? fullName(p) : null }
    : p
      ? { name: [p.salutation, fullName(p)].filter(Boolean).join(" "), street: p.street, city: [p.zip, p.city].filter(Boolean).join(" "), care: null }
      : { name: "–", street: null, city: "", care: null };
  const senderLine = [o.legalName ?? o.name, o.street, [o.zip, o.city].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
  const title =
    inv.kind === "credit_note"
      ? `Stornorechnung ${inv.number}`
      : `${INVOICE_KIND_LABEL[inv.kind]} ${inv.number}`;

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
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <PrintButton />
          {auth.can("invoices.write") && inv.status !== "draft" ? <LexofficeButton invoiceId={inv.id} /> : null}
          {canPay ? <PaymentPanel invoiceId={inv.id} openCents={open} /> : null}
          {canCancel && inv.number ? <CancelPanel invoiceId={inv.id} number={inv.number} /> : null}
          {p ? (
            <Link href={`/kunden/${p.id}`} className="inline-flex h-11 items-center px-3 text-sm font-semibold text-primary">
              Zur Kundenakte
            </Link>
          ) : null}
        </div>
        {internalNotes.length ? (
          <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-muted">
            {internalNotes.map((n) => n.slice(INTERNAL_NOTE_PREFIX.length)).join(" · ")}
          </p>
        ) : null}
      </div>

      <article className="invoice-sheet mx-auto max-w-[210mm] rounded-[var(--radius-card)] border border-border bg-surface p-6 text-[14px] leading-relaxed sm:p-10">
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
            {o.phone ? <p>Tel. {o.phone}</p> : null}
            {o.email ? <p>{o.email}</p> : null}
          </div>
        </header>

        <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted">{inv.kind === "receipt" ? "Quittungsnummer" : "Rechnungsnummer"}</dt>
            <dd className="font-semibold tabular-nums">{inv.number}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Datum</dt>
            <dd className="tabular-nums">{dateDe(inv.issuedAt)}</dd>
          </div>
          {p ? (
            <div>
              <dt className="text-xs text-muted">Kundennummer</dt>
              <dd className="tabular-nums">{p.number}</dd>
            </div>
          ) : null}
          {inv.kind !== "receipt" && inv.kind !== "credit_note" && inv.status !== "paid" ? (
            <div>
              <dt className="text-xs text-muted">Zahlbar bis</dt>
              <dd className="font-semibold tabular-nums">{dateDe(inv.dueAt)}</dd>
            </div>
          ) : null}
        </dl>

        <h2 className="mt-8 font-display text-2xl font-semibold">{title}</h2>
        {data.cancels ? <p className="text-muted">Storno der Rechnung {data.cancels.number}</p> : null}
        <p className="mt-1 text-muted">Leistungsdatum entspricht dem Rechnungsdatum, sofern nicht anders angegeben.</p>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-left [&_td]:border-b [&_td]:border-border [&_td]:py-2 [&_td]:pr-3 [&_th]:border-b-2 [&_th]:border-border-strong [&_th]:py-2 [&_th]:pr-3 [&_th]:text-xs [&_th]:font-semibold [&_th]:text-muted">
            <thead>
              <tr>
                <th>Pos.</th>
                <th>Leistung</th>
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
          {inv.paidCents !== 0 ? (
            <>
              <dt>{inv.kind === "credit_note" ? "erstattet/verrechnet" : "bezahlt"}</dt>
              <dd className="text-right tabular-nums">{money(inv.paidCents)}</dd>
            </>
          ) : null}
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
            {inv.kind === "receipt" && inv.status === "paid" ? <p className="mt-2 font-semibold">Betrag dankend erhalten.</p> : null}
          </section>
        ) : null}

        <section className="mt-6 flex flex-col gap-2 text-[13px]">
          {o.smallBusiness ? <p>{NOTE_SMALL_BUSINESS}</p> : null}
          {hasExempt ? <p>{NOTE_VAT_EXEMPT}</p> : null}
          {inv.kind === "no_show_fee" ? <p>{NOTE_NO_SHOW}</p> : null}
          {publicNotes ? <p className="whitespace-pre-line">{publicNotes}</p> : null}
          {inv.kind !== "receipt" && inv.kind !== "credit_note" && inv.status !== "paid" && o.iban ? (
            <p>
              Bitte überweisen Sie den Betrag bis zum <strong>{dateDe(inv.dueAt)}</strong> unter Angabe der Rechnungsnummer{" "}
              <strong>{inv.number}</strong> auf das unten genannte Konto.
            </p>
          ) : null}
        </section>

        <footer className="mt-10 grid gap-3 border-t border-border pt-4 text-[11px] text-muted sm:grid-cols-3">
          <div>
            <p className="font-semibold">{o.legalName ?? o.name}</p>
            <p>{o.street}</p>
            <p>{[o.zip, o.city].filter(Boolean).join(" ")}</p>
          </div>
          <div>
            {o.phone ? <p>Tel. {o.phone}</p> : null}
            {o.email ? <p>{o.email}</p> : null}
          </div>
          <div>
            {o.taxNumber ? <p>Steuernummer: {o.taxNumber}</p> : null}
            {o.vatId ? <p>USt-IdNr.: {o.vatId}</p> : null}
            {o.iban ? <p>IBAN: {o.iban.replace(/(.{4})/g, "$1 ").trim()}</p> : null}
          </div>
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
