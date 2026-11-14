"use client";

import { Minus, Plus } from "lucide-react";

/**
 * −/+-Knopf neben einem Zahlenfeld (<Input type="number" stepper>, src/components/ui.tsx). Ändert den Wert über
 * stepUp/stepDown (beachtet min/max/step) und meldet ihn wie eine Eingabe (input + change), damit kontrollierte
 * Felder (React onChange) und Formular-onChange mitbekommen. 44 × 44 px (ragt 1 px über den Feldrahmen; `touch-compact`: keine zusätzliche Mindesthöhe, die über den Rahmen ragen würde).
 */
export function StepButton({ dir, label, disabled }: { dir: 1 | -1; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        const input = e.currentTarget.parentElement?.querySelector<HTMLInputElement>("input[type=number]");
        if (!input || input.disabled || input.readOnly) return;
        const before = input.value;
        try {
          if (dir > 0) input.stepUp();
          else input.stepDown();
        } catch {
          return;
        }
        if (input.value === before) return;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }}
      className="touch-compact -my-px inline-flex h-[calc(100%+2px)] w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
    >
      {dir > 0 ? <Plus size={18} aria-hidden /> : <Minus size={18} aria-hidden />}
    </button>
  );
}
