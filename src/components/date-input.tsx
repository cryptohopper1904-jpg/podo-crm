"use client";

import clsx from "clsx";
import { X } from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps } from "react";

/** Text für leere Datums-/Zeitfelder (statt des Browser-Platzhalters „TT.MM.JJJJ“ bzw. eines Datums in Akzentfarbe) */
export const EMPTY_TEXT: Record<string, string> = {
  date: "Kein Datum",
  time: "Keine Uhrzeit",
  "datetime-local": "Kein Zeitpunkt",
  month: "Kein Monat",
  week: "Keine Woche",
};

const str = (v: unknown) => (v == null ? "" : Array.isArray(v) ? v.join(",") : String(v));

/**
 * Datums-/Zeitfeld (über <Input type="date|time|…">, src/components/ui.tsx).
 * Safari/iPadOS zeigen ein leeres Feld mit einem Platzhalter-Datum, das wie ein gesetzter Wert aussieht. Leere Felder
 * bekommen deshalb `data-empty` (globals.css blendet die Browser-Anzeige aus) und zeigen gedämpft „Kein Datum“ bzw.
 * `placeholder` – solange das Feld nicht fokussiert ist. `clearable`: ×-Knopf (44 px) zum Leeren optionaler Felder.
 * Kontrollierte Felder (value) und unkontrollierte (defaultValue) werden beide unterstützt; nach einem Formular-Reset
 * und beim Verlassen des Feldes wird der Zustand neu gelesen (auch wenn ein Skript den Wert gesetzt hat).
 */
export function DateInput({ className, placeholder, clearable, onInput, onBlur, ...props }: ComponentProps<"input"> & { clearable?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const controlled = props.value !== undefined;
  const [emptyState, setEmptyState] = useState(() => str(props.defaultValue) === "");
  const empty = controlled ? str(props.value) === "" : emptyState;
  const sync = () => setEmptyState((ref.current?.value ?? "") === "");

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const onReset = () => setTimeout(() => setEmptyState((ref.current?.value ?? "") === ""), 0);
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, []);

  const text = placeholder || EMPTY_TEXT[props.type ?? "date"] || "Leer";
  const showClear = !!clearable && !empty && !props.disabled && !props.readOnly;
  return (
    <span className="relative block w-full min-w-0">
      <input
        ref={ref}
        data-empty={empty ? "" : undefined}
        className={clsx("peer", showClear && "pr-20", className)}
        onInput={(e) => {
          sync();
          onInput?.(e);
        }}
        onBlur={(e) => {
          sync();
          onBlur?.(e);
        }}
        {...props}
      />
      {empty ? (
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-[15px] text-muted peer-focus:hidden">
          {text}
        </span>
      ) : null}
      {showClear ? (
        <button
          type="button"
          aria-label={`${props.type === "time" ? "Uhrzeit" : "Datum"} leeren`}
          onClick={() => {
            const el = ref.current;
            if (!el) return;
            // Wert über den nativen Setter leeren, damit React (kontrollierte Felder) die Änderung erkennt
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            setter?.call(el, "");
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            sync();
            el.focus();
          }}
          className="absolute inset-y-0 right-9 inline-flex w-11 cursor-pointer items-center justify-center rounded-lg text-muted hover:text-text"
        >
          <X size={18} aria-hidden />
        </button>
      ) : null}
    </span>
  );
}
