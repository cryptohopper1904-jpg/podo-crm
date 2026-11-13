"use client";

import { useState } from "react";

const inputCls = "h-11 rounded-xl border border-border bg-surface px-3.5 text-[15px] text-text";

/**
 * Zeitraum-Auswahl: fester Zeitraum oder „Frei wählen“ mit Von/Bis.
 * Ohne JavaScript bleiben alle Felder sichtbar; mit JavaScript schaltet eine Datumsänderung auf „Frei wählen“.
 */
export function PeriodSelect({ presets, preset, from, to }: { presets: [string, string][]; preset: string; from: string; to: string }) {
  const [value, setValue] = useState(preset);
  const free = value === "frei";
  return (
    <>
      <label className="flex min-w-44 flex-col gap-1.5">
        <span className="text-sm font-medium">Zeitraum</span>
        <select name="zeitraum" value={value} onChange={(e) => setValue(e.target.value)} className={`${inputCls} pr-8`}>
          {presets.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">von</span>
        <input type="date" name="von" defaultValue={from} onChange={() => setValue("frei")} className={inputCls} aria-describedby={free ? undefined : "period-free-hint"} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">bis</span>
        <input type="date" name="bis" defaultValue={to} onChange={() => setValue("frei")} className={inputCls} aria-describedby={free ? undefined : "period-free-hint"} />
      </label>
      <span id="period-free-hint" className="sr-only">
        Von und Bis gelten bei „Frei wählen“.
      </span>
    </>
  );
}
