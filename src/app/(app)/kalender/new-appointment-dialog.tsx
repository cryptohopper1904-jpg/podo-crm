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

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

type Open = { prefill: NewPrefill; anchor: Point | null; key: number };

/**
 * „Neuer Termin“ als Fenster über dem Kalender (statt Seitenwechsel). Fängt Klicks auf Links nach /kalender/neu
 * ab (freie Zeit im Raster, „+ Termin“, Vorschläge aus „Freien Termin finden“) – ohne JavaScript bleiben das
 * normale Links auf die Seite /kalender/neu.
 *
 * - Desktop/iPad: nicht abdunkelndes Fenster, der Kalender bleibt sichtbar und bedienbar. Verschiebbar an der
 *   Titelleiste (Maus und Touch), bleibt im sichtbaren Bereich (clampPosition). Ist es offen, übernimmt ein Klick
 *   auf eine andere freie Zeit Datum/Uhrzeit (und die Behandler:in-Spalte) ins Formular.
 * - Handy (< 640 px): Vollbild-Blatt von unten, nicht verschiebbar.
 * - Escape schließt, Tab bleibt im Fenster (Fokusfalle), danach Fokus zurück auf den auslösenden Link.
 * - Speichern schließt, aktualisiert den Kalender und meldet „Termin angelegt“ mit Link zum Termin.
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
    const el = opener.current;
    opener.current = null;
    if (el?.isConnected) requestAnimationFrame(() => el.focus({ preventScroll: true }));
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

  // Fokus ins Fenster (erstes Feld), Escape schließt
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>("[data-autofocus], input:not([type=hidden]), button")?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);
  useEffect(() => {
    if (open && data) requestAnimationFrame(() => box.current?.querySelector<HTMLElement>("input[role=combobox], input:not([type=hidden])")?.focus());
  }, [open, data]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
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
      {children}
      {open ? (
        <div
          ref={box}
          role="dialog"
          aria-modal={narrow ? true : false}
          aria-labelledby={titleId}
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
            {narrow ? null : <span className="hidden text-[13px] text-muted lg:inline">Freie Zeit im Kalender anklicken = übernehmen</span>}
            <button type="button" onClick={close} aria-label="Schließen" className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted hover:bg-surface hover:text-text">
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
                onCancel={close}
                onCreated={(c) => {
                  close();
                  router.refresh();
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
