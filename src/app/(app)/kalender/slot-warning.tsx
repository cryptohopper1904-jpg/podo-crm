"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Clock } from "lucide-react";

type Status = {
  clashes: { start: string; end: string; unassigned: boolean }[];
  absent: boolean;
  outsideHours: boolean;
  /** überschneidende Sperrzeiten, z. B. „Pause 12:00–12:30“ (ältere Antworten ohne Feld → leer) */
  blocks?: string[];
  hours: { start: string; end: string }[];
  holiday: string | null;
};

export type SlotQuery = { therapistId: string; date: string; time: string; durationMin: number; excludeId?: string };

/** Liest die für die Belegungsprüfung nötigen Felder aus einem Formular (Datum, Uhrzeit, Dauer, Behandler:in). */
export function slotQueryFromForm(form: HTMLFormElement, fallbackDuration: number, excludeId?: string): SlotQuery {
  const fd = new FormData(form);
  const dur = Number(fd.get("durationMin"));
  return {
    therapistId: String(fd.get("therapistId") ?? ""),
    date: String(fd.get("date") ?? ""),
    time: String(fd.get("time") ?? ""),
    durationMin: Number.isFinite(dur) && dur >= 5 ? Math.min(480, Math.round(dur)) : fallbackDuration,
    excludeId,
  };
}

/**
 * Hinweis „belegt – nicht verfügbar“ im Terminformular: fragt die Belegung der gewählten Behandler:in ab
 * (andere Termine, Abwesenheit, Sperrzeiten, Arbeitszeit). Gespeichert wird trotzdem nur nach der serverseitigen Prüfung.
 */
export function SlotWarning({ query, override = "Trotzdem eintragen" }: { query: SlotQuery; override?: string }) {
  const [status, setStatus] = useState<{ key: string; data: Status } | null>(null);
  const valid = /^[0-9a-f-]{36}$/i.test(query.therapistId) && /^\d{4}-\d{2}-\d{2}$/.test(query.date) && /^\d{2}:\d{2}$/.test(query.time);
  const key = valid ? `${query.therapistId}|${query.date}|${query.time}|${query.durationMin}|${query.excludeId ?? ""}` : "";

  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      const p = new URLSearchParams({ behandler: query.therapistId, datum: query.date, zeit: query.time, dauer: String(query.durationMin) });
      if (query.excludeId) p.set("ohne", query.excludeId);
      try {
        const res = await fetch(`/kalender/belegung?${p}`, { signal: ctrl.signal, headers: { accept: "application/json" } });
        if (!res.ok || !res.headers.get("content-type")?.includes("json")) return;
        setStatus({ key, data: (await res.json()) as Status });
      } catch {
        // offline/abgebrochen: kein Hinweis – die Prüfung beim Speichern greift trotzdem
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [key, query.therapistId, query.date, query.time, query.durationMin, query.excludeId]);

  const s = status?.key === key ? status.data : null;
  if (!s) return null;
  const blocks = s.blocks ?? [];
  const blocked = s.clashes.length > 0 || s.absent || blocks.length > 0;
  if (!blocked && !s.outsideHours) return null;
  return (
    <div role="status" aria-live="polite" className={`flex gap-2 rounded-xl p-3 text-sm ${blocked ? "bg-accent-soft text-accent-soft-text" : "bg-warn-soft text-warn-soft-text"}`}>
      {blocked ? <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden /> : <Clock size={18} className="mt-0.5 shrink-0" aria-hidden />}
      <div>
        {s.absent ? <p><strong>Abwesend – nicht verfügbar:</strong> Die Behandler:in ist an diesem Tag laut Team-Planung abwesend.</p> : null}
        {s.clashes.length ? (
          <p>
            <strong>Belegt – nicht verfügbar:</strong> Die Behandler:in hat zu dieser Zeit bereits {s.clashes.length === 1 ? "einen Termin" : `${s.clashes.length} Termine`}:{" "}
            {s.clashes.map((c) => `${c.start}–${c.end} Uhr${c.unassigned ? " (ohne Behandler:in-Zuordnung)" : ""}`).join(", ")}.
          </p>
        ) : null}
        {blocks.length ? (
          <p>
            <strong>Sperrzeit – nicht verfügbar:</strong> {blocks.join(", ")}.
          </p>
        ) : null}
        {!s.absent && s.outsideHours ? (
          <p>
            <strong>Außerhalb der Arbeitszeit:</strong>{" "}
            {s.holiday ? `Feiertag (${s.holiday}).` : s.hours.length ? `an diesem Tag ${s.hours.map((h) => `${h.start}–${h.end}`).join(", ")} Uhr.` : "an diesem Tag keine Arbeitszeit eingetragen."}
          </p>
        ) : null}
        {blocked ? <p className="mt-1">Gespeichert wird nur nach Rückfrage („{override}“) – besser eine freie Zeit wählen.</p> : null}
      </div>
    </div>
  );
}
