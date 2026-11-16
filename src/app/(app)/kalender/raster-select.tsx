"use client";

import { useRef } from "react";
import { Rows3 } from "lucide-react";
import { SLOT_STEP_SHORT, SLOT_STEPS, type SlotStep } from "@/lib/calendar-grid";
import { setCalendarSlotAction } from "./actions";

/**
 * Auswahl „Raster“ in der Kalender-Werkzeugleiste (Tag/Woche): setzt dieselbe persönliche Einstellung wie
 * Einstellungen → Kalender und lädt die Ansicht neu. In der einfachen Ansicht (Liste ohne Zeitachse) wechselt die Auswahl
 * zusätzlich in die vollständige Ansicht (`switchToFull`), damit das Raster sichtbar wird. Ohne Recht (Support-Modus) nur
 * Anzeige – der Server prüft das Recht ohnehin selbst (setCalendarSlotAction).
 */
export function RasterSelect({ slot, editable, back, wide = false, switchToFull = false }: { slot: SlotStep; editable: boolean; back: string; wide?: boolean; switchToFull?: boolean }) {
  const form = useRef<HTMLFormElement>(null);
  const box = `inline-flex h-11 items-center gap-2 rounded-xl border border-border bg-surface pl-3 text-sm font-semibold ${wide ? "w-full" : ""}`;
  if (!editable) {
    return (
      <span className={`${box} pr-3 text-muted`} title="Raster der Zeitachse – im Support-Modus nicht änderbar" data-testid="raster-anzeige">
        <Rows3 size={17} aria-hidden /> Raster {SLOT_STEP_SHORT[slot]}
      </span>
    );
  }
  return (
    <form ref={form} action={setCalendarSlotAction} className={wide ? "w-full" : undefined}>
      <input type="hidden" name="back" value={back} />
      {switchToFull ? <input type="hidden" name="mode" value="full" /> : null}
      <label
        className={`${box} cursor-pointer pr-1 hover:bg-surface-2`}
        title={`Raster der Zeitachse (wird für dich gemerkt, auch unter Einstellungen → Kalender)${switchToFull ? " – wechselt in die vollständige Ansicht mit Zeitachse" : ""}`}
      >
        <Rows3 size={17} aria-hidden />
        <span>Raster</span>
        <select
          name="slotMin"
          defaultValue={slot}
          key={slot}
          onChange={() => form.current?.requestSubmit()}
          className={`h-9 cursor-pointer rounded-lg bg-transparent px-1 text-[15px] font-semibold focus:outline-2 focus:outline-primary ${wide ? "ml-auto" : ""}`}
          aria-label="Raster der Zeitachse"
        >
          {SLOT_STEPS.map((s) => (
            <option key={s} value={s}>{SLOT_STEP_SHORT[s]}</option>
          ))}
        </select>
      </label>
      <noscript>
        <button type="submit" className="ml-2 h-11 rounded-xl border border-border px-3 text-sm font-semibold">Übernehmen</button>
      </noscript>
    </form>
  );
}
