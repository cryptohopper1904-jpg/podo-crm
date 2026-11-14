"use client";

import { ChevronDown, MoreHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { isNarrowCookie, NARROW_COOKIE, NARROW_QUERY } from "@/lib/calendar-grid";

/** Platzhalter im Link-Muster der Datumsauswahl */
export const DATE_SLOT = "__DATUM__";

/**
 * Titel des Kalenderkopfs als Datumsauswahl: Antippen öffnet den Datumswähler des Geräts, die Auswahl springt zum Tag
 * (`hrefPattern` mit Platzhalter DATE_SLOT, Ansicht/Optionen bleiben). Auf dem Handy der kurze Titel („Mo 16.11.“).
 */
export function DateJump({ value, label, shortLabel, hrefPattern }: { value: string; label: string; shortLabel: string; hrefPattern: string }) {
  const router = useRouter();
  return (
    <span className="relative inline-flex max-w-full min-w-0 items-center gap-1 rounded-lg hover:text-primary">
      <span className="truncate sm:hidden">{shortLabel}</span>
      <span className="wrap-break-word max-sm:hidden">{label}</span>
      <ChevronDown size={20} aria-hidden className="shrink-0 text-muted" />
      <input
        type="date"
        aria-label="Datum wählen"
        title="Datum wählen"
        value={value}
        onClick={(e) => {
          // Desktop-Browser öffnen den Wähler sonst nur über das (unsichtbare) Kalendersymbol
          try {
            e.currentTarget.showPicker();
          } catch {
            /* ältere Browser: Feld bekommt den Fokus, Tastatureingabe geht */
          }
        }}
        onChange={(e) => {
          const v = e.target.value;
          if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v !== value) router.push(hrefPattern.replace(DATE_SLOT, v));
        }}
        className="touch-compact absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </span>
  );
}

/**
 * „⋯“-Menü im Kalenderkopf (Handy): Einfach/Vollständig, Anzeige, Sperrzeit. Schließt bei Escape und Tippen daneben.
 * Inhalte bleiben eingehängt (nur verborgen), damit z. B. ein laufendes Absenden nicht abbricht.
 */
export function MoreMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      btn.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={box} className="relative shrink-0">
      <button
        ref={btn}
        type="button"
        aria-label="Weitere Kalender-Aktionen"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex size-11 cursor-pointer items-center justify-center rounded-xl border border-border bg-surface text-text hover:bg-surface-2"
      >
        <MoreHorizontal size={20} aria-hidden />
      </button>
      <div
        id={id}
        hidden={!open}
        className="absolute top-full right-0 z-40 mt-2 flex w-[min(18rem,calc(100vw-2rem))] flex-col gap-2 rounded-2xl border border-border bg-surface p-3 shadow-lg"
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Merkt im Cookie, ob der Bildschirm schmal ist (Handy) – der Server wählt damit den passenden Standard-Zeitraum
 * (Tag statt Woche). Stimmt die Annahme des Servers nicht (erster Aufruf, Drehen des iPads), wird neu geladen, aber
 * nur wenn die Adresse keinen Zeitraum vorgibt.
 */
export function ViewportDefault({ narrow, explicitView }: { narrow: boolean; explicitView: boolean }) {
  const router = useRouter();
  useEffect(() => {
    const mq = matchMedia(NARROW_QUERY);
    const sync = () => {
      const now = mq.matches;
      const stored = document.cookie.split("; ").find((c) => c.startsWith(`${NARROW_COOKIE}=`))?.split("=")[1];
      if (stored === undefined || isNarrowCookie(stored) !== now) {
        document.cookie = `${NARROW_COOKIE}=${now ? "1" : "0"}; path=/kalender; max-age=31536000; samesite=lax`;
      }
      if (!explicitView && now !== narrow) router.refresh();
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [narrow, explicitView, router]);
  return null;
}
