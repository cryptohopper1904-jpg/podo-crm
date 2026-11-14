"use client";

import clsx from "clsx";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

/**
 * Kurze Rückmeldungen („Termin abgesagt“, „Gespeichert“) unten über der Bottom-Navigation, optional mit Aktion
 * („Rückgängig“). Aufruf aus Client-Komponenten:
 *
 *   toast("Termin abgesagt", { action: { label: "Rückgängig", onClick: () => undo() } });
 *   toast("Konnte nicht speichern", { tone: "error" });
 *
 * Eine <Toaster/>-Fläche wird beim ersten Aufruf selbst angelegt (kein Eintrag im Layout nötig); sie ist eine
 * aria-live-Region (höflich, Fehler: assertive über role="alert"). Anzeigedauer 5 s (mit Aktion 8 s), pausiert bei
 * Maus-/Tastaturfokus; Schließen-Knopf 44 px. Abstand unten: --podo-toast-bottom (globals.css) – liegt also über
 * Bottom-Navigation, Home-Leiste (Safe-Area) und einer klebenden Formular-Aktionsleiste.
 */
export type ToastTone = "success" | "error" | "info";
export type ToastOptions = { tone?: ToastTone; action?: { label: string; onClick: () => void }; duration?: number };
export type ToastItem = { id: number; message: string; tone: ToastTone; action?: ToastOptions["action"]; duration: number };

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => items;
const empty: ToastItem[] = [];

/** höchstens so viele Meldungen gleichzeitig (älteste fällt weg) */
export const MAX_TOASTS = 3;

export function addToast(list: ToastItem[], item: ToastItem): ToastItem[] {
  return [...list, item].slice(-MAX_TOASTS);
}

/**
 * Eingehängte Flächen. Nur die erste zeigt Meldungen – auch wenn zusätzlich eine <Toaster/> ins Layout gesetzt wird,
 * gibt es nie zwei Regionen (doppelte Anzeige/Ansage).
 */
const owners: object[] = [];
const firstOwner = () => owners[0] ?? null;
let autoHost = false;
function ensureMounted() {
  if (autoHost || owners.length > 0 || typeof document === "undefined") return false;
  const host = document.createElement("div");
  host.dataset.podoToaster = "";
  document.body.appendChild(host);
  // gilt ab sofort als vorhanden (auch bevor der Effekt der neuen Fläche läuft) – nie eine zweite anlegen
  autoHost = true;
  createRoot(host).render(<Toaster />);
  return true;
}

export function toast(message: string, opts: ToastOptions = {}): number {
  const id = nextId++;
  const item: ToastItem = { id, message, tone: opts.tone ?? "success", action: opts.action, duration: opts.duration ?? (opts.action ? 8000 : 5000) };
  // Frisch angelegte Live-Region: Meldung einen Moment später einfügen, sonst lesen Screenreader sie nicht vor
  const fresh = ensureMounted();
  const push = () => {
    items = addToast(items, item);
    emit();
  };
  if (fresh) setTimeout(push, 120);
  else push();
  return id;
}

export function dismissToast(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

const ICON = { success: CircleCheck, error: CircleAlert, info: Info } as const;

type Hold = "hover" | "press" | "focus";

function ToastCard({ t }: { t: ToastItem }) {
  // Anhalten, solange die Maus darüber ist, ein Finger/Stift draufhält oder der Fokus darin liegt
  const [holds, setHolds] = useState<Record<Hold, boolean>>({ hover: false, press: false, focus: false });
  const hold = (k: Hold, on: boolean) => setHolds((h) => (h[k] === on ? h : { ...h, [k]: on }));
  const paused = holds.hover || holds.press || holds.focus;
  const left = useRef(t.duration);
  useEffect(() => {
    if (paused) return;
    const start = Date.now();
    const timer = setTimeout(() => dismissToast(t.id), left.current);
    return () => {
      clearTimeout(timer);
      left.current -= Date.now() - start;
    };
  }, [paused, t.id]);
  const Icon = ICON[t.tone];
  return (
    <div
      role={t.tone === "error" ? "alert" : undefined}
      onPointerEnter={(e) => e.pointerType === "mouse" && hold("hover", true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && hold("hover", false)}
      onPointerDown={(e) => e.pointerType !== "mouse" && hold("press", true)}
      onPointerUp={() => hold("press", false)}
      onPointerCancel={() => hold("press", false)}
      onFocus={() => hold("focus", true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && hold("focus", false)}
      className="pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-2xl border border-border bg-surface py-1 pr-1 pl-4 text-[15px] text-text shadow-lg motion-safe:animate-rise"
    >
      <Icon size={18} aria-hidden className={clsx("shrink-0", t.tone === "error" ? "text-danger" : t.tone === "info" ? "text-muted" : "text-primary")} />
      <p className="min-w-0 flex-1 py-2.5">{t.message}</p>
      {t.action ? (
        <button
          type="button"
          onClick={() => {
            t.action?.onClick();
            dismissToast(t.id);
          }}
          className="h-11 shrink-0 cursor-pointer rounded-xl px-3 font-semibold text-primary hover:bg-surface-2"
        >
          {t.action.label}
        </button>
      ) : null}
      <button type="button" aria-label="Meldung schließen" onClick={() => dismissToast(t.id)} className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-text">
        <X size={18} aria-hidden />
      </button>
    </div>
  );
}

/** Fläche für Meldungen. Wird von toast() automatisch angelegt; kann auch ausdrücklich in ein Layout gesetzt werden. */
export function Toaster() {
  const list = useSyncExternalStore(subscribe, snapshot, () => empty);
  const [token] = useState(() => ({}));
  const owner = useSyncExternalStore(subscribe, firstOwner, () => null);
  useEffect(() => {
    owners.push(token);
    emit();
    return () => {
      owners.splice(owners.indexOf(token), 1);
      emit();
    };
  }, [token]);
  if (owner !== token) return null;
  return (
    <div
      aria-live="polite"
      className="no-print pointer-events-none fixed inset-x-0 bottom-[var(--podo-toast-bottom)] z-50 flex flex-col items-center gap-2 pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]"
    >
      {list.map((t) => (
        <ToastCard key={t.id} t={t} />
      ))}
    </div>
  );
}
