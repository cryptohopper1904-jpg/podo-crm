import Link from "next/link";
import { Empty, LinkButton, PageHeader, Stat, Table } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { isPrivateOnly } from "@/lib/features";
import { berlinDateIso, dateDe, money } from "@/lib/format";
import { parseYear } from "@/lib/year-end";
import { collectiveOverview } from "@/server/appointment-billing";

export const metadata = { title: "Sammelrechnungen zum Jahresende" };

/**
 * Jahresend-Übersicht: Patient:innen mit noch nicht abgerechneten Behandlungen, noch nicht angerechneten Anzahlungen
 * oder noch nicht angerechneten normalen Quittungen des Jahres – je Zeile direkt „Sammelrechnung erstellen“.
 */
export default async function CollectiveOverviewPage(props: PageProps<"/rechnungen/sammelrechnungen">) {
  const auth = await requireAuth("invoices.read");
  const sp = await props.searchParams;
  const current = Number(berlinDateIso().slice(0, 4));
  const year = parseYear(sp.jahr, current);
  const rows = await collectiveOverview(auth, year);
  const canWrite = auth.can("invoices.write");
  const sum = rows.reduce((s, r) => s + r.estimateCents, 0);
  const deposits = rows.reduce((s, r) => s + r.depositCents, 0);
  const receipts = rows.reduce((s, r) => s + r.receiptCents, 0);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        back={{ href: "/rechnungen", label: "Rechnungen" }}
        title={`Sammelrechnungen ${year}`}
        subtitle="Wer bekommt noch eine Sammelrechnung? Behandlungen und Quittungen des Jahres, die noch nicht abgerechnet sind"
        actions={
          <>
            <LinkButton href={`/rechnungen/sammelrechnungen?jahr=${year - 1}`} variant="secondary">{year - 1}</LinkButton>
            {year < current ? <LinkButton href={`/rechnungen/sammelrechnungen?jahr=${year + 1}`} variant="secondary">{year + 1}</LinkButton> : null}
          </>
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Patient:innen ohne Sammelrechnung" value={rows.length} tone={rows.length ? "accent" : "primary"} />
        <Stat label="Geschätzter Betrag" value={money(sum)} sub="Katalogpreise der Termin-Leistungen" tone="info" />
        <Stat label="Anzahlungen" value={money(deposits)} sub="Vorauszahlungen (AZ) – werden angerechnet" tone="neutral" />
        <Stat label="Quittungen (bereits bezahlt)" value={money(receipts)} sub="werden auf der Sammelrechnung vermerkt und angerechnet" tone="neutral" />
      </div>
      {rows.length === 0 ? (
        <Empty title={`Alles abgerechnet – für ${year} fehlt keine Sammelrechnung.`} />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Patient:in</th>
              <th>Behandlungen</th>
              <th>Zeitraum</th>
              <th className="text-right">geschätzt</th>
              <th className="text-right">Anzahlungen</th>
              <th className="text-right">Quittungen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.patientId}>
                <td>
                  <Link href={`/kunden/${r.patientId}`} className="font-semibold hover:text-primary">{r.name}</Link>
                  <span className="text-sm text-muted"> #{r.number}</span>
                </td>
                <td className="tabular-nums">
                  {r.items}
                  {r.unpricedLines ? <span className="text-sm text-muted"> ({r.unpricedLines} ohne Preis)</span> : null}
                </td>
                <td className="tabular-nums text-sm">{r.firstAt ? `${dateDe(r.firstAt)} – ${dateDe(r.lastAt)}` : "–"}</td>
                <td className="text-right tabular-nums">{money(r.estimateCents)}</td>
                <td className="text-right tabular-nums">{r.depositCount ? `${money(r.depositCents)} (${r.depositCount})` : "–"}</td>
                <td className="text-right tabular-nums">{r.receiptCount ? `${money(r.receiptCents)} (${r.receiptCount})` : "–"}</td>
                <td className="text-right">
                  {canWrite ? (
                    <LinkButton href={`/rechnungen/neu?sammel=${r.patientId}&jahr=${year}`} variant="secondary" className="h-10 px-3 text-sm">
                      Sammelrechnung erstellen
                    </LinkButton>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <p className="mt-4 text-sm text-muted">
        Gezählt werden Behandlungen (Doku) und vergangene, nicht abgesagte Termine ohne Rechnung{isPrivateOnly(auth.organization) ? "" : " – ohne Leistungen auf Verordnung"} sowie
        bezahlte Quittungen des Jahres und offene Anzahlungen, die noch auf keiner Sammelrechnung stehen (sie werden mit ihren Leistungen übernommen und als „bereits bezahlt“
        angerechnet – kein zweiter Umsatz). Bewohner:innen, deren Rechnungen ans Pflegeheim gehen, laufen über die monatliche Pflegeheim-Sammelrechnung.
      </p>
    </div>
  );
}
