"use client";

import { GripHorizontal, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { toast } from "@/components/toaster";
import { clampPosition, initialPosition, prefillFromHref, type NewPrefill, type Point } from "@/lib/calendar-dialog";
import { NARROW_QUERY } from "@/lib/calendar-grid";
import { AppointmentForm } from "./neu/appointment-form";
import type { NewAppointmentData } from "./neu/data";

/** Fenstergröße (Desktop/iPad) – für die Startposition; die echte Größe wird nach dem Öffnen gemessen */
const SIZE = { width: 576, height: 640 };

const subscribeNarrow = (cb: () => void) => {
  const mq = matchMedia(NARROW_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const useNarrow = () => useSyncExternalStore(subscribeNarrow, () => matchMedia(NARROW_QUERY).matches, () => false);

const FOCUSABLE = 'a[href]:not([tabindex="-1"]), button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

type Open = { prefill: NewPrefill; anchor: Point | null; key: number };

/** Formularinhalt als Vergleichswert („Eingaben verwerfen?“ nur, wenn sich etwas geändert hat) */
const snapshot = (f: HTMLFormElement | null | undefined) => (f ? new URLSearchParams([...new FormData(f)].map(([k, v]) => [k, String(v)])).toString() : "");

/**
 * „Neuer Termin“ als Fenster über dem Kalender (statt Seitenwechsel). Fängt Klicks auf Links nach /kalender/neu
 * ab (freie Zeit im Raster, „+ Termin“, Vorschläge aus „Freien Termin finden“). Ohne JavaScript (oder per
 * Deep-Link/neuem Tab) führen diese Links weiter auf die Seite /kalender/neu – dort lässt sich die Seite öffnen,
 * die Patient:innen-Auswahl selbst braucht aber JavaScript.
 *
 * - Desktop/iPad: nicht-modales, nicht abdunkelndes Fenster (aria-modal=false), der Kalender bleibt sichtbar und
 *   per Maus und Tastatur bedienbar (keine Tab-Falle). F6 oder der Knopf „Zum Fenster“ springt zwischen Fenster
 *   und Kalender. Verschiebbar an der Titelleiste (Maus und Touch), bleibt im sichtbaren Bereich (clampPosition).
 *   Ist es offen, übernimmt ein Klick auf eine andere freie Zeit Datum/Uhrzeit (und die Behandler:in-Spalte).
 * - Handy (< 640 px): modales Vollbild-Blatt (aria-modal=true, Hintergrund inert, Seite scrollt nicht mit).
 * - Escape (im Fenster) schließt – innere Elemente (Vorschläge, Schnellformular) fangen es vorher selbst ab; sind
 *   schon Eingaben gemacht, kommt vorher „Eingaben verwerfen?“. Danach Fokus zurück auf den auslösenden Link.
 * - Speichern schließt und meldet „Termin angelegt“ mit Link zum Termin; den Kalender aktualisiert die Server-Aktion
 *   (revalidatePath in createAppointmentInDialogAction) – kein zusätzliches router.refresh().
 */
export function NewAppointmentHost({ enabled, fallbackDate, children }: { enabled: boolean; fallbackDate: string; children: ReactNode }) {
  const router = useRouter();
  const narrow = useNarrow();
  const [open, setOpen] = useState<Open | null>(null);
  const [apply, setApply] = useState<{ date?: string; time?: string; therapistId?: string; n: number } | null>(null);
  const [data, setData] = useState<NewAppointmentData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pos, setPos] = useState<Point>({ x: 0, y: 0 });
  const box = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const drag = useRef<{ id: number; dx: number; dy: number } | null>(null);
  const titleId = useId();
  const hintId = useId();
  const calendar = useRef<HTMLDivElement>(null);
  /** Formularstand nach dem Laden – zum Vergleich vor dem Schließen */
  const initialForm = useRef<string | null>(null);
  /** zuletzt fokussiertes Element im Fenster (F6/„Zum Fenster“ springt dorthin zurück) */
  const lastInside = useRef<HTMLElement | null>(null);
  const keyboard = useRef(false);
  /** Desktop: Fokus per Tastatur im Kalender, Fenster offen → Knopf „Zum Fenster“ zeigen */
  const [focusOutside, setFocusOutside] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/kalender/neu/daten", { headers: { accept: "application/json" }, cache: "no-store" });
      if (!res.ok || !res.headers.get("content-type")?.includes("json")) throw new Error(String(res.status));
      setData((await res.json()) as NewAppointmentData);
    } catch {
      setLoadError("Daten konnten nicht geladen werden – bitte erneut versuchen.");
    }
  }, []);

  const close = useCallback(() => {
    setOpen(null);
    setApply(null);
    setFocusOutside(false);
    initialForm.current = null;
    lastInside.current = null;
    const el = opener.current;
    opener.current = null;
    if (el?.isConnected) requestAnimationFrame(() => el.focus({ preventScroll: true }));
  }, []);
  /** Schließen durch die Nutzer:in (Escape, ×, Abbrechen): bei geänderten Eingaben vorher nachfragen */
  const requestClose = useCallback(() => {
    const el = box.current;
    const form = el?.querySelector("form");
    const dirty = !!el?.querySelector("[data-dirty]") || (initialForm.current !== null && snapshot(form) !== initialForm.current);
    if (dirty && !confirm("Eingaben verwerfen?")) return;
    close();
  }, [close]);
  const focusDialog = useCallback(() => {
    const last = lastInside.current;
    const target = last?.isConnected && box.current?.contains(last) ? last : box.current?.querySelector<HTMLElement>("input[role=combobox], input:not([type=hidden]), button");
    target?.focus();
  }, []);

  const onClickCapture = (e: React.MouseEvent) => {
    if (!enabled || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || a.target === "_blank" || box.current?.contains(a)) return;
    const prefill = prefillFromHref(a.getAttribute("href") ?? "", location.origin);
    if (!prefill) return;
    e.preventDefault();
    e.stopPropagation();
    if (open) {
      // Fenster offen: andere freie Zeit übernehmen, Eingaben (Patient:in, Leistungen …) bleiben
      setApply({ date: prefill.date, time: prefill.time, therapistId: prefill.therapistId, n: Date.now() });
      return;
    }
    opener.current = a;
    const anchor = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : null;
    setPos(initialPosition({ width: innerWidth, height: innerHeight }, SIZE, anchor));
    setOpen({ prefill, anchor, key: Date.now() });
    void load();
  };

  // Größe nach dem Öffnen messen und im Bild halten (auch bei Fenstergröße/Drehung)
  useEffect(() => {
    if (!open || narrow) return;
    const fit = () => {
      const el = box.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos((p) => clampPosition(p, { width: r.width, height: r.height }, { width: innerWidth, height: innerHeight }));
    };
    fit();
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, [open, narrow, data]);

  // Fokus ins Fenster (erstes Feld)
  useEffect(() => {
    if (open) requestAnimationFrame(() => box.current?.querySelector<HTMLElement>("[data-autofocus], input:not([type=hidden]), button")?.focus());
  }, [open]);
  useEffect(() => {
    if (!open || !data) return;
    requestAnimationFrame(() => {
      box.current?.querySelector<HTMLElement>("input[role=combobox], input:not([type=hidden])")?.focus();
      initialForm.current = snapshot(box.current?.querySelector("form"));
    });
  }, [open, data]);

  // Desktop (nicht modal): Fokus verfolgen, F6 wechselt zwischen Fenster und Kalender
  useEffect(() => {
    if (!open || narrow) return;
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement;
      if (box.current?.contains(t)) {
        lastInside.current = t;
        setFocusOutside(false);
      } else if (!(t as Element).closest?.("[data-zum-fenster]")) {
        setFocusOutside(keyboard.current);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      keyboard.current = true;
      if (e.key !== "F6" || e.altKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      if (box.current?.contains(document.activeElement)) {
        const back = opener.current?.isConnected ? opener.current : calendar.current?.querySelector<HTMLElement>(FOCUSABLE);
        back?.focus();
      } else focusDialog();
    };
    const onPointer = (e: PointerEvent) => {
      keyboard.current = false;
      // Knopf „Zum Fenster“ selbst nicht vor dem Klick ausblenden
      if (!(e.target as Element | null)?.closest?.("[data-zum-fenster]")) setFocusOutside(false);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open, narrow, focusDialog]);

  // Handy (modal): alles außerhalb des Blatts inert, Seite dahinter scrollt nicht
  useEffect(() => {
    const el = box.current;
    if (!open || !narrow || !el) return;
    const touched: HTMLElement[] = [];
    for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) {
      for (const sib of Array.from(n.parentElement?.children ?? [])) {
        // Meldungen (Toaster, aria-live) bleiben hörbar
        if (sib === n || !(sib instanceof HTMLElement) || sib.inert || sib.tagName === "SCRIPT" || sib.hasAttribute("aria-live")) continue;
        sib.inert = true;
        touched.push(sib);
      }
    }
    const root = document.documentElement;
    const prev = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      for (const t of touched) t.inert = false;
      root.style.overflow = prev;
    };
  }, [open, narrow]);

  // Escape am Fenster selbst (nicht global): innere Elemente (Vorschläge, Schnellformular) haben es dann schon verbraucht
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    requestClose();
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (narrow || e.button !== 0 || (e.target as Element).closest("button")) return;
    drag.current = { id: e.pointerId, dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !box.current) return;
    const r = box.current.getBoundingClientRect();
    setPos(clampPosition({ x: e.clientX - d.dx, y: e.clientY - d.dy }, { width: r.width, height: r.height }, { width: innerWidth, height: innerHeight }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };

  const p = open?.prefill;
  const team = data?.team ?? [];
  return (
    <div onClickCapture={onClickCapture}>
      <div ref={calendar}>{children}</div>
      {open && !narrow && focusOutside ? (
        <button
          type="button"
          data-zum-fenster=""
          onClick={focusDialog}
          className="no-print fixed right-4 bottom-4 z-40 inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl border border-border-strong bg-surface px-4 font-semibold shadow-lg hover:bg-surface-2"
        >
          Zum Fenster „Neuer Termin“ <kbd className="rounded border border-border px-1 text-xs text-muted">F6</kbd>
        </button>
      ) : null}
      {open ? (
        <div
          ref={box}
          role="dialog"
          aria-modal={narrow ? true : false}
          aria-labelledby={titleId}
          aria-describedby={narrow ? undefined : hintId}
          data-termin-dialog=""
          onKeyDown={onKeyDown}
          className={
            narrow
              ? "no-print fixed inset-0 z-50 flex flex-col bg-surface pt-[env(safe-area-inset-top)] motion-safe:animate-rise"
              : "no-print fixed z-40 flex max-h-[calc(100dvh-1rem)] w-[min(36rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-[0_24px_60px_-12px_color-mix(in_srgb,var(--text)_45%,transparent)]"
          }
          style={narrow ? undefined : { left: pos.x, top: pos.y }}
        >
          <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className={`flex min-h-14 shrink-0 items-center gap-2 border-b border-border bg-surface-2 pr-1.5 pl-4 select-none ${narrow ? "" : "cursor-grab touch-none active:cursor-grabbing"}`}
          >
            {narrow ? null : <GripHorizontal size={18} aria-hidden className="shrink-0 text-muted" />}
            <h2 id={titleId} className="min-w-0 flex-1 truncate font-display text-lg font-semibold">
              Neuer Termin
            </h2>
            {narrow ? null : (
              <span id={hintId} className="hidden text-[13px] text-muted lg:inline">
                Freie Zeit im Kalender anklicken = übernehmen<span className="sr-only">. F6 wechselt zwischen Fenster und Kalender.</span>
              </span>
            )}
            <button type="button" onClick={requestClose} aria-label="Schließen" className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted hover:bg-surface hover:text-text">
              <X size={20} aria-hidden />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 sm:px-5">
            {loadError ? (
              <div className="flex flex-col items-start gap-3 pb-4">
                <p role="alert" className="text-sm font-medium text-danger">{loadError}</p>
                <button type="button" onClick={() => void load()} className="h-11 cursor-pointer rounded-xl border border-border px-4 font-semibold hover:bg-surface-2">
                  Erneut versuchen
                </button>
              </div>
            ) : !data ? (
              <p className="pb-4 text-sm text-muted" role="status">Wird geladen …</p>
            ) : (
              <AppointmentForm
                key={open.key}
                variant="dialog"
                apply={apply}
                cancelHref="/kalender"
                onCancel={requestClose}
                onCreated={(c) => {
                  close();
                  const when = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: "UTC" }).format(new Date(`${c.date}T12:00:00Z`));
                  toast(c.n > 1 ? `${c.n} Termine angelegt (ab ${when})` : `Termin angelegt (${when})`, {
                    action: { label: "Termin öffnen", onClick: () => router.push(`/kalender/termin/${c.id}`) },
                  });
                }}
                blocksTab={data.blocksTab}
                canCreatePatients={data.canCreatePatients}
                patients={data.patients}
                services={data.services}
                team={team}
                defaults={{
                  patientId: p?.patientId ?? "",
                  date: p?.date ?? fallbackDate,
                  time: p?.time ?? "09:00",
                  therapistId: p?.therapistId && team.some((t) => t.id === p.therapistId) ? p.therapistId : data.defaultTherapistId,
                  durationMin: p?.durationMin ?? 30,
                  serviceIds: p?.serviceId && data.services.some((s) => s.id === p.serviceId) ? [p.serviceId] : [],
                  todayIso: data.todayIso,
                }}
              />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
