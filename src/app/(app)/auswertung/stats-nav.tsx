import Link from "next/link";
import { dateDe } from "@/lib/format";
import { PERIOD_LABELS, PERIOD_PRESETS, type Period } from "@/lib/stats";
import { PeriodSelect } from "./period-select";

export type StatsTab = "finanzen" | "termine" | "leistungen";

/**
 * Reiter der Auswertung. Der gewählte Zeitraum wandert mit: Finanzen arbeitet mit Kalenderjahren (?year=),
 * die Statistik-Reiter mit ?zeitraum=…&von=…&bis=….
 */
export function StatsTabs({ active, statsQuery, year }: { active: StatsTab; statsQuery: Record<string, string>; year: number }) {
  const tabs: [StatsTab, string, { pathname: string; query: Record<string, string | number> }][] = [
    ["finanzen", "Finanzen", { pathname: "/auswertung", query: { year } }],
    ["termine", "Termine", { pathname: "/auswertung/termine", query: statsQuery }],
    ["leistungen", "Leistungen & Produkte", { pathname: "/auswertung/leistungen", query: statsQuery }],
  ];
  return (
    <nav aria-label="Bereiche der Auswertung" className="no-print mb-6 flex gap-1 overflow-x-auto rounded-xl border border-border bg-surface p-1">
      {tabs.map(([key, label, href]) => (
        <Link
          key={key}
          href={href}
          aria-current={active === key ? "page" : undefined}
          className={`inline-flex min-h-11 items-center whitespace-nowrap rounded-lg px-3.5 text-sm font-semibold ${active === key ? "bg-primary-soft text-primary-soft-text" : "hover:bg-surface-2"}`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

/** Zeitraum der Statistik → Jahr für den Reiter „Finanzen“ */
export const yearOfPeriod = (p: Period) => Number(p.to.slice(0, 4));

/** Finanzen-Jahr → passender Zeitraum der Statistik-Reiter */
export function statsQueryForYear(year: number, currentYear: number): Record<string, string> {
  if (year === currentYear) return { zeitraum: "jahr" };
  if (year === currentYear - 1) return { zeitraum: "vorjahr" };
  return { zeitraum: "frei", von: `${year}-01-01`, bis: `${year}-12-31` };
}

/** Filterleiste (GET-Formular): Zeitraum, frei von/bis, optional Behandler:in */
export function StatsFilter({
  action,
  period,
  therapists,
  therapistId,
}: {
  action: string;
  period: Period;
  therapists?: { id: string; name: string }[];
  therapistId?: string | null;
}) {
  return (
    <form action={action} method="get" className="no-print mb-6 flex flex-wrap items-end gap-3 rounded-[var(--radius-card)] border border-border bg-surface p-4">
      <PeriodSelect
        presets={PERIOD_PRESETS.map((p) => [p, PERIOD_LABELS[p]])}
        preset={period.preset}
        from={period.from}
        to={period.to}
      />
      {therapists && therapists.length > 1 ? (
        <label className="flex min-w-44 flex-col gap-1.5">
          <span className="text-sm font-medium">Behandler:in</span>
          <select name="behandler" defaultValue={therapistId ?? ""} className="h-11 rounded-xl border border-border bg-surface px-3.5 pr-8 text-[15px] text-text">
            <option value="">Alle</option>
            {therapists.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button type="submit" className="inline-flex h-11 items-center rounded-xl bg-primary px-4 text-[15px] font-semibold text-on-primary hover:bg-primary-hover">
        Anzeigen
      </button>
      <p id="period-free-hint" className="basis-full text-xs text-muted">
        Von und Bis gelten bei „Frei wählen“ – eine Datumsänderung wählt das automatisch.
      </p>
      <p className="basis-full text-sm text-muted" aria-live="polite">
        Zeitraum: <strong className="text-text">{period.label}</strong>
        {period.until < period.to ? ` · ausgewertet bis heute (${dateDe(`${period.until}T12:00:00Z`)}), Durchschnitte und Reichweite auf die bisherigen Tage bezogen` : null}
      </p>
    </form>
  );
}
