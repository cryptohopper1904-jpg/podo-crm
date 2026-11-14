"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * Konto-Menü in der Kopfzeile (unter lg, also Handy und Tablet hochkant): ein Knopf mit den Initialen statt vier
 * einzelner Symbol-Knöpfe – darin Praxis wechseln, Neuigkeiten, Einstellungen, Hell/Dunkel und Abmelden (`children`,
 * vom Server-Layout gerendert). Schließt mit Esc, bei Klick daneben und nach Auswahl eines Links/Formulars.
 */
export function AccountMenu({ initials, name, meta, className = "", children }: { initials: string; name: string; meta: string; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <div ref={root} className={`relative shrink-0 ${className}`}>
      <button
        ref={button}
        type="button"
        aria-label="Konto-Menü"
        title={`${name} · ${meta}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-11 cursor-pointer items-center justify-center rounded-full border border-border bg-surface-2 text-sm font-semibold hover:bg-surface aria-expanded:border-primary"
      >
        {initials || "?"}
      </button>
      <div
        id={id}
        hidden={!open}
        onClick={(e) => {
          // Auswahl getroffen (Link oder Formular, z. B. Praxis wechseln/Abmelden) → Menü zu; Hell/Dunkel lässt es offen
          if ((e.target as HTMLElement).closest("a, button[type=submit]")) setOpen(false);
        }}
        className="absolute right-0 top-full z-40 mt-2 max-h-[calc(100dvh-5rem)] w-[min(20rem,calc(100vw-1.5rem))] overflow-y-auto overscroll-contain rounded-xl border border-border bg-surface p-1.5 text-text shadow-lg"
      >
        <div className="border-b border-border px-3 pb-2.5 pt-1.5">
          <p className="truncate font-semibold">{name}</p>
          <p className="truncate text-sm text-muted">{meta}</p>
        </div>
        <div className="flex flex-col pt-1.5">{children}</div>
      </div>
    </div>
  );
}
