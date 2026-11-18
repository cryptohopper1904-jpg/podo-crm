import { Card, CardTitle, PageHeader, Stat } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, money } from "@/lib/format";
import { DEDUCTION_STATUS_LABEL, DEDUCTION_STATUSES } from "@/lib/rules/gkv-billing";
import { monthLabel, periodQuery, resolvePeriod } from "@/lib/stats";
import { statsDetailsOpen } from "@/lib/view-level";
import { gkvPrivateStats } from "@/server/gkv-stats";
import { currentViewLevel } from "@/server/view-level";
import { ValuesTable } from "../charts";
import { StatsFilter, StatsTabs, yearOfPeriod } from "../stats-nav";

export const metadata = { title: "Auswertung – Kasse vs. privat" };

/** Euro für CSV (Komma, ohne Währungszeichen) */
const eur = (cents: number) => (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 1000) / 10} %`.replace(".", ",") : "–");

/**
 * GKV Paket C: Umsatz Kasse vs. privat im Zeitraum – nur Summen (Recht finance.read wie die übrige Auswertung).
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
  const gkvTotal = s.batches.insurerCents + s.copayments.cents;
  const total = gkvTotal + s.private.cents;
  const pendingDeductions = s.deductions.open.cents + s.deductions.objected.cents;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Auswertung" subtitle="Umsatz Kasse (GKV) und privat im Zeitraum" />
      <StatsTabs active="kasse" statsQuery={periodQuery(period)} year={yearOfPeriod(period)} />
      <StatsFilter action="/auswertung/kasse" period={period} />
      {!s.gkvEnabled ? (
        <p className="mb-6 rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">Die Praxis rechnet nur privat ab – GKV-Werte entfallen.</p>
      ) : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="GKV: Kassenanteil laut Abrechnungsläufen" value={money(s.batches.insurerCents)} tone="info" sub={`${s.batches.count} Lauf/Läufe · ${s.batches.prescriptions} Verordnungen`} />
        <Stat label="GKV: Zuzahlungen (ZZ)" value={money(s.copayments.cents)} tone="info" sub={`${s.copayments.count} Zuzahlungsquittung(en), ohne Stornos`} />
        <Stat label="Privat" value={money(s.private.cents)} tone="primary" sub={`${s.private.count} Beleg(e) · Anteil ${pct(s.private.cents, total)}`} />
        <Stat label="Absetzungen der Kassen" value={money(s.deductions.open.cents + s.deductions.objected.cents + s.deductions.accepted.cents + s.deductions.done.cents)} tone={pendingDeductions ? "warn" : "neutral"} sub={`davon offen/Widerspruch ${money(pendingDeductions)}`} />
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>GKV gesamt</CardTitle>
          <dl className="grid gap-2 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-muted">Heilmittelkosten laut Läufen (brutto)</dt><dd className="tabular-nums">{money(s.batches.remedyCents)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">− Zuzahlungen laut Läufen</dt><dd className="tabular-nums">{money(s.batches.copaymentCents)}</dd></div>
            <div className="flex justify-between gap-4 font-semibold"><dt>= Kassenanteil</dt><dd className="tabular-nums">{money(s.batches.insurerCents)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">+ Zuzahlungsquittungen (ZZ) im Zeitraum</dt><dd className="tabular-nums">{money(s.copayments.cents)}</dd></div>
            <div className="flex justify-between gap-4 font-semibold"><dt>GKV-Umsatz (Kassenanteil + ZZ)</dt><dd className="tabular-nums">{money(gkvTotal)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Anteil am Gesamtumsatz</dt><dd className="tabular-nums">{pct(gkvTotal, total)}</dd></div>
          </dl>
          <p className="mt-3 text-xs text-muted">
            Kassenanteil = Heilmittelkosten − Zuzahlungen der Abrechnungsläufe nach Erstellungstag (Forderung an die Kassen, nicht der Zahlungseingang).
            Zuzahlungen zählen nach dem Datum der Quittung – Läufe und Quittungen können in verschiedenen Monaten liegen.
            {s.batches.withoutRemedy ? ` ${s.batches.withoutRemedy} Lauf/Läufe ohne gespeicherte Heilmittelkosten (vor dem Preis-Snapshot) sind nicht enthalten.` : ""}
          </p>
        </Card>
        <Card>
          <CardTitle>Absetzungen im Zeitraum</CardTitle>
          <dl className="grid gap-2 text-sm">
            {DEDUCTION_STATUSES.map((k) => (
              <div key={k} className="flex justify-between gap-4"><dt className="text-muted">{DEDUCTION_STATUS_LABEL[k]} ({s.deductions[k].count})</dt><dd className="tabular-nums">{money(s.deductions[k].cents)}</dd></div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted">Nach Datum der Absetzung. Die Beträge sind im Kassenanteil noch enthalten (Läufe bleiben unverändert); Buchung mit der Steuerberatung klären.</p>
        </Card>
      </div>

      <Card>
        <CardTitle>Je Monat</CardTitle>
        <ValuesTable
          caption="Umsatz Kasse und privat je Monat"
          open={open || s.months.length <= 12}
          head={["Monat", "Kassenanteil", "Zuzahlungen (ZZ)", "Privat", "Absetzungen"]}
          rows={s.months.map((m) => [monthLabel(m.month), money(m.insurerCents), money(m.copaymentCents), money(m.privateCents), money(m.deductionCents)])}
          csv={csvOk ? { filename: file("kasse-privat"), head: ["Monat", "Kassenanteil laut Läufen", "Zuzahlungen (ZZ)", "Privat", "Absetzungen"], rows: s.months.map((m) => [m.month, eur(m.insurerCents), eur(m.copaymentCents), eur(m.privateCents), eur(m.deductionCents)]) } : null}
        />
        <p className="mt-3 text-xs text-muted">Privat = Rechnungen, Quittungen, Sammelrechnungen und Ausfallgebühren brutto nach Belegdatum, ohne Entwürfe, Stornos, Gutschriften, Anzahlungen und ohne angerechnete Quittungen (wie „Leistungen &amp; Produkte“).</p>
      </Card>
    </div>
  );
}
