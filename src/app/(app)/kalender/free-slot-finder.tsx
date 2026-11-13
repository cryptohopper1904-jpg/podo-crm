"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { CalendarSearch } from "lucide-react";
import { START_CHOICES, startDateFor, type StartChoice } from "@/lib/free-slots";

type T = { id: string; name: string };
type S = { id: string; code: string; name: string; durationMin: number };
export type PickedSlot = { date: string; time: string; therapistId: string };

const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const label = (iso: string) => `${WD[new Date(`${iso}T12:00:00Z`).getUTCDay()]} ${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}.`;

/**
 * „Freien Termin finden“: ab sofort / morgen / in 1–6 Wochen (oder ab Datum) die nächsten freien Zeiten
 * – unter Beachtung von Terminen, Abwesenheiten und Arbeitszeiten (Server: /kalender/freie-termine).
 * Ohne `onPick` führen die Vorschläge zum Formular „Neuer Termin“ (vorausgefüllt), mit `onPick` füllen sie das offene Formular.
 */
export function FreeSlotFinder({
  todayIso,
  team,
  defaultTherapistId,
  services,
  duration,
  onPick,
  canCreate = true,
}: {
  todayIso: string;
  team: T[];
  defaultTherapistId: string;
  services?: S[];
  /** Dauer aus dem Formular (Leistungen); ändert sich mit */
  duration?: number;
  onPick?: (s: PickedSlot) => void;
  canCreate?: boolean;
}) {
  const [choice, setChoice] = useState<StartChoice | "datum">("sofort");
  const [custom, setCustom] = useState(todayIso);
  const [therapist, setTherapist] = useState(team.some((t) => t.id === defaultTherapistId) ? defaultTherapistId : "");
  const [serviceId, setServiceId] = useState("");
  const [ownDuration, setOwnDuration] = useState<string | null>(null);
  const [result, setResult] = useState<{ slots: PickedSlot[]; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const serviceDuration = services?.find((s) => s.id === serviceId)?.durationMin;
  const typed = ownDuration !== null ? Math.round(Number(ownDuration)) : NaN;
  const dur = typed >= 5 && typed <= 480 ? typed : serviceDuration ?? duration ?? 30;
  const names = new Map(team.map((t) => [t.id, t.name]));

  // nur die Antwort der LETZTEN Suche zählt (schnelles Umschalten „sofort“ → „4 Wochen“)
  const lastSearch = useRef<AbortController | null>(null);
  async function search(c: StartChoice | "datum" = choice) {
    const ab = c === "datum" ? custom : startDateFor(c, todayIso);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ab)) return;
    lastSearch.current?.abort();
    const ctrl = new AbortController();
    lastSearch.current = ctrl;
    setBusy(true);
    try {
      const p = new URLSearchParams({ ab, dauer: String(dur) });
      if (therapist) p.set("behandler", therapist);
      const res = await fetch(`/kalender/freie-termine?${p}`, { signal: ctrl.signal, headers: { accept: "application/json" } });
      const json = res.headers.get("content-type")?.includes("json") ? ((await res.json()) as { slots?: PickedSlot[]; error?: string }) : null;
      setResult(res.ok && json?.slots ? { slots: json.slots } : { slots: [], error: json?.error ?? "Suche nicht möglich – bitte erneut versuchen." });
    } catch {
      if (ctrl.signal.aborted) return;
      setResult({ slots: [], error: "Keine Verbindung – bitte erneut versuchen." });
    } finally {
      if (lastSearch.current === ctrl) setBusy(false);
    }
  }

  const href = (s: PickedSlot) => {
    const p = new URLSearchParams({ datum: s.date, zeit: s.time, behandler: s.therapistId, dauer: String(dur) });
    if (serviceId) p.set("leistung", serviceId);
    return `/kalender/neu?${p}`;
  };
  const chip = (active: boolean) => `h-10 rounded-xl px-3 text-sm font-semibold ${active ? "bg-primary text-on-primary" : "border border-border bg-surface hover:bg-surface-2"}`;

  return (
    <details className="group rounded-[var(--radius-card)] border border-border bg-surface">
      <summary className="flex h-12 cursor-pointer list-none items-center gap-2 px-4 font-semibold [&::-webkit-details-marker]:hidden">
        <CalendarSearch size={18} aria-hidden className="text-primary" /> Freien Termin finden
        <span className="ml-auto text-sm font-normal text-muted group-open:hidden">anzeigen</span>
      </summary>
      <div className="flex flex-col gap-3 border-t border-border p-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Ab wann">
          {START_CHOICES.map(([value, text]) => (
            <button key={value} type="button" className={chip(choice === value)} aria-pressed={choice === value} onClick={() => { setChoice(value); void search(value); }}>
              {text}
            </button>
          ))}
          <label className={`${chip(choice === "datum")} inline-flex items-center gap-2`}>
            ab
            <input
              type="date"
              value={custom}
              min={todayIso}
              onChange={(e) => { setCustom(e.target.value); setChoice("datum"); }}
              className="bg-transparent text-sm outline-none"
              aria-label="ab Datum"
            />
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {services?.length ? (
            <label className="flex flex-col gap-1 text-sm font-medium">
              Leistung
              <select value={serviceId} onChange={(e) => { setServiceId(e.target.value); setOwnDuration(null); }} className="h-11 rounded-xl border border-border bg-surface px-3">
                <option value="">– keine (Dauer frei) –</option>
                {services.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.durationMin} Min</option>)}
              </select>
            </label>
          ) : null}
          <label className="flex flex-col gap-1 text-sm font-medium">
            Dauer (Min)
            <input type="number" min={5} max={480} step={5} value={ownDuration ?? dur} onChange={(e) => setOwnDuration(e.target.value)} className="h-11 rounded-xl border border-border bg-surface px-3" />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Behandler:in
            <select value={therapist} onChange={(e) => setTherapist(e.target.value)} className="h-11 rounded-xl border border-border bg-surface px-3">
              <option value="">egal</option>
              {team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        </div>
        <div>
          <button type="button" onClick={() => void search()} disabled={busy} className="inline-flex h-11 items-center justify-center rounded-xl bg-primary px-4 text-[15px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50">
            {busy ? "Suche …" : "Freie Zeiten suchen"}
          </button>
        </div>
        {result ? (
          result.error ? (
            <p className="text-sm text-danger">{result.error}</p>
          ) : result.slots.length === 0 ? (
            <p className="text-sm text-muted">In den nächsten 6 Wochen ab diesem Datum ist keine passende Zeit frei (Arbeitszeiten, Abwesenheiten und Termine berücksichtigt).</p>
          ) : (
            <ul className="flex flex-wrap gap-2" aria-label="Freie Zeiten">
              {result.slots.map((s) => {
                const text = (
                  <>
                    <span className="font-semibold tabular-nums">{label(s.date)} {s.time}</span>
                    {!therapist || team.length > 1 ? <span className="text-xs text-muted">{names.get(s.therapistId)}</span> : null}
                  </>
                );
                const cls = "flex min-h-11 flex-col items-start justify-center rounded-xl border border-border bg-surface-2 px-3 py-1 text-left text-sm hover:border-primary hover:bg-primary-soft";
                return (
                  <li key={`${s.date}${s.time}${s.therapistId}`}>
                    {onPick ? (
                      <button type="button" className={cls} onClick={() => onPick(s)} title="Ins Formular übernehmen">{text}</button>
                    ) : canCreate ? (
                      <Link href={href(s)} className={cls} title="Neuen Termin zu dieser Zeit anlegen">{text}</Link>
                    ) : (
                      <span className={cls}>{text}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
      </div>
    </details>
  );
}
