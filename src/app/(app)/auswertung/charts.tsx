/**
 * Schlanke Diagramme der Auswertung (CSS/HTML, kein JavaScript im Browser, keine Chart-Bibliothek).
 * Eine Farbe (Primärfarbe, Hell/Dunkel über Design-Tokens), Werte immer zusätzlich als Text bzw. Tabelle.
 */
import type { ReactNode } from "react";
import { cx } from "@/components/ui";
import { heatLevel, type Heatmap, WEEKDAYS, WEEKDAYS_SHORT } from "@/lib/stats";
import { CsvButton } from "./csv-button";

const rowHeadCls = "text-[15px] font-normal";

/** Werte-Tabelle zum Aufklappen (Text-Alternative jedes Diagramms), optional mit CSV-Export */
export function ValuesTable({
  caption,
  head,
  rows,
  csv,
  open = false,
  summary = "Werte als Tabelle",
}: {
  caption: string;
  head: string[];
  /** erste Spalte = Zeilenkopf, weitere Spalten rechtsbündig */
  rows: ReactNode[][];
  /** CSV-Export (null = nicht anbieten, z. B. im Support-Modus) */
  csv?: { filename: string; rows: (string | number)[][] } | null;
  open?: boolean;
  summary?: string;
}) {
  return (
    <details className="mt-3" open={open}>
      <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-primary">{summary}</summary>
      {csv ? (
        <div className="flex justify-end">
          <CsvButton filename={csv.filename} rows={[head, ...csv.rows]} />
        </div>
      ) : null}
      {/* eigene Tabelle ohne Mindestbreite: passt auch in halbe Karten (iPad); breite Tabellen scrollen waagerecht */}
      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
        <table className="w-full border-collapse text-left text-[15px] [&_td]:border-t [&_td]:border-border [&_td]:px-3 [&_td]:py-2.5 [&_th]:px-3 [&_tbody_th]:border-t [&_tbody_th]:border-border [&_tbody_th]:py-2.5 [&_thead_th]:bg-surface-2 [&_thead_th]:py-2 [&_thead_th]:text-xs [&_thead_th]:font-semibold [&_thead_th]:uppercase [&_thead_th]:tracking-wide [&_thead_th]:text-muted">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} scope="col" className={i ? "text-right" : undefined}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) =>
                ci === 0 ? (
                  <th key={ci} scope="row" className={rowHeadCls}>
                    {c}
                  </th>
                ) : (
                  <td key={ci} className="text-right tabular-nums">
                    {c}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
        </table>
      </div>
    </details>
  );
}

/** Rangliste mit waagerechten Balken (Text und Wert sichtbar, Balken nur Dekoration) */
export function HBars({ items, empty = "Keine Daten im Zeitraum" }: { items: { label: string; value: number; display: string; sub?: string }[]; empty?: string }) {
  if (!items.length) return <p className="text-sm text-muted">{empty}</p>;
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ol className="flex flex-col gap-3">
      {items.map((it, i) => (
        <li key={`${it.label}-${i}`}>
          <div className="flex justify-between gap-3 text-[15px]">
            <span className="min-w-0 truncate">
              <span className="mr-1.5 text-sm text-muted tabular-nums">{i + 1}.</span>
              {it.label}
              {it.sub ? <span className="text-sm text-muted"> · {it.sub}</span> : null}
            </span>
            <span className="shrink-0 font-semibold tabular-nums">{it.display}</span>
          </div>
          <div className="mt-1 h-2 rounded-full bg-surface-2" aria-hidden>
            <div className="h-2 rounded-full bg-primary" style={{ width: `${Math.max(1, (it.value / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Säulendiagramm (eine Reihe); `label` beschreibt es für Screenreader, Werte stehen in title und Tabelle */
export function Columns({ items, label, height = "h-44" }: { items: { label: string; value: number; display: string; strong?: boolean }[]; label: string; height?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <figure>
      <figcaption className="sr-only">{`${label}: ${items.map((i) => `${i.label} ${i.display}`).join(", ")}`}</figcaption>
      <div className={cx("flex items-end gap-1 overflow-x-auto sm:gap-2", height)} aria-hidden>
        {items.map((it) => (
          <div key={it.label} className="flex h-full min-w-8 flex-1 flex-col items-center justify-end gap-1" title={`${it.label}: ${it.display}`}>
            {items.length <= 8 ? <span className="text-[11px] tabular-nums text-muted">{it.value ? it.display : ""}</span> : null}
            <div
              className={cx("w-full max-w-10 rounded-t", it.strong ? "bg-primary" : "bg-primary/55")}
              style={{ height: `${it.value ? Math.max(2, (it.value / max) * 80) : 0}%` }}
            />
            <span className="text-[11px] text-muted">{it.label}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

/**
 * Farbstufen (eine Farbe, hell → dunkel). Kontrast der Zellenschrift (12 px) nach WCAG AA ≥ 4,5:1 in Hell und Dunkel:
 * Stufe 1–3 Primärfarbe mit 15/30/45 % Deckkraft + Textfarbe (hell ≥ 7,9:1, dunkel ≥ 4,9:1), Stufe 4 volle Primärfarbe
 * + on-primary (hell 4,9:1, dunkel 7,5:1). Mehr Deckkraft mit Textfarbe fällt im Dunkelmodus unter 4,5:1.
 */
const HEAT_CLS = ["bg-surface-2/60 text-muted", "bg-primary/15 text-text", "bg-primary/30 text-text", "bg-primary/45 text-text", "bg-primary text-on-primary"];

/**
 * Heatmap Wochentag × Stunde als echte Tabelle: jede Zelle trägt ihren Wert als Text (barrierearm, druckbar),
 * die Farbstufe (eine Farbe, hell → dunkel) ist nur Zusatz.
 */
export function HeatmapTable({
  heat,
  caption,
  cell,
  title,
  legend,
}: {
  heat: Heatmap;
  caption: string;
  /** Text in der Zelle */
  cell: (v: number, day: number, hour: number) => string;
  /** Tooltip / Screenreader-Text einer Zelle */
  title: (v: number | null, day: number, hour: number) => string;
  legend: [string, string];
}) {
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-separate border-spacing-0.5 text-center text-[12px]">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col" className="w-10">
                <span className="sr-only">Wochentag</span>
              </th>
              {heat.hours.map((h) => (
                <th key={h} scope="col" className="pb-1 font-medium text-muted">
                  {h}
                  <span className="sr-only"> Uhr</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {heat.days.map((d) => (
              <tr key={d}>
                <th scope="row" className="pr-1 text-left font-semibold">
                  <abbr title={WEEKDAYS[d]} className="no-underline">
                    {WEEKDAYS_SHORT[d]}
                  </abbr>
                </th>
                {heat.hours.map((h, hi) => {
                  const v = heat.cells[d][hi];
                  return (
                    <td key={h} title={title(v, d, h)} className={cx("h-9 min-w-9 rounded-md tabular-nums", HEAT_CLS[heatLevel(v, heat.max)])}>
                      {v === null ? <span className="sr-only">{title(v, d, h)}</span> : cell(v, d, h)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs text-muted" aria-hidden>
        <span>{legend[0]}</span>
        {HEAT_CLS.slice(1).map((c) => (
          <span key={c} className={cx("size-4 rounded", c)} />
        ))}
        <span>{legend[1]}</span>
      </div>
    </div>
  );
}

/** Kennzahl klein (für Zeilen unter Karten) */
export function KeyValue({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-[13px] text-muted">{hint}</p> : null}
    </div>
  );
}
