"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Field, Select } from "@/components/ui";

type Option = { id: string; label: string; remaining: number; units: number };
type Result = { options: Option[]; selectedId: string | null; warnings: string[] };

export type PlannerQuery = { patientId: string; date: string; repeatWeeks: number; repeatCount: number };

/**
 * Verordnung im Terminformular: Auswahl (vorgeschlagen: laufende Verordnung der Person) und Warnungen zur geplanten
 * Serie – Restmenge, Beginnfrist, Unterbrechung, Frequenz (src/server/appointment-prescriptions.ts). Nur Hinweise.
 */
export function PrescriptionPlanner({ query }: { query: PlannerQuery }) {
  // "auto" = Vorschlag des Servers übernehmen, "" = ohne Verordnung, sonst gewählte ID
  const [choice, setChoice] = useState<string>("auto");
  const [res, setRes] = useState<{ key: string; data: Result } | null>(null);
  const valid = /^[0-9a-f-]{36}$/i.test(query.patientId) && /^\d{4}-\d{2}-\d{2}$/.test(query.date);
  const key = valid ? `${query.patientId}|${query.date}|${query.repeatWeeks}|${query.repeatCount}|${choice}` : "";
  const [lastPatient, setLastPatient] = useState(query.patientId);
  if (lastPatient !== query.patientId) {
    setLastPatient(query.patientId);
    setChoice("auto");
  }

  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      const p = new URLSearchParams({ patient: query.patientId, datum: query.date, wochen: String(query.repeatWeeks), anzahl: String(query.repeatCount) });
      if (choice !== "auto") p.set("vo", choice);
      try {
        const r = await fetch(`/kalender/verordnung?${p}`, { signal: ctrl.signal, headers: { accept: "application/json" } });
        if (!r.ok || !r.headers.get("content-type")?.includes("json")) return;
        setRes({ key, data: (await r.json()) as Result });
      } catch {
        // offline/abgebrochen: keine Auswahl – der Termin lässt sich trotzdem ohne Verordnung anlegen
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [key, query.patientId, query.date, query.repeatWeeks, query.repeatCount, choice]);

  const data = res?.key === key ? res.data : null;
  if (!valid || !data || !data.options.length) return <input type="hidden" name="prescriptionId" value="" />;
  const selected = choice === "auto" ? (data.selectedId ?? "") : choice;
  return (
    <div className="flex flex-col gap-2" data-testid="termin-verordnung">
      <Field label="Verordnung (GKV)" hint="Termin auf eine laufende Verordnung planen – Einheit wird erst mit der Behandlungsdoku gezählt.">
        <Select name="prescriptionId" value={selected} onChange={(e) => setChoice(e.target.value)}>
          <option value="">– ohne Verordnung –</option>
          {data.options.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </Select>
      </Field>
      {selected && data.warnings.length ? (
        <ul role="status" className="flex flex-col gap-1">
          {data.warnings.map((w) => (
            <li key={w} className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn-soft-text">
              <AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0" />
              {w}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
