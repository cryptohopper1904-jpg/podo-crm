import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileDown } from "lucide-react";
import { Badge, Card, CardTitle, LinkButton, Table } from "@/components/ui";
import { PrintButton } from "@/components/print-button";
import { requireAuth } from "@/lib/auth/session";
import { dateDe, dateTimeDe, money } from "@/lib/format";
import { PAYMENT_METHOD_LABEL } from "@/lib/invoice-labels";
import { DENOMINATIONS, denominationLabel, MOVEMENT_LABEL, tseLabel, type MovementKind } from "@/lib/kasse/labels";
import { getClosing } from "@/server/kasse";
import { retryRegistrationAction } from "../../actions";

export const metadata = { title: "Z-Bon" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PRINT_CSS = `
@page { size: A4; margin: 14mm 16mm; }
@media print {
  main { padding: 0 !important; }
  .zbon, .zbon * { color: #000 !important; background: transparent !important; border-color: #bbb !important; }
}`;

export default async function ClosingPage(props: PageProps<"/kasse/abschluss/[id]">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const auth = await requireAuth("cash.read");
  if (!UUID.test(id)) notFound();
  const data = await getClosing(auth, id);
  if (!data) notFound();
  const { closing: z, organization: o } = data;
  const pending = z.tse.mode === "fiskaly" && !z.tse.exportRef && !data.registration;
  const row = (label: string, value: string, strong = false) => (
    <Fragment key={label}>
      <dt className={strong ? "font-semibold" : undefined}>{label}</dt>
      <dd className={`text-right tabular-nums ${strong ? "font-semibold" : ""}`}>{value}</dd>
    </Fragment>
  );
  return (
    <div className="mx-auto max-w-4xl">
      <style>{PRINT_CSS}</style>
      <div className="no-print mb-4 flex flex-wrap items-center gap-3">
        <Link href="/kasse" className="inline-flex items-center gap-1 font-semibold text-muted hover:text-text">
          <ArrowLeft size={18} aria-hidden /> Kasse
        </Link>
        <span className="flex-1" />
        <PrintButton />
        <LinkButton href={`/api/kasse/z-bon/${z.id}?download=1`} variant="secondary" prefetch={false}>
          <FileDown size={18} aria-hidden /> PDF
        </LinkButton>
      </div>
      {!data.chainOk || !data.digestOk ? (
        <p role="alert" className="mb-4 rounded-xl bg-accent-soft px-4 py-3 text-sm font-semibold text-accent-soft-text">
          Prüfung fehlgeschlagen: Hash-Kette oder Belegzuordnung stimmt nicht. Bitte Support kontaktieren.
        </p>
      ) : null}
      <div className="zbon flex flex-col gap-4">
        <Card>
          <p className="text-sm text-muted">{o.legalName || o.name}{o.taxNumber ? ` · St.-Nr. ${o.taxNumber}` : ""}</p>
          <h1 className="mt-1 font-display text-3xl font-semibold">Z-Bon Nr. {z.number}</h1>
          <p className="mt-1 text-[15px]">
            Buchungstag {dateDe(z.businessDate)} · erstellt {dateTimeDe(z.createdAt)} · erfasst bis {dateTimeDe(z.closedAt)}
            {data.createdByName ? ` · ${data.createdByName}` : ""}
          </p>
          <p className="mt-2 text-sm">
            {z.tse.mode === "fiskaly" ? <Badge tone="primary">TSE</Badge> : <Badge tone="warn">ohne TSE</Badge>} <span className="ml-1">{tseLabel(z.tse, data.registration)}</span>
          </p>
          {pending ? (
            <div className="no-print mt-2 flex flex-wrap items-center gap-3 text-sm">
              <span role="status">{sp.tse === "fehler" ? "Meldung erneut fehlgeschlagen – bitte später noch einmal versuchen." : "Die Meldung an den TSE-Dienst steht noch aus."}</span>
              {auth.can("cash.write") ? (
                <form action={retryRegistrationAction}>
                  <input type="hidden" name="id" value={z.id} />
                  <button type="submit" className="font-semibold text-primary underline">Meldung wiederholen</button>
                </form>
              ) : null}
            </div>
          ) : null}
          <p className="mt-2 text-sm text-muted">
            Belegnummern {z.lastBonNr >= z.firstBonNr ? `${z.firstBonNr}–${z.lastBonNr}` : "–"} · {z.paymentCount} Zahlungen · {z.movementCount} Kassenbuch-Einträge
          </p>
        </Card>
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardTitle>Einnahmen je Zahlart</CardTitle>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-[15px]">
              {Object.entries(z.totals.byMethod).map(([m, c]) => row(PAYMENT_METHOD_LABEL[m] ?? m, money(c)))}
              {row("Summe", money(Object.values(z.totals.byMethod).reduce((s, c) => s + c, 0)), true)}
            </dl>
            <h3 className="mt-4 mb-1 text-sm font-semibold">Umsätze je Steuersatz</h3>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-[15px]">
              {z.totals.byVat.length ? z.totals.byVat.map((v) => row(`${v.rate} % (netto ${money(v.netCents)}, USt ${money(v.vatCents)})`, money(v.grossCents))) : row("keine", money(0))}
            </dl>
          </Card>
          <Card>
            <CardTitle>Kassenbestand</CardTitle>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-[15px]">
              {row("Anfangsbestand", money(z.openingCents))}
              {row("+ Bareinnahmen", money(z.cashPaymentsCents))}
              {Object.entries(z.totals.movements).map(([k, c]) => row(MOVEMENT_LABEL[k as MovementKind] ?? k, money(c)))}
              {row("= Soll", money(z.expectedCashCents), true)}
              {row("Ist (gezählt)", money(z.countedCashCents), true)}
              {row("Differenz", money(z.differenceCents), true)}
            </dl>
            {z.differenceReason ? <p className="mt-2 text-sm">Begründung: {z.differenceReason}</p> : null}
          </Card>
        </div>
        <Card>
          <CardTitle>Zählprotokoll</CardTitle>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[15px] sm:grid-cols-[1fr_auto_1fr_auto]">
            {DENOMINATIONS.filter((d) => z.denominations[String(d)]).map((d) => row(`${z.denominations[String(d)]} × ${denominationLabel(d)}`, money(d * z.denominations[String(d)])))}
          </dl>
        </Card>
        <Card>
          <CardTitle>Belege</CardTitle>
          <Table>
            <thead>
              <tr>
                <th>Nr.</th>
                <th>Zeit</th>
                <th>Vorgang</th>
                <th className="text-right">Betrag</th>
              </tr>
            </thead>
            <tbody>
              {data.bons.map((b) => (
                <tr key={b.bonId}>
                  <td>{b.bonNr}</td>
                  <td>{dateTimeDe(b.start)}</td>
                  <td>{b.lines.map((l) => l.text).join(" / ")}{b.note ? ` – ${b.note}` : ""}</td>
                  <td className="text-right tabular-nums">{money(b.totalCents)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {data.payments.some((p) => p.method === "transfer" || p.method === "payment_link") ? (
            <p className="mt-2 text-sm text-muted">Überweisungen/Zahlungslinks sind im Abschluss enthalten (Summen), aber keine Kassenvorgänge.</p>
          ) : null}
        </Card>
        {z.note ? <Card><CardTitle>Notiz</CardTitle><p className="whitespace-pre-wrap">{z.note}</p></Card> : null}
        <p className="break-all text-xs text-muted">SHA-256: {z.hash}</p>
      </div>
    </div>
  );
}
