import { Card, CardTitle, PageHeader, Stat } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, dateDe, money } from "@/lib/format";
import { monthLabel, periodQuery, resolvePeriod } from "@/lib/stats";
import { statsDetailsOpen } from "@/lib/view-level";
import { gkvPrivateStats, reversalRefText, REVERSALS_LIMIT } from "@/server/gkv-stats";
import { currentViewLevel } from "@/server/view-level";
import { ValuesTable } from "../charts";
import { StatsFilter, StatsTabs, yearOfPeriod } from "../stats-nav";

export const metadata = { title: "Auswertung – Abrechnungsvolumen Kasse vs. privat" };

/** Euro für CSV (Komma, ohne Währungszeichen) */
const eur = (cents: number) => (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 1000) / 10} %`.replace(".", ",") : "–");

/**
 * GKV Paket C: Abrechnungsvolumen Kasse vs. privat im Zeitraum – nur Summen (Recht finance.read wie die übrige
 * Auswertung). Kein Umsatz/Erlös im Sinne der Buchhaltung (Soll/Ist gemischt, unterschiedlicher Zeitbezug).
 * Abgrenzung in src/server/gkv-stats.ts und docs/GKV.md (Paket C Teil 2).
 */
export default async function StatsGkvPage(props: PageProps<"/auswertung/kasse">) {
  const auth = await requireAuth("finance.read");
  const sp = await props.searchParams;
  const period = resolvePeriod(sp, berlinDateIso());
  const [s, level] = await Promise.all([gkvPrivateStats(auth, period), currentViewLevel()]);
  const open = statsDetailsOpen(level);
  const csvOk = !auth.support;
  const file = (name: string) => `${name}-${period.from}-bis-${period.to}.csv`;
  const gkvTotal = s.batches.insurerNetCents + s.copayments.cents;
  const total = gkvTotal + s.private.cents;
  const ds = s.deductionSummary;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Auswertung" subtitle="Abrechnungsvolumen Kasse (GKV) vs. privat im Zeitraum" />
      <StatsTabs active="kasse" statsQuery={periodQuery(period)} year={yearOfPeriod(period)} />
      <StatsFilter action="/auswertung/kasse" period={period} />
      {!s.gkvEnabled ? (
        <p className="mb-6 rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">Die Praxis rechnet nur privat ab – GKV-Werte entfallen.</p>
      ) : null}

      <p className="mb-6 rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">
        Abrechnungsvolumen, kein Umsatz im Sinne der Buchhaltung: Abrechnungsläufe zählen nach Erstellungstag (Soll an die Kassen, nicht der
        Zahlungseingang), Zuzahlungs- und Privatbelege nach Belegdatum (Ist) – Soll und Ist sind gemischt, Läufe und Belege können in
        verschiedenen Monaten liegen. Stand Abruf: Stornos und Korrekturen wirken rückwirkend auf frühere Zeiträume.
      </p>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="GKV: Kassenanteil laut Abrechnungsläufen" value={money(s.batches.insurerNetCents)} tone="info" sub={`${s.batches.count} Lauf/Läufe · ${s.batches.prescriptions} Verordnungen${s.batches.replaced.count ? ` · ${s.batches.replaced.count} Neuabrechnung(en) nicht doppelt gezählt` : ""}`} />
        <Stat label="GKV: Zuzahlungen (ZZ)" value={money(s.copayments.cents)} tone="info" sub={`${s.copayments.count} Zuzahlungsquittung(en), ohne Stornos`} />
        <Stat label="Privat (Belege brutto)" value={money(s.private.cents)} tone="primary" sub={`${s.private.count} Beleg(e) · Anteil am Abrechnungsvolumen ${pct(s.private.cents, total)}`} />
        <Stat label="Absetzungen (Minderung)" value={money(ds.reductionCents)} tone={ds.pendingCents ? "warn" : "neutral"} sub={`akzeptiert/bleibt · offen/Widerspruch ${money(ds.pendingCents)} getrennt`} />
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>GKV gesamt (Kassenanteil laut Läufen + ZZ-Quittungen)</CardTitle>
          <dl className="grid gap-2 text-sm">
            <div className="flex justify-between gap-4"><dt className="min-w-0 text-muted">Heilmittelkosten laut Läufen (brutto)</dt><dd className="shrink-0 whitespace-nowrap tabular-nums">{money(s.batches.remedyCents)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="min-w-0 text-muted">− Zuzahlungen laut Läufen</dt><dd className="shrink-0 whitespace-nowrap tabular-nums">{money(s.batches.copaymentCents)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="min-w-0 text-muted">= Kassenanteil laut Läufen</dt><dd className="shrink-0 whitespace-nowrap tabular-nums">{money(s.batches.insurerCents)}</dd></div>
            {s.batches.replaced.count ? (
              <div className="flex justify-between gap-4"><dt className="min-w-0 text-muted">− ersetzt durch Neuabrechnung ({s.batches.replaced.count} Verordnung(en), Kassenanteil der Erstabrechnung)</dt><dd className="shrink-0 whitespace-nowrap tabular-nums">{money(s.batches.replaced.insurerCents)}</dd></div>
            ) : null}
            <div className="flex justify-between gap-4 font-semibold"><dt>= Kassenanteil</dt><dd className="shrink-0 whitespace-nowrap tabular-nums">{money(s.batches.insurerNetCents)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="min-w-0 text-muted">+ Zuzahlungsquittungen (ZZ) im Zeitraum</dt><dd className="shrink-0 whitespace-nowrap tabular-nums">{money(s.copayments.cents)}</dd></div>
            <div className="flex justify-between gap-4 font-semibold"><dt>GKV gesamt</dt><dd className="shrink-0 whitespace-nowrap tabular-nums">{money(gkvTotal)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="min-w-0 text-muted">Anteil am Abrechnungsvolumen</dt><dd className="shrink-0 whitespace-nowrap tabular-nums">{pct(gkvTotal, total)}</dd></div>
            <div className="mt-2 flex justify-between gap-4 border-t border-border pt-2"><dt className="min-w-0 text-muted">Zum Vergleich: Zahlungseingang Abrechnungszentrum brutto ({s.payouts.count} Auszahlung(en), nach Auszahlungsdatum)</dt><dd className="shrink-0 whitespace-nowrap tabular-nums">{money(s.payouts.grossCents)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="min-w-0 text-muted">− Gebühr des Abrechnungszentrums (Betriebsausgabe)</dt><dd className="shrink-0 whitespace-nowrap tabular-nums">{money(s.payouts.feeCents)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="min-w-0 text-muted">= Zahlungseingang netto (überwiesen)</dt><dd className="shrink-0 whitespace-nowrap tabular-nums">{money(s.payouts.cents)}</dd></div>
          </dl>
          {s.reversals.length ? (
            <div className="mt-3 border-t border-border pt-2">
              <h3 className="mb-1 text-sm font-semibold">Stornos von Auszahlungen</h3>
              <ul className="grid gap-1 text-sm" aria-label="Stornos von Auszahlungen mit Bezug">
                {s.reversals.map((r, i) => (
                  <li key={i} className="flex justify-between gap-4">
                    <span className="min-w-0 text-muted">
                      {r.reversalInPeriod
                        ? `Storno vom ${dateDe(r.reversedOn)} – ${reversalRefText(r.originalPaidOn)}${r.originalInPeriod ? "" : " (früherer Zeitraum)"}`
                        : `Auszahlung vom ${dateDe(r.originalPaidOn)} – storniert am ${dateDe(r.reversedOn)} (späterer Zeitraum, hier nicht gemindert)`}
                    </span>
                    <span className="shrink-0 whitespace-nowrap tabular-nums">{r.reversalInPeriod ? money(r.amountCents) : "–"}</span>
                  </li>
                ))}
              </ul>
              {s.reversals.length >= REVERSALS_LIMIT ? <p className="mt-1 text-xs text-muted">Nur die ersten {REVERSALS_LIMIT} Stornos sind aufgeführt.</p> : null}
            </div>
          ) : null}
          <p className="mt-3 text-xs text-muted">
            Kassenanteil = Heilmittelkosten − Zuzahlungen der Abrechnungsläufe nach Erstellungstag (Forderung an die Kassen, nicht der Zahlungseingang).
            Eine nach Korrektur neu abgerechnete Verordnung steht im alten und im neuen Lauf – der Stand der Erstabrechnung wird im Monat des neuen Laufs abgezogen.
            Zuzahlungen zählen nach dem Datum der Quittung – Läufe und Quittungen können in verschiedenen Monaten liegen.
            Der Zahlungseingang (Ist) stammt aus den am Abrechnungslauf erfassten Auszahlungen (Rückmeldung oder von Hand) und wird nicht mit dem Soll verrechnet;
            Stornos wirken im Monat des Stornos: Der Gegenbetrag mindert den Zahlungseingang des Monats, in dem storniert wurde, nicht rückwirkend den Monat der
            ursprünglichen Auszahlung. Fällt das Storno in einen späteren Zeitraum, zählt die ursprüngliche Auszahlung hier nicht mehr bei der Anzahl der
            Auszahlungen mit, ihr Betrag ist in der Summe dieses Zeitraums aber noch enthalten – ausgeglichen wird er erst im Monat des Stornos. Bei jedem Storno
            steht, welche Auszahlung es betrifft. Die Gebühr des Abrechnungszentrums ist eine Betriebsausgabe: Rechnung des Abrechnungszentrums gesondert
            ablegen; die Gebühr kann Umsatzsteuer enthalten – mit der Steuerberatung klären.
            {s.batches.withoutRemedy ? ` ${s.batches.withoutRemedy} Lauf/Läufe ohne gespeicherte Heilmittelkosten (vor dem Preis-Snapshot) sind nicht enthalten.` : ""}
          </p>
        </Card>
        <Card>
          <CardTitle>Absetzungen im Zeitraum</CardTitle>
          <dl className="grid gap-2 text-sm">
            <div className="flex justify-between gap-4 font-semibold"><dt>Minderung: akzeptiert bzw. erledigt – Absetzung bleibt ({ds.reductionCount})</dt><dd className="shrink-0 whitespace-nowrap tabular-nums">{money(ds.reductionCents)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="min-w-0 text-muted">noch offen bzw. im Widerspruch ({ds.pendingCount}) – keine Minderung</dt><dd className="shrink-0 whitespace-nowrap tabular-nums">{money(ds.pendingCents)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="min-w-0 text-muted">erledigt – Widerspruch erfolgreich ({ds.reversedCount}) – keine Minderung</dt><dd className="shrink-0 whitespace-nowrap tabular-nums">{money(ds.reversedCents)}</dd></div>
            {ds.replacedCount ? (
              <div className="flex justify-between gap-4"><dt className="min-w-0 text-muted">durch Neuabrechnung ersetzt ({ds.replacedCount}) – keine Minderung</dt><dd className="shrink-0 whitespace-nowrap tabular-nums">{money(ds.replacedCents)}</dd></div>
            ) : null}
          </dl>
          <p className="mt-3 text-xs text-muted">
            Nach Datum der Absetzung. Die Minderung wird nicht vom Kassenanteil abgezogen (der Kassenanteil zeigt die Forderung laut Läufen); Buchung mit der
            Steuerberatung klären. Absetzungen zu einer Verordnung, die nach Korrektur neu abgerechnet wurde, sind keine Minderung: Die Erstabrechnung ist dort
            schon als „ersetzt durch Neuabrechnung“ abgezogen.
          </p>
        </Card>
      </div>

      <Card>
        <CardTitle>Je Monat</CardTitle>
        <ValuesTable
          caption="Abrechnungsvolumen Kasse und privat je Monat"
          open={open || s.months.length <= 12}
          head={["Monat", "Kassenanteil", "Zahlungseingang AZ netto", "Gebühr AZ", "Zuzahlungen (ZZ)", "Privat (brutto)", "Absetzungen (Minderung)"]}
          rows={s.months.map((m) => [monthLabel(m.month), money(m.insurerCents), money(m.payoutCents), money(m.payoutFeeCents), money(m.copaymentCents), money(m.privateCents), money(m.deductionCents)])}
          csv={
            csvOk
              ? {
                  filename: file("kasse-privat"),
                  head: ["Monat", "Kassenanteil laut Läufen (ohne Doppelzählung)", "Zahlungseingang Abrechnungszentrum netto", "Gebühr Abrechnungszentrum (Betriebsausgabe)", "Zuzahlungen (ZZ)", "Privat (Belege brutto)", "Absetzungen (Minderung)"],
                  rows: s.months.map((m) => [m.month, eur(m.insurerCents), eur(m.payoutCents), eur(m.payoutFeeCents), eur(m.copaymentCents), eur(m.privateCents), eur(m.deductionCents)]),
                }
              : null
          }
        />
        <p className="mt-3 text-xs text-muted">
          Der Kassenanteil eines Monats kann negativ sein: Die Erstabrechnung einer neu abgerechneten Verordnung wird im Monat des neuen Laufs abgezogen – ist
          dieser Lauf kleiner als die ersetzten Erstabrechnungen, ergibt sich ein negativer Monatswert.
        </p>
        <p className="mt-3 text-xs text-muted">Privat = Rechnungen, Quittungen, Sammelrechnungen und Ausfallgebühren brutto nach Belegdatum, ohne Entwürfe, Stornos, Gutschriften, Anzahlungen und ohne angerechnete Quittungen (wie „Leistungen &amp; Produkte“).</p>
      </Card>
    </div>
  );
}
