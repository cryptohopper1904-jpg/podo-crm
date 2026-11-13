"use client";

import { useRef, useState, type SyntheticEvent } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { CalendarMode } from "@/lib/calendar-grid";
import type { CalendarOptions, OptionParam } from "@/lib/calendar-options";
import { TIME_BOUNDS } from "@/lib/calendar-options";
import { saveCalendarOptionsAction } from "./actions";

type Props = {
  mode: CalendarMode;
  options: CalendarOptions;
  /** false = Support-Modus: nichts speichern, Optionen nur per URL */
  persist: boolean;
  /** Felder, die beim Absenden erhalten bleiben (datum, ansicht, modus) */
  hidden: Record<string, string>;
  /** Bundesland der Praxis (Klartext) */
  stateName: string;
};

/**
 * „Anzeige“: Schalter für Feiertage, Schulferien, Abwesenheiten usw. – je Person gemerkt (sofort beim Umschalten).
 * Im Support-Modus wird nichts gespeichert: die Auswahl landet nur in der Adresse (URL-Parameter).
 */
export function CalendarOptionsPanel({ mode, options, persist, hidden, stateName }: Props) {
  const form = useRef<HTMLFormElement>(null);
  const submit = () => form.current?.requestSubmit();
  const full = mode === "full";
  // Ab sm: Panel unter dem Knopf – rechtsbündig, außer links wäre zu wenig Platz (z. B. iPad, Knopf in umbrochener Zeile)
  const [alignLeft, setAlignLeft] = useState(false);
  const onToggle = (e: SyntheticEvent<HTMLDetailsElement>) => {
    const el = e.currentTarget;
    if (el.open) setAlignLeft(el.getBoundingClientRect().right < 320 + 16);
  };

  const toggle = (name: OptionParam, checked: boolean, label: string, hint?: string) => (
    <label key={name} className="flex cursor-pointer items-start justify-between gap-3 rounded-lg px-2 py-2 hover:bg-surface-2">
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium">{label}</span>
        {hint ? <span className="text-xs text-muted">{hint}</span> : null}
      </span>
      <input type="hidden" name={name} value="0" />
      <input type="checkbox" role="switch" name={name} value="1" defaultChecked={checked} onChange={submit} className="peer sr-only" />
      <span
        aria-hidden
        className="relative mt-0.5 inline-flex h-6 w-10 shrink-0 rounded-full border border-border-strong bg-surface-2 transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-[1.125rem] after:rounded-full after:bg-surface after:shadow after:transition-transform peer-checked:border-primary peer-checked:bg-primary peer-checked:after:translate-x-4 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary"
      />
    </label>
  );

  const hours = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const select = "h-10 rounded-xl border border-border bg-surface px-2 text-sm";

  return (
    <details className="relative" onToggle={onToggle}>
      <summary className="inline-flex h-11 cursor-pointer list-none items-center gap-2 rounded-xl border border-border bg-surface px-3 text-sm font-semibold hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
        <SlidersHorizontal size={17} aria-hidden /> Anzeige
      </summary>
      <form
        ref={form}
        key={JSON.stringify(options)}
        action={persist ? saveCalendarOptionsAction : "/kalender"}
        method={persist ? undefined : "get"}
        className={`z-40 flex flex-col gap-1 rounded-xl border border-border bg-surface p-2 shadow-lg max-sm:fixed max-sm:inset-x-[max(1rem,env(safe-area-inset-left))] max-sm:top-[calc(5rem+env(safe-area-inset-top))] max-sm:max-h-[calc(100dvh-6rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] max-sm:overflow-y-auto sm:absolute sm:mt-2 sm:w-80 sm:max-w-[calc(100vw-2rem)] ${alignLeft ? "sm:left-0" : "sm:right-0"}`}
        aria-label="Anzeige-Optionen"
      >
        {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        {persist ? <input type="hidden" name="mode" value={mode} /> : null}
        {toggle("feiertage", options.holidays, "Feiertage", stateName)}
        {toggle("ferien", options.schoolHolidays, "Schulferien", `${stateName} · Quelle: KMK`)}
        {toggle("abwesend", options.absences, "Abwesenheiten (Team)", full ? "Hinweise in Kopfzeilen; Verfügbarkeit bleibt markiert" : "Hinweis je Tag")}
        {toggle("sperr", options.blocks, "Sperrzeiten", full ? "Pausen, Schulungen … einzeichnen; bleiben gesperrt" : "Hinweis je Tag; bleiben gesperrt")}
        {toggle("abgesagt", options.cancelled, "Abgesagte Termine")}
        {full ? toggle("az", options.workHours, "Arbeitszeiten schattieren") : <input type="hidden" name="az" value={options.workHours ? "1" : "0"} />}
        {toggle("kw", options.weekNumbers, "Kalenderwochen (KW)", "in Woche und Monat")}
        <label className="flex flex-col gap-1 px-2 py-2 text-sm font-medium">
          Wochenende
          <select name="we" defaultValue={options.weekend} onChange={submit} className={`${select} w-full`}>
            <option value="auto">Sa immer, So nur mit Terminen</option>
            <option value="alle">Sa und So</option>
            <option value="keine">nur Mo–Fr</option>
          </select>
        </label>
        {full ? (
          <fieldset className="flex items-center justify-between gap-2 px-2 py-2 text-sm font-medium">
            <legend className="sr-only">Zeitachse von–bis</legend>
            <span aria-hidden>Zeitachse</span>
            <span className="flex items-center gap-1">
              <select name="von" defaultValue={options.startHour} onChange={submit} className={select} aria-label="Zeitachse von (Uhr)">
                {hours(TIME_BOUNDS.minStart, TIME_BOUNDS.maxStart).map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}</option>)}
              </select>
              –
              <select name="bis" defaultValue={options.endHour} onChange={submit} className={select} aria-label="Zeitachse bis (Uhr)">
                {hours(TIME_BOUNDS.minEnd, TIME_BOUNDS.maxEnd).map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}</option>)}
              </select>
              Uhr
            </span>
          </fieldset>
        ) : (
          <>
            <input type="hidden" name="von" value={options.startHour} />
            <input type="hidden" name="bis" value={options.endHour} />
          </>
        )}
        <noscript>
          <button type="submit" className="m-2 h-10 rounded-xl bg-primary px-3 text-sm font-semibold text-on-primary">Übernehmen</button>
        </noscript>
        <p className="px-2 pt-1 text-xs text-muted">
          {persist ? "Wird für dich gemerkt. " : "Support-Modus: nur für diese Adresse, wird nicht gespeichert. "}
          Nur Anzeige – Buchung und freie Termine bleiben unverändert.
        </p>
        {persist ? (
          <button type="submit" name="reset" value="1" className="mx-2 mb-1 mt-1 h-9 rounded-lg border border-border text-sm font-semibold hover:bg-surface-2">
            Standard wiederherstellen
          </button>
        ) : null}
      </form>
    </details>
  );
}
