"use client";

import { Plus, Trash2 } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Button, Field, FieldSlot, Input } from "@/components/ui";
import { MAX_WINDOWS_PER_DAY, validateWeek, WEEKDAY_LONG, WEEKDAY_NUMBERS, type Weekday, type WeekHours } from "@/lib/opening-hours";

type Win = { start: string; end: string };
type Draft = Record<Weekday, Win[]>;

const toMin = (t: string) => (/^\d{2}:\d{2}$/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : NaN);
const toHhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const LAST = 23 * 60 + 55;

/**
 * Zeitfelder auf dem Handy: Von, Bis und Löschen stehen in einer Zeile (auch auf 320 px). Dafür weniger Innenabstand
 * und auf schmalen Bildschirmen ohne Uhr-Symbol (ein Tipp ins Feld öffnet auf dem Handy ohnehin die Zeitauswahl), damit „08:00“ lesbar bleibt.
 */
const timeCls = "px-2.5! tabular-nums sm:px-3.5! max-sm:[&::-webkit-calendar-picker-indicator]:hidden";

/** Vorschlag für ein weiteres Zeitfenster: 30 Min. nach dem letzten Ende, 2 Std. lang (im 5-Min-Raster). */
function nextWindow(days: Win[]): Win {
  const lastEnd = toMin(days[days.length - 1]?.end ?? "");
  if (Number.isNaN(lastEnd)) return { start: "08:00", end: "12:00" };
  const start = Math.min(Math.ceil((lastEnd + 30) / 5) * 5, LAST - 5);
  return { start: toHhmm(start), end: toHhmm(Math.min(start + 120, LAST)) };
}

/**
 * Öffnungszeiten je Wochentag bearbeiten: Tag an/aus, ein bis mehrere Zeitfenster (z. B. Mittagspause),
 * „auf Mo–Fr übernehmen“. Schickt die Zeiten als JSON-Liste im versteckten Feld `name`; geprüft wird
 * serverseitig (validateWeek) – hier dieselbe Prüfung als Live-Hinweis.
 */
export function OpeningHoursEditor({ name, initial, legend = "Öffnungszeiten" }: { name: string; initial: WeekHours; legend?: string }) {
  const [days, setDays] = useState<Draft>(() => Object.fromEntries(WEEKDAY_NUMBERS.map((d) => [d, initial[d].map((r) => ({ ...r }))])) as Draft);
  const ids = useId();
  const list = useMemo(() => WEEKDAY_NUMBERS.flatMap((d) => days[d].map((r) => ({ weekday: d, from: r.start, to: r.end }))), [days]);
  const problem = validateWeek(list).error;

  const set = (d: Weekday, w: Win[]) => setDays((prev) => ({ ...prev, [d]: w }));
  const toggle = (d: Weekday, open: boolean) => {
    if (!open) return set(d, []);
    // Beim Öffnen die Zeiten des nächsten geöffneten Vortags übernehmen (sonst 08–18 Uhr)
    const prev = [...WEEKDAY_NUMBERS].reverse().find((x) => x < d && days[x].length);
    set(d, prev ? days[prev].map((r) => ({ ...r })) : [{ start: "08:00", end: "18:00" }]);
  };
  const copyToWeekdays = (d: Weekday) =>
    setDays((prev) => {
      const next = { ...prev };
      for (const x of [1, 2, 3, 4, 5] as const) next[x] = prev[d].map((r) => ({ ...r }));
      return next;
    });

  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">{legend}</legend>
      <input type="hidden" name={name} value={JSON.stringify(list)} />
      <div className="divide-y divide-border rounded-xl border border-border">
        {WEEKDAY_NUMBERS.map((d) => {
          const wins = days[d];
          const open = wins.length > 0;
          const dayName = WEEKDAY_LONG[d];
          const switchId = `${ids}-open-${d}`;
          return (
            <div key={d} className="flex flex-col gap-3 p-3 sm:p-4 md:grid md:grid-cols-[10rem_minmax(0,1fr)] md:gap-4" data-weekday={d}>
              <div className="flex min-h-11 items-center justify-between gap-3 md:self-start">
                <label htmlFor={switchId} className="min-w-0 font-semibold">{dayName}</label>
                <label className="flex min-h-11 shrink-0 cursor-pointer items-center" title={open ? "geöffnet" : "geschlossen"}>
                  <input id={switchId} type="checkbox" role="switch" aria-label={`${dayName} geöffnet`} checked={open} onChange={(e) => toggle(d, e.target.checked)} className="peer sr-only" />
                  <span
                    aria-hidden
                    className="relative inline-flex h-6 w-10 shrink-0 rounded-full border border-border-strong bg-surface-2 transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-[1.125rem] after:rounded-full after:bg-surface after:shadow after:transition-transform peer-checked:border-primary peer-checked:bg-primary peer-checked:after:translate-x-4 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary"
                  />
                </label>
              </div>
              {open ? (
                <div className="flex min-w-0 flex-col gap-3">
                  {wins.map((w, i) => (
                    <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-x-2 sm:max-w-xl sm:gap-x-3">
                      <Field label="Von">
                        <Input type="time" step={300} required className={timeCls} value={w.start} onChange={(e) => set(d, wins.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} aria-label={`${dayName}, ${i + 1}. Zeitfenster von`} />
                      </Field>
                      <Field label="Bis">
                        <Input type="time" step={300} required className={timeCls} value={w.end} onChange={(e) => set(d, wins.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} aria-label={`${dayName}, ${i + 1}. Zeitfenster bis`} />
                      </Field>
                      <FieldSlot>
                        <Button type="button" variant="ghost" className="w-11 px-0!" onClick={() => set(d, wins.filter((_, j) => j !== i))} aria-label={`${dayName}: ${i + 1}. Zeitfenster entfernen`} title="Zeitfenster entfernen">
                          <Trash2 size={18} aria-hidden />
                        </Button>
                      </FieldSlot>
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-2">
                    {wins.length < MAX_WINDOWS_PER_DAY ? (
                      <Button type="button" variant="secondary" onClick={() => set(d, [...wins, nextWindow(wins)])} aria-label={`${dayName}: Zeitfenster hinzufügen`}>
                        <Plus size={18} aria-hidden /> Zeitfenster
                      </Button>
                    ) : null}
                    <Button type="button" variant="ghost" onClick={() => copyToWeekdays(d)} aria-label={`Zeiten von ${dayName} auf Montag bis Freitag übernehmen`}>
                      Auf Mo–Fr übernehmen
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="flex min-h-11 items-center text-sm text-muted">geschlossen</p>
              )}
            </div>
          );
        })}
      </div>
      <p aria-live="polite" className={problem ? "mt-3 rounded-xl bg-warn-soft p-3 text-sm font-medium text-warn-soft-text" : "sr-only"}>
        {problem ?? ""}
      </p>
    </fieldset>
  );
}
