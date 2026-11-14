import Link from "next/link";
import { notFound } from "next/navigation";
import { FileDown } from "lucide-react";
import QRCode from "qrcode";
import { Badge, Card, BackLink, pageTitleCls } from "@/components/ui";
import { PortalLinkButton } from "@/components/portal-link-button";
import { PracticeLogo } from "@/components/practice-logo";
import { PrintButton } from "@/components/print-button";
import { isMockMode } from "@/integrations/registry";
import { fiscalIsTestMode } from "@/integrations/tse";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, dateDe, dateTimeDe, money } from "@/lib/format";
import { invoicePaymentQr, isValidIban } from "@/lib/epc-qr";
import { computeTotals } from "@/lib/invoice-math";
import { cssString } from "@/lib/css-string";
import {
  INVOICE_KIND_LABEL,
  INVOICE_STATUS_LABEL,
  INVOICE_STATUS_TONE,
  NOTE_DEPOSIT,
  NOTE_NO_SHOW,
  vatExemptNote,
  PAYMENT_METHOD_LABEL,
} from "@/lib/invoice-labels";
import {
  creditedReceiptsBlock,
  creditedReceiptsNote,
  serviceYear,
  formatIban,
  hasExemptNote,
  internalNotes as internalNoteLines,
  invoiceAsIssued,
  invoiceHeading,
  invoiceService,
  openSumRow,
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
import { shortUrl } from "@/lib/practice-documents";
import { CANCELLATION_SUB, cancellationStamp } from "@/lib/invoice-pdf";
import { TSE_TEST_NOTICE, tseLines } from "@/lib/tse-receipt";
import { RETENTION_HEMMUNG_NOTE } from "@/lib/retention";
import { loadConnection } from "@/server/integrations";
import { getInvoice } from "@/server/invoices";
import { invoiceDunningList } from "@/server/dunning";
import { DUNNING_STAGE_LABEL, dunningTotalCents, isDunnable, type DunningStage } from "@/lib/dunning";
import { DunningLetterActions } from "../mahnungen/dunning-actions";
import { CancelPanel, EmailInvoiceButton, EmailPaymentReceiptButton, LexofficeButton, PaymentPanel, ReceiptLinks, SumupPanel } from "./invoice-actions";
import { backHref } from "@/lib/back-link";

export const metadata = { title: "Rechnung" };

const qty = qtyDe;

/** Vermerk auf Entwürfen (Seite und Druck) */
const DRAFT_NOTICE = "ENTWURF – kein gültiger Beleg";

/**
 * Druck: immer DIN A4 mit festen Rändern, Papierfarben unabhängig vom Dunkelmodus. Mehrseitig: Tabellenkopf
 * wiederholt sich, Zeilen sowie Summen-, Quittungs-, Zahlungs- und Hinweisblock werden nicht getrennt;
 * Seitenrand-Boxen (Chromium ab 131; andere Browser lassen sie weg – das PDF hat sie immer): Seitenzahl unten rechts,
 * auf Folgeseiten oben rechts Belegart und Nr.; Entwürfe tragen auf jeder Seite oben links den Entwurfsvermerk.
 */
const printCss = (runningHead: string, draft: boolean) => `
@page {
  size: A4;
  margin: 15mm 17mm 18mm 20mm;
  @top-right { content: ${cssString(runningHead)} " – Seite " counter(page) " von " counter(pages); font: 8pt Helvetica, Arial, sans-serif; color: #555; }
  ${draft ? `@top-left { content: ${cssString(DRAFT_NOTICE)}; font: bold 9pt Helvetica, Arial, sans-serif; color: #000; }` : ""}
  @bottom-right { content: "Seite " counter(page) " von " counter(pages); font: 7.5pt Helvetica, Arial, sans-serif; color: #666; }
}
/* Kopfzeile (Belegart, Nr., Seite) nur auf Folgeseiten – Seite 1 trägt den Briefkopf */
@page :first { @top-right { content: none; } }
@media print {
  main { padding: 0 !important; }
  .invoice-sheet { border: 0 !important; border-radius: 0 !important; padding: 0 !important; max-width: none !important; width: auto !important; }
  .invoice-sheet, .invoice-sheet * { color: #000 !important; background: transparent !important; border-color: #bbb !important; }
  .invoice-sheet .print-table-wrap { overflow: visible !important; }
  .invoice-sheet table { min-width: 0 !important; }
  .invoice-sheet thead { display: table-header-group; }
  .invoice-sheet tr, .invoice-sheet .print-keep { break-inside: avoid; page-break-inside: avoid; }
  .invoice-sheet h2 { break-after: avoid; page-break-after: avoid; }
  .invoice-sheet .draft-notice { border-color: #000 !important; }
  .invoice-sheet .cancel-stamp, .invoice-sheet .cancel-stamp * { color: #b00 !important; border-color: #b00 !important; }
}`;

export default async function InvoicePage(props: PageProps<"/rechnungen/[id]">) {
  const { id } = await props.params;
  const { von, beleg } = await props.searchParams;
  const auth = await requireAuth("invoices.read");
  const data = await getInvoice(auth, id);
  if (!data) notFound();
  const { invoice: inv, lines, organization: o, patient: p, billingContact: b } = data;

  const isDraft = inv.status === "draft" || !inv.number;
  const kindLabel = INVOICE_KIND_LABEL[inv.kind] ?? "Rechnung";
  const runningHead = inv.number ? `${kindLabel} Nr. ${inv.number}` : `${kindLabel} – Entwurf`;
  const totals = computeTotals(lines);
  const open = inv.totalCents - inv.paidCents;
  const canPay = auth.can("invoices.write") && (inv.status === "issued" || inv.status === "partially_paid") && open !== 0;
  const canCancel = auth.can("invoices.write") && inv.kind !== "credit_note" && inv.status !== "cancelled" && inv.status !== "draft";
  // Beleg (Druckansicht) im Stand der Ausstellung: spätere Zahlungen ändern ihn nicht (GoBD, § 14 UStG) – sie stehen
  // darunter außerhalb des Belegs. Status/Badge/„Zahlung erfassen“ oben zeigen den aktuellen Stand.
  // Stornierte Rechnung: Beleg wie ausgestellt (Zahlungsaufforderung usw.) mit Stornovermerk, ohne GiroCode
  const cancelledOriginal = inv.status === "cancelled" && inv.kind !== "credit_note";
  const { invoice: doc, payments: docPayments, laterPayments } = invoiceAsIssued(cancelledOriginal ? { ...inv, status: "issued" as const } : inv, data.payments);
  const docOpen = doc.totalCents - doc.paidCents;
  const docOpenRow = openSumRow(doc);
  const hasExempt = hasExemptNote(o, inv, lines);
  const publicNotes = publicNoteText(inv.notes);
  const internalNotes = internalNoteLines(inv.notes);
  const recipient = invoiceRecipient(p, b);
  const senderLine = senderLineOf(o);
  const { heading, serviceDateNote } = invoiceHeading(inv, invoiceService(data), dateDe);
  // Website, Berufsbezeichnung, WhatsApp-Hinweis, Buchungshinweis wie beim Ausstellen (Momentaufnahme)
  const docSettings = data.letter;
  const website = data.letter.website;
  const giro = !cancelledOriginal && isValidIban(o.iban) ? invoicePaymentQr(doc, o) : null;
  const booking = inv.kind !== "credit_note" ? data.booking : null;
  // qrcode erzeugt reines SVG aus Pfaden (keine Eingabe-Texte im Markup)
  const qrSvg = (payload: string) => QRCode.toString(payload, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
  const qrBlocks = [
    ...(giro ? [{ key: "giro", title: "Bezahlen per GiroCode", sub: [`${money(docOpen)} an ${o.accountHolder || o.legalName || o.name}`, `Verwendungszweck: Rechnung ${inv.number}`], svg: await qrSvg(giro) }] : []),
    ...(booking ? [{ key: "booking", title: booking.label, sub: [], svg: await qrSvg(booking.url) }] : []),
  ];
  const payNotes = paymentNoteLines(doc, docPayments, o, { dateDe, money }, { giroCode: !!giro });
  const receiptBlock = creditedReceiptsBlock(data.credited);
  const canWrite = auth.can("invoices.write");
  const isOpen = (inv.status === "issued" || inv.status === "partially_paid") && open > 0;
  const sumupMock = canWrite && isOpen ? isMockMode(await loadConnection(o.id, "sumup")) : false;
  const recipientEmail = b?.email || p?.email || null;
  // nach „Zahlung erfassen“ (?beleg=<id,…>): die eben erzeugten Zahlungsbelege oben anbieten
  const belegIds = new Set((typeof beleg === "string" ? beleg : "").split(",").filter(Boolean));
  const freshReceipts = data.paymentReceipts.filter((r) => belegIds.has(r.id));
  const dunnings = await invoiceDunningList(auth, inv.id);
  const linkChannels: { value: "email" | "sms" | "whatsapp"; label: string }[] = [];
  if (recipientEmail) linkChannels.push({ value: "email", label: `E-Mail (${recipientEmail})` });
  if (p?.phoneMobile) linkChannels.push({ value: "sms", label: "SMS" }, { value: "whatsapp", label: "WhatsApp (nur mit Einwilligung)" });

  return (
    <div className="mx-auto max-w-5xl">
      <style>{printCss(runningHead, isDraft)}</style>
      <div className="no-print mb-6 flex flex-col gap-4">
        <BackLink href={backHref("/rechnungen", von)} label="Rechnungen" className="-mb-4 self-start" />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className={pageTitleCls}>{inv.number ?? "Entwurf"}</h1>
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
          {inv.kind === "receipt" && data.creditedTo && data.creditedTo.status !== "cancelled" ? (
            <Link href={`/rechnungen/${data.creditedTo.id}`} className="text-sm font-semibold text-primary underline">
              angerechnet auf Sammelrechnung {data.creditedTo.number}
            </Link>
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
          {cancelledOriginal && data.archive ? (
            <a
              href={`/api/invoices/${inv.id}/pdf?original=1`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 text-[15px] font-semibold hover:bg-surface-2"
            >
              <FileDown size={18} aria-hidden /> Original (Archiv)
            </a>
          ) : null}
          {canWrite && inv.status !== "draft" ? (
            <EmailInvoiceButton invoiceId={inv.id} sentTo={inv.sentTo} sentAt={inv.sentAt ? dateTimeDe(inv.sentAt) : null} recipientEmail={recipientEmail} />
          ) : null}
          {canWrite && inv.status !== "draft" && inv.kind !== "deposit" ? <LexofficeButton invoiceId={inv.id} /> : null}
          {canPay ? <PaymentPanel invoiceId={inv.id} openCents={open} /> : null}
          {canCancel && inv.number ? <CancelPanel invoiceId={inv.id} number={inv.number} productLines={lines.filter((l) => !!l.productId).map((l) => ({ id: l.id, description: l.description, quantity: String(l.quantity).replace(/\.00$/, "").replace(".", ","), inTreatment: l.inTreatment }))} /> : null}
          {p && auth.can("patients.write") ? <PortalLinkButton patientId={p.id} /> : null}
          {p ? (
            <Link href={`/kunden/${p.id}`} className="inline-flex h-11 items-center px-3 text-sm font-semibold text-primary">
              Zur Patientenakte
            </Link>
          ) : null}
        </div>
        {freshReceipts.length ? (
          <Card className="w-full border-2 border-primary" role="status">
            <h2 className="mb-1 font-display text-lg font-semibold">Zahlung erfasst – Zahlungsbeleg aushändigen</h2>
            <p className="mb-3 text-sm text-muted">
              Beleg über den Zahlungseingang (Kassenbeleg, § 146a Abs. 2 AO): drucken, als PDF speichern oder per E-Mail senden.
            </p>
            <ReceiptLinks invoiceId={inv.id} receipts={freshReceipts.map((r) => ({ id: r.id, number: r.number }))} recipientEmail={canWrite ? recipientEmail : null} />
          </Card>
        ) : null}
        {internalNotes.length ? (
          <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-muted">{internalNotes.join(" · ")}</p>
        ) : null}
        {inv.status !== "draft" ? (
          <p className="text-xs text-muted">
            {data.archive
              ? `Beleg-Archiv: Original vom ${dateTimeDe(data.archive.createdAt)} (SHA-256 ${data.archive.sha256.slice(0, 16)}…), aufzubewahren mindestens bis ${dateDe(data.archive.retainUntil)} (8 Jahre ab Ende des Ausstellungsjahres, ${RETENTION_HEMMUNG_NOTE}). ${cancelledOriginal ? "„PDF“ ist der Neudruck mit Stornovermerk." : "„PDF“ liefert genau dieses Original."}`
              : "Altbeleg ohne archiviertes Original – das PDF wird aus den gespeicherten Daten neu erzeugt und als „Reproduktion“ gekennzeichnet."}
            {data.fromSnapshot ? "" : " Belegangaben (Praxis, Anschrift) aus den aktuellen Stammdaten."}
          </p>
        ) : null}
        {canPay && fiscalIsTestMode() ? (
          <p className="rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn-soft-text">
            Kasse/TSE im Testmodus: Barzahlungen erhalten nur eine Test-Signatur. Vor dem echten Bargeldeinsatz ist ein Vertrag mit einer
            zertifizierten TSE (z. B. fiskaly SIGN DE) und die Kassenmeldung ans Finanzamt Pflicht (KassenSichV, § 146a AO). Zahlungen auf
            bereits ausgestellte Rechnungen werden derzeit als Umsatz erfasst; vor Echtbetrieb mit Steuerberatung abstimmen.
          </p>
        ) : null}
        {dunnings.length || (isDunnable(inv) && open > 0 && inv.dueAt && inv.dueAt < berlinDateIso()) ? (
          <Card className="w-full">
            <h2 className="mb-1 font-display text-lg font-semibold">Mahnungen</h2>
            {dunnings.length ? (
              <ol className="flex flex-col gap-4">
                {dunnings.map((d) => (
                  <li key={d.id} className="flex flex-col gap-2 border-l-2 border-border pl-3">
                    <p className="text-sm">
                      <span className="font-semibold">{DUNNING_STAGE_LABEL[d.stage as DunningStage]}</span> vom {dateDe(d.letterDate)} · offen {money(d.openCents)}
                      {d.feeCents ? ` + Gebühr ${money(d.feeCents)}` : ""} · zu zahlen {money(dunningTotalCents(d.openCents, d.feesTotalCents))} bis {dateDe(d.payBy)}
                      <span className="block text-xs text-muted">
                        {d.sentVia === "email" ? `per E-Mail an ${d.sentTo} am ${dateTimeDe(d.sentAt!)}` : d.sentVia === "post" ? `per Post versendet (vermerkt am ${dateTimeDe(d.sentAt!)})` : "noch nicht versendet"}
                      </span>
                    </p>
                    <DunningLetterActions dunningId={d.id} recipientEmail={recipientEmail} canWrite={canWrite && isOpen} sent={!!d.sentVia} />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted">Noch keine Zahlungserinnerung erstellt.</p>
            )}
            {isOpen ? (
              <Link href="/rechnungen/mahnungen" className="mt-3 inline-flex h-11 items-center text-sm font-semibold text-primary underline">Zur Mahnübersicht</Link>
            ) : dunnings.length ? (
              <p className="mt-3 text-sm text-muted">Rechnung bezahlt oder storniert – keine weiteren Mahnstufen.</p>
            ) : null}
          </Card>
        ) : null}
        {canWrite && isOpen ? <SumupPanel invoiceId={inv.id} paymentLinkUrl={inv.paymentLinkUrl} mock={sumupMock} channels={linkChannels} /> : null}
      </div>

      <article className="invoice-sheet mx-auto max-w-[210mm] rounded-[var(--radius-card)] border border-border bg-surface p-6 text-[14px] leading-relaxed sm:p-10">
        {isDraft ? (
          <p role="note" className="draft-notice mb-6 rounded border-2 border-dashed border-danger px-3 py-2 text-center text-base font-bold tracking-wide text-danger">
            {DRAFT_NOTICE}
          </p>
        ) : null}
        {cancelledOriginal ? (
          <div role="note" className="cancel-stamp mb-6 rounded border-2 border-danger px-3 py-2 text-danger">
            <p className="text-base font-bold tracking-wide">{cancellationStamp({ number: data.cancelledBy?.number ?? null, issuedAt: data.cancelledBy?.issuedAt ?? null })}</p>
            <p className="text-sm">{CANCELLATION_SUB}</p>
          </div>
        ) : null}
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
          {showsDueDate(doc) ? (
            <div>
              <dt className="text-xs text-muted">{dueImmediately(inv) ? "Zahlbar" : "Zahlbar bis"}</dt>
              <dd className="font-semibold tabular-nums">{dueLabel(inv, dateDe)}</dd>
            </div>
          ) : null}
        </dl>

        <h2 className="mt-8 font-display text-2xl font-semibold">{heading}</h2>
        {serviceDateNote ? <p className="mt-1 text-muted">{serviceDateNote}</p> : null}

        <div className="print-table-wrap mt-4 overflow-x-auto">
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

        <dl className="print-keep mt-4 ml-auto grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1">
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
          {paymentSummary(doc, data.credited, dateDe, totals.groups).map((r) => (
            <div key={r.label} className="contents">
              <dt>{r.label}</dt>
              <dd className="text-right tabular-nums">{money(r.cents)}</dd>
            </div>
          ))}
          {docOpenRow ? (
            <>
              <dt className="font-semibold">{docOpenRow.label}</dt>
              <dd className="text-right font-semibold tabular-nums">{money(docOpenRow.cents)}</dd>
            </>
          ) : null}
        </dl>

        {receiptBlock.rows.length ? (
          <section className="print-keep mt-6">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Bereits bezahlt (Quittungen)</h3>
            <table className="mt-1 w-full max-w-xl text-sm">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1 font-medium">Nummer</th>
                  <th className="py-1 font-medium">Datum</th>
                  <th className="py-1 text-right font-medium">Betrag</th>
                  <th className="py-1 text-right font-medium">darin USt</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {receiptBlock.rows.map((r) => (
                  <tr key={r.number}>
                    <td className="py-0.5">{r.number}</td>
                    <td className="py-0.5">{dateDe(r.issuedAt)}</td>
                    <td className="py-0.5 text-right">{money(r.totalCents)}</td>
                    <td className="py-0.5 text-right">{money(r.vatCents)}</td>
                  </tr>
                ))}
                <tr className="border-t border-border font-semibold">
                  <td className="py-0.5" colSpan={2}>Summe ({receiptBlock.rows.length})</td>
                  <td className="py-0.5 text-right">{money(receiptBlock.totalCents)}</td>
                  <td className="py-0.5 text-right">{money(receiptBlock.vatCents)}</td>
                </tr>
                <tr>
                  <td className="py-0.5" colSpan={2}>Offener Restbetrag</td>
                  <td className="py-0.5 text-right">{money(doc.status === "cancelled" ? 0 : docOpen)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </section>
        ) : null}

        {docPayments.length ? (
          <section className="print-keep mt-6">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Zahlungen</h3>
            <ul className="mt-1">
              {docPayments.map((pay) => (
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

        {docPayments.filter((pay) => pay.fiscal).map((pay) => (
          <section key={`tse-${pay.id}`} className="print-keep mt-4 text-[11px]">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">TSE-Angaben{docPayments.filter((x) => x.fiscal).length > 1 ? ` (${PAYMENT_METHOD_LABEL[pay.method]}, ${money(pay.amountCents)})` : ""}</h3>
            {pay.fiscal!.isTest ? <p className="font-semibold text-danger">{TSE_TEST_NOTICE}</p> : null}
            <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-4">
              {tseLines(pay.fiscal!).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="break-all tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}

        <section className="print-keep mt-6 flex flex-col gap-2 text-[13px]">
          {o.smallBusiness ? <p>{data.smallBusinessNote}</p> : null}
          {hasExempt ? <p>{vatExemptNote(lines)}</p> : null}
          {inv.kind === "no_show_fee" ? <p>{NOTE_NO_SHOW}</p> : null}
          {inv.kind === "deposit" ? <p>{NOTE_DEPOSIT}</p> : null}
          {receiptBlock.rows.length ? <p>{creditedReceiptsNote(serviceYear(data.serviceDates, inv.issuedAt))}</p> : null}
          {publicNotes ? <p className="whitespace-pre-line">{publicNotes}</p> : null}
          {payNotes.map((n) => <p key={n}>{n}</p>)}
          {doc.kind !== "credit_note" && doc.status !== "cancelled" ? <p className="mt-2">Vielen Dank für Ihr Vertrauen</p> : null}
        </section>

        {qrBlocks.length ? (
          <section className="print-keep mt-6 grid gap-6 sm:grid-cols-2">
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

        <footer className="print-keep mt-10 grid gap-3 border-t border-border pt-4 text-[11px] text-muted sm:grid-cols-3">
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

      {laterPayments.length ? (
        <Card className="no-print mx-auto mt-4 max-w-[210mm] text-sm">
          <h2 className="font-display text-base font-semibold">Zahlungseingang nach Ausstellung</h2>
          <ul className="mt-2 flex flex-col gap-1">
            {laterPayments.map((pay) => {
              const receipt = data.paymentReceipts.find((r) => r.paymentId === pay.id);
              return (
                <li key={pay.id} className="flex flex-col gap-2 border-b border-border pb-2 last:border-0">
                  <div className="flex justify-between gap-4 tabular-nums">
                    <span>
                      {pay.amountCents < 0 ? "Erstattung" : "Zahlung"} erfasst am {dateTimeDe(pay.paidAt)} · {PAYMENT_METHOD_LABEL[pay.method] ?? pay.method}
                      {pay.voucherCode ? ` ${pay.voucherCode}` : ""}
                    </span>
                    <span>{money(pay.amountCents)}</span>
                  </div>
                  {receipt ? (
                    <div className="flex flex-wrap items-start gap-2">
                      <span className="self-center text-xs text-muted">
                        Beleg {receipt.number}
                        {receipt.isTest ? " · TSE-Testmodus" : ""}
                        {receipt.tseFailed ? " · TSE ausgefallen" : ""}
                        {receipt.archived ? "" : " · PDF noch nicht archiviert (wird beim Öffnen nachgeholt)"}
                      </span>
                      <a
                        href={`/api/invoices/${inv.id}/zahlungsbelege/${receipt.id}/pdf`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 text-[15px] font-semibold hover:bg-surface-2"
                      >
                        <FileDown size={18} aria-hidden /> Anzeigen / Drucken
                      </a>
                      <a
                        href={`/api/invoices/${inv.id}/zahlungsbelege/${receipt.id}/pdf?download=1`}
                        className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 text-[15px] font-semibold hover:bg-surface-2"
                      >
                        PDF
                      </a>
                      {canWrite ? <EmailPaymentReceiptButton invoiceId={inv.id} receiptId={receipt.id} number={receipt.number} recipientEmail={recipientEmail} /> : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-muted">
            {inv.status === "cancelled" ? (
              data.cancelledBy ? (
                <>
                  Rechnung storniert – Erstattung bzw. Verrechnung siehe Stornorechnung{" "}
                  <Link href={`/rechnungen/${data.cancelledBy.id}`} className="font-semibold text-primary underline">{data.cancelledBy.number}</Link>.
                </>
              ) : (
                "Rechnung storniert – Erstattung bzw. Verrechnung siehe Stornorechnung."
              )
            ) : open === 0 ? (
              "Vollständig bezahlt."
            ) : open > 0 ? (
              `Noch offen: ${money(open)}.`
            ) : (
              `Zu erstatten: ${money(-open)}.`
            )}{" "}
            Der Beleg oben bleibt wie ausgestellt – spätere Zahlungen werden nicht nachträglich eingedruckt. Für Bar-, Karten- und
            Gutscheinzahlungen gibt es je einen eigenen Beleg über den Zahlungseingang (Kassenbeleg mit TSE-Angaben).
          </p>
        </Card>
      ) : null}

      {data.payments.length === 0 && inv.status === "issued" ? (
        <Card className="no-print mx-auto mt-4 max-w-[210mm] text-sm text-muted">
          Noch keine Zahlung erfasst. Kartenzahlung über SumUp wird nach erfolgreicher Zahlung als „Karte (SumUp)“ gebucht.
        </Card>
      ) : null}
    </div>
  );
}
