import { Badge, Card, Stat, Table } from "@/components/ui";
import { MiniBars } from "@/components/mini-bars";
import { dateDe, dateTimeDe, money } from "@/lib/format";
import type { CheckResult } from "@/lib/ops-health";
import { isPlanId, PLANS } from "@/lib/plans";
import { ADOPTION_DAYS, MODULE_KEYS, MODULES, MONTHLY_METRICS, type MonthlyMetric, type PlatformUsage } from "@/server/platform-stats";

/** Betreiber-Dashboard: nur Nutzungsdaten (Zahlen, Summen, Zeitstempel) – nie Patientendaten. */

const monthLabel = (m: string) => `${m.slice(5, 7)}/${m.slice(2, 4)}`;
const bytes = (n: number) => {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`;
  return `${(n / 1024 ** 3).toLocaleString("de-DE", { maximumFractionDigits: 2 })} GB`;
};
const euros = (cents: number) => money(cents);
const STATUS_TONE = { ok: "primary", warn: "warn", fail: "accent", skipped: "neutral" } as const;
const planLabel = (p: string) => (isPlanId(p) ? PLANS[p].label : p);

const CHART_METRICS: MonthlyMetric[] = ["appointments", "treatmentRecords", "invoicesIssued", "revenueCents", "onlineBookings", "portalBookings", "voiceMinutes", "emailsSent", "aiUses", "ocrUses"];

function HealthBadge({ label, check }: { label: string; check: CheckResult }) {
  const detail =
    check.ageMinutes !== undefined && check.ageMinutes !== null
      ? `vor ${Math.round(Number(check.ageMinutes) / 60)} h`
      : check.applied !== undefined
        ? `${check.applied} / ${check.expected} Migrationen${check.latest ? ` (${check.latest})` : ""}`
        : (check.hint ?? "");
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-surface-2 p-3">
      <span className="text-xs font-medium text-muted">{label}</span>
      <span className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[check.status]}>{check.status}</Badge>
        <span className="text-sm">{detail}</span>
      </span>
      {check.hint && detail !== check.hint ? <span className="text-xs text-muted">{check.hint}</span> : null}
    </div>
  );
}

export function UsageDashboard({ usage }: { usage: PlatformUsage }) {
  const { summary: s, practices, health } = usage;
  const labels = s.months.map((m) => monthLabel(m.month));
  const cur = s.months.at(-1);
  return (
    <section aria-labelledby="nutzung" className="mt-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="nutzung" className="font-display text-2xl font-semibold">Nutzung</h2>
        <p className="text-xs text-muted">Nur Anzahlen, Summen und Zeitstempel · Stand {dateTimeDe(usage.generatedAt)}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Praxen" value={s.practices} sub={Object.entries(s.byPlan).map(([p, n]) => `${planLabel(p)} ${n}`).join(" · ") || "–"} />
        <Stat label="Aktive Personen (7 / 30 Tage)" value={`${s.activeUsers7d} / ${s.activeUsers30d}`} sub="nach letzter Anmeldung" tone="info" />
        <Stat label="Plätze belegt / bezahlt" value={`${s.seatsUsed} / ${s.seatsPaid}`} sub={Object.entries(s.byStatus).map(([k, n]) => `${k} ${n}`).join(" · ") || "–"} tone="neutral" />
        <Stat label="Testphasen enden ≤ 14 Tage" value={s.trialsEnding14d} sub={`Medien gesamt ${bytes(s.storageBytes)}`} tone={s.trialsEnding14d ? "warn" : "neutral"} />
      </div>

      <Card>
        <h3 className="mb-3 font-display text-lg font-semibold">Alle Praxen je Monat</h3>
        <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-5">
          {CHART_METRICS.map((k) => (
            <MiniBars key={k} label={MONTHLY_METRICS[k]} labels={labels} values={s.months.map((m) => m[k])} format={k === "revenueCents" ? euros : undefined} />
          ))}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card>
          <h3 className="mb-3 font-display text-lg font-semibold">Modul-Nutzung <span className="text-sm font-normal text-muted">(Praxen mit Nutzung in {ADOPTION_DAYS} Tagen)</span></h3>
          <ul className="grid gap-2 sm:grid-cols-2">
            {MODULE_KEYS.map((k) => {
              const n = s.adoption[k];
              const pct = s.practices ? Math.round((n / s.practices) * 100) : 0;
              return (
                <li key={k} className="flex items-center gap-3 text-sm">
                  <span className="w-36 shrink-0">{MODULES[k]}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                    <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                  </span>
                  <span className="w-14 text-right tabular-nums">{n} ({pct} %)</span>
                </li>
              );
            })}
          </ul>
        </Card>
        <Card>
          <h3 className="mb-3 font-display text-lg font-semibold">Betrieb</h3>
          <div className="flex flex-col gap-2">
            <HealthBadge label="Migrationsstand" check={health.migrations} />
            <HealthBadge label="Letztes Backup" check={health.backup} />
            <HealthBadge label="Löschlauf Online-Anfragen" check={health.retention} />
          </div>
        </Card>
      </div>

      <Card className="p-0">
        <Table>
          <thead>
            <tr>
              <th>Praxis</th><th>Tarif</th><th>Aktiv 7/30 T.</th><th>Plätze</th><th>Termine</th><th>Dokus</th><th>Rechnungen</th><th>Summe</th><th>Online/Portal</th><th>Tel.-Min.</th><th>E-Mails</th><th>KI/OCR</th><th>Medien</th><th>Letzte Aktivität</th>
            </tr>
          </thead>
          <tbody>
            {practices.map((p) => {
              const m = p.months.at(-1)!;
              const used = MODULE_KEYS.filter((k) => p.modules[k]);
              return (
                <tr key={p.organizationId}>
                  <td>
                    <details>
                      <summary className="cursor-pointer font-semibold">{p.practiceName}</summary>
                      <div className="mt-3 grid min-w-[36rem] gap-4 sm:grid-cols-3">
                        {(["appointments", "treatmentRecords", "revenueCents"] as const).map((k) => (
                          <MiniBars key={k} label={MONTHLY_METRICS[k]} labels={p.months.map((x) => monthLabel(x.month))} values={p.months.map((x) => x[k])} format={k === "revenueCents" ? euros : undefined} />
                        ))}
                      </div>
                      <p className="mt-3 flex flex-wrap gap-1">
                        {used.length ? used.map((k) => <Badge key={k} tone="primary">{MODULES[k]}</Badge>) : <span className="text-xs text-muted">keine Modul-Nutzung in {ADOPTION_DAYS} Tagen</span>}
                      </p>
                      <p className="mt-2 text-xs text-muted">Patient:innen gesamt: {p.customersTotal} · angelegt {dateDe(p.createdAt)} · letzte Anmeldung {p.lastLoginAt ? dateTimeDe(p.lastLoginAt) : "–"}</p>
                    </details>
                  </td>
                  <td>
                    <p>{planLabel(p.plan)}</p>
                    {p.trialEndsAt && p.subscriptionStatus === "trialing" ? <p className="text-xs text-muted">Test bis {dateDe(p.trialEndsAt)}</p> : null}
                  </td>
                  <td className="tabular-nums">{p.activeUsers7d} / {p.activeUsers30d}</td>
                  <td className="tabular-nums">{p.seatsUsed} / {p.seatsPaid}</td>
                  <td className="tabular-nums">{m.appointments}</td>
                  <td className="tabular-nums">{m.treatmentRecords}</td>
                  <td className="tabular-nums">{m.invoicesIssued}</td>
                  <td className="tabular-nums whitespace-nowrap">{euros(m.revenueCents)}</td>
                  <td className="tabular-nums">{m.onlineBookings} / {m.portalBookings}</td>
                  <td className="tabular-nums">{m.voiceMinutes}</td>
                  <td className="tabular-nums">{m.emailsSent}</td>
                  <td className="tabular-nums">{m.aiUses} / {m.ocrUses}</td>
                  <td className="tabular-nums whitespace-nowrap">{bytes(p.storageBytes)}</td>
                  <td className="whitespace-nowrap">{p.lastActivityAt ? dateTimeDe(p.lastActivityAt) : "–"}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <p className="px-4 py-3 text-xs text-muted">Monatswerte: laufender Kalendermonat{cur ? ` (${monthLabel(cur.month)})` : ""}. Aufklappen für den Verlauf über 6 Monate und genutzte Module.</p>
      </Card>
    </section>
  );
}
