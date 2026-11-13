"use client";

import { useCallback, useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import { Undo2, X } from "lucide-react";
import { Button } from "@/components/ui";
import { berlinParts } from "@/lib/calendar-grid";
import { autoScrollDelta, columnIndexAt, dropStartMin, durationOf, localSlotToUtc, moveLabel, moveLabelLong, moveToDay, resizeDuration } from "@/lib/calendar-dnd";
import { moveAppointmentAction, type MoveResult } from "./actions";

/**
 * Termine im Kalender per Ziehen verschieben (Tag/Woche: Zeit und – in der Tagesansicht – Behandler:in-Spalte,
 * Monat: anderer Tag; unterer Rand: Dauer). Pointer Events statt HTML5-Drag-and-drop (geht auf iPad/iPhone nicht):
 * Maus ab 5 px Bewegung, Touch/Stift nach langem Drücken (300 ms) – kurzes Wischen scrollt weiter normal.
 *
 * Die Kalenderinhalte bleiben Server-Komponenten; diese Hülle liest nur data-Attribute:
 *   Termin:  data-appt, data-start, data-end, data-therapist, data-name, data-movable="1"
 *   Spalte:  data-dnd-col, data-date, data-therapist, data-range-start, data-range-end, data-drop="0" (kein Ziel)
 *   Monat:   data-dnd-day="JJJJ-MM-TT"
 * Gespeichert wird über dieselbe Logik wie im Formular (moveAppointmentAction → rescheduleAppointment).
 * Tastatur-Alternative bleibt das Formular „Termin öffnen → Datum und Uhrzeit ändern“.
 */

type View = "tag" | "woche" | "monat";
type Slot = { startsAt: Date; durationMin: number; therapistId: string };
type Plan = { id: string; name: string; from: Slot; to: Slot };
type Rect = { top: number; left: number; width: number; height: number };
type Ghost = { rect: Rect; label: string; valid: boolean; cell?: boolean };

type Session = {
  pointerId: number;
  touch: boolean;
  el: HTMLElement;
  mode: "move" | "resize";
  x0: number;
  y0: number;
  x: number;
  y: number;
  active: boolean;
  cancelled: boolean;
  timer: number | null;
  raf: number | null;
  id: string;
  name: string;
  startsAt: Date;
  endsAt: Date;
  therapistId: string;
  grabMin: number;
  srcCol: HTMLElement | null;
  target: Slot | null;
};

const LONG_PRESS_MS = 300;
const TOAST_MS = 10_000;

const sameSlot = (a: Slot, b: Slot) => a.startsAt.getTime() === b.startsAt.getTime() && a.durationMin === b.durationMin && a.therapistId === b.therapistId;
const endOf = (s: Slot) => new Date(s.startsAt.getTime() + s.durationMin * 60_000);
const css = (id: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/[^a-z0-9-]/gi, ""));

export function DndSurface({
  view,
  enabled,
  pxPerMin,
  className,
  ariaLabel,
  children,
}: {
  view: View;
  enabled: boolean;
  pxPerMin: number;
  className: string;
  ariaLabel: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const session = useRef<Session | null>(null);
  const busy = useRef(false);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; ghost: Ghost | null } | null>(null);
  const [confirm, setConfirm] = useState<{ plan: Plan; undo: boolean; message: string; ghost: Ghost | null } | null>(null);
  const [toast, setToast] = useState<{ key: number; text: string; undo?: Plan; error?: boolean } | null>(null);
  const [announce, setAnnounce] = useState("");
  const [, startTransition] = useTransition();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  // ───── Speichern (optimistisch: Original ausblenden, Geisterbild am Ziel; bei Fehler zurück) ─────
  // nur stabile Setter/Refs → einmalig erzeugt
  const run = useCallback((plan: Plan, undo: boolean, allowConflict: boolean, g: Ghost | null) => {
    busy.current = true;
    setPending({ id: plan.id, ghost: g });
    setToast(undo ? { key: Date.now(), text: "Wird zurückgesetzt …" } : null);
    const to = plan.to;
    startTransition(async () => {
      let res: MoveResult;
      try {
        res = await moveAppointmentAction({ id: plan.id, startsAt: to.startsAt.toISOString(), durationMin: to.durationMin, therapistId: to.therapistId, allowConflict });
      } catch {
        res = { ok: false, error: "Keine Verbindung – der Termin wurde nicht verschoben." };
      }
      startTransition(() => {
        busy.current = false;
        const when = moveLabelLong(to.startsAt, endOf(to));
        if (res.ok) {
          setPending(null);
          setConfirm(null);
          const text = undo ? `Zurückgesetzt: ${plan.name}, ${when}` : `${plan.name} verschoben auf ${when}`;
          setToast({ key: Date.now(), text, undo: undo ? undefined : { id: plan.id, name: plan.name, from: plan.to, to: plan.from } });
          setAnnounce(text);
        } else if (res.conflict) {
          setConfirm({ plan, undo, message: res.error, ghost: g });
          setToast(null);
          setAnnounce(`Hinweis: ${res.error}`);
        } else {
          setPending(null);
          setConfirm(null);
          const text = `${undo ? "Nicht zurückgesetzt" : "Nicht verschoben"}: ${res.error}`;
          setToast({ key: Date.now(), text, error: true });
          setAnnounce(text);
        }
      });
    });
  }, []);

  // Rückfrage-Dialog (Überschneidung/Abwesenheit) als echtes modales <dialog>
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (confirm && !d.open) d.showModal();
    if (!confirm && d.open) d.close();
  }, [confirm]);

  // Hinweis nach 10 s ausblenden (Fehler bleiben ebenso lange stehen)
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast((cur) => (cur?.key === toast.key ? null : cur)), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [toast]);

  // ───── Zeiger ─────
  useEffect(() => {
    const box = ref.current;
    if (!enabled || !box) return;

    const containerRect = () => box.getBoundingClientRect();
    const toContent = (r: DOMRect): Rect => {
      const c = containerRect();
      return { top: r.top - c.top + box.scrollTop, left: r.left - c.left + box.scrollLeft, width: r.width, height: r.height };
    };

    /** Ziel und Geisterbild aus der aktuellen Zeigerposition */
    const compute = (s: Session): { slot: Slot | null; ghost: Ghost | null } => {
      const durationMin = durationOf(s.startsAt, s.endsAt);
      if (view === "monat") {
        const cells = [...box.querySelectorAll<HTMLElement>("[data-dnd-day]")];
        const cell = cells.find((c) => {
          const r = c.getBoundingClientRect();
          return s.x >= r.left && s.x < r.right && s.y >= r.top && s.y < r.bottom;
        });
        if (!cell) return { slot: null, ghost: null };
        const startsAt = moveToDay(s.startsAt, cell.dataset.dndDay!);
        const rect = toContent(cell.getBoundingClientRect());
        if (!startsAt) return { slot: null, ghost: { rect, label: "Uhrzeit gibt es an diesem Tag nicht (Zeitumstellung)", valid: false, cell: true } };
        const slot = { startsAt, durationMin, therapistId: s.therapistId };
        return { slot, ghost: { rect, label: moveLabel(startsAt, endOf(slot)), valid: true, cell: true } };
      }
      const cols = [...box.querySelectorAll<HTMLElement>("[data-dnd-col]")];
      const rects = cols.map((c) => c.getBoundingClientRect());
      const idx = s.mode === "resize" ? cols.indexOf(s.srcCol!) : columnIndexAt(rects, s.x);
      if (idx < 0) return { slot: null, ghost: null };
      const col = cols[idx];
      const r = rects[idx];
      const date = col.dataset.date!;
      const rangeStart = Number(col.dataset.rangeStart);
      const rangeEnd = Number(col.dataset.rangeEnd);
      const offsetPx = s.y - r.top;
      let startMin: number, dur: number;
      if (s.mode === "resize") {
        const p = berlinParts(s.startsAt);
        if (p.dateIso !== date) return { slot: null, ghost: null };
        startMin = p.min;
        dur = resizeDuration({ offsetPx, pxPerMin, rangeStart, startMin });
      } else {
        dur = durationMin;
        startMin = dropStartMin({ offsetPx, grabMin: s.grabMin, pxPerMin, rangeStart, rangeEnd, durationMin: dur });
      }
      const c = toContent(r);
      const rect = { top: c.top + (startMin - rangeStart) * pxPerMin, left: c.left + 2, width: Math.max(0, c.width - 4), height: Math.max(14, dur * pxPerMin - 1) };
      if (col.dataset.drop === "0") return { slot: null, ghost: { rect, label: "Hier nicht möglich – bitte eine Behandler:in-Spalte wählen", valid: false } };
      const startsAt = s.mode === "resize" ? s.startsAt : localSlotToUtc(date, startMin);
      if (!startsAt) return { slot: null, ghost: { rect, label: "Uhrzeit gibt es an diesem Tag nicht (Zeitumstellung)", valid: false } };
      const therapistId = view === "tag" && col.dataset.therapist ? col.dataset.therapist : s.therapistId;
      const slot = { startsAt, durationMin: dur, therapistId };
      return { slot, ghost: { rect, label: moveLabel(startsAt, endOf(slot)), valid: true } };
    };

    const update = () => {
      const s = session.current;
      if (!s?.active) return;
      const { slot, ghost: g } = compute(s);
      s.target = slot;
      setGhost(g);
    };

    const loop = () => {
      const s = session.current;
      if (!s?.active) return;
      let moved = false;
      const c = containerRect();
      // Kopfzeile (Spaltenköpfe) bleibt oben stehen – Rand darunter
      const dy = view === "monat" ? 0 : autoScrollDelta(s.y, c.top + 40, c.bottom);
      const dx = autoScrollDelta(s.x, c.left + (view === "monat" ? 0 : 52), c.right);
      if (dy || dx) {
        const [t, l] = [box.scrollTop, box.scrollLeft];
        box.scrollBy(dx, dy);
        moved = box.scrollTop !== t || box.scrollLeft !== l;
      }
      // Monat: die Seite selbst scrollt
      const wy = view === "monat" ? autoScrollDelta(s.y, 0, window.innerHeight) : 0;
      if (wy) {
        const y0 = window.scrollY;
        window.scrollBy(0, wy);
        moved = moved || window.scrollY !== y0;
      }
      if (moved) update();
      s.raf = requestAnimationFrame(loop);
    };

    const suppressClick = () => {
      const h = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
      };
      window.addEventListener("click", h, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", h, { capture: true }), 400);
    };

    const end = () => {
      const s = session.current;
      if (!s) return;
      if (s.timer) window.clearTimeout(s.timer);
      if (s.raf) cancelAnimationFrame(s.raf);
      session.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("touchmove", onTouchMove);
      s.el.removeEventListener("contextmenu", onContext);
      document.documentElement.classList.remove("podo-dragging");
      setGhost(null);
      setDragging(null);
    };

    const activate = (s: Session) => {
      s.active = true;
      try {
        s.el.setPointerCapture(s.pointerId);
      } catch {
        /* Zeiger bereits weg */
      }
      document.documentElement.classList.add("podo-dragging");
      if (s.touch) navigator.vibrate?.(12);
      setDragging(s.id);
      setAnnounce(`${s.name} wird verschoben. Loslassen zum Ablegen, Escape bricht ab.`);
      update();
      s.raf = requestAnimationFrame(loop);
    };

    const onMove = (e: PointerEvent) => {
      const s = session.current;
      if (!s || e.pointerId !== s.pointerId) return;
      s.x = e.clientX;
      s.y = e.clientY;
      if (s.cancelled) return;
      if (!s.active) {
        const dist = Math.hypot(s.x - s.x0, s.y - s.y0);
        if (s.touch) {
          if (dist > 8) end(); // Wischen = scrollen
        } else if (dist > 5) activate(s);
        return;
      }
      e.preventDefault();
      update();
    };

    const onUp = (e: PointerEvent) => {
      const s = session.current;
      if (!s || e.pointerId !== s.pointerId) return;
      if (s.cancelled) {
        suppressClick();
        end();
        return;
      }
      if (!s.active) {
        end(); // normaler Klick → Termin öffnen
        return;
      }
      s.x = e.clientX;
      s.y = e.clientY;
      update();
      suppressClick();
      const from: Slot = { startsAt: s.startsAt, durationMin: durationOf(s.startsAt, s.endsAt), therapistId: s.therapistId };
      const to = s.target;
      const g = compute(s).ghost;
      const plan = to ? { id: s.id, name: s.name, from, to } : null;
      end();
      if (!plan || sameSlot(plan.from, plan.to)) {
        setAnnounce(plan ? "Termin nicht verschoben (gleiche Zeit)." : "Termin nicht verschoben (kein gültiges Ziel).");
        return;
      }
      run(plan, false, false, g);
    };

    const cancel = (msg: string) => {
      const s = session.current;
      if (!s) return;
      if (!s.active) {
        end();
        return;
      }
      // bis zum Loslassen weiter zuhören, damit der Klick danach den Termin nicht öffnet
      s.active = false;
      s.cancelled = true;
      if (s.raf) cancelAnimationFrame(s.raf);
      document.documentElement.classList.remove("podo-dragging");
      setGhost(null);
      setDragging(null);
      setAnnounce(msg);
    };
    const onCancel = (e: PointerEvent) => {
      if (session.current && e.pointerId === session.current.pointerId) {
        cancel("Verschieben abgebrochen.");
        end();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && session.current) {
        e.preventDefault();
        e.stopPropagation();
        cancel("Verschieben abgebrochen – der Termin bleibt, wo er war.");
      }
    };
    // iPad/iPhone: nach dem langen Drücken das Scrollen der Seite unterbinden (sonst bricht der Browser den Zeiger ab)
    const onTouchMove = (e: TouchEvent) => {
      if (session.current?.active || session.current?.cancelled) e.preventDefault();
    };
    const onContext = (e: Event) => e.preventDefault();

    const onDown = (e: PointerEvent) => {
      if (session.current || busy.current || e.button !== 0 || !e.isPrimary) return;
      const el = (e.target as Element | null)?.closest<HTMLElement>("[data-appt]");
      if (!el || !box.contains(el) || el.dataset.movable !== "1") return;
      const startsAt = new Date(el.dataset.start!);
      const endsAt = new Date(el.dataset.end!);
      if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || !el.dataset.therapist) return;
      const resize = !!(e.target as Element).closest("[data-resize]");
      const touch = e.pointerType !== "mouse";
      if (!touch) e.preventDefault(); // keine Textauswahl, kein natives Ziehen des Links
      const r = el.getBoundingClientRect();
      const s: Session = {
        pointerId: e.pointerId,
        touch,
        el,
        mode: resize && view !== "monat" ? "resize" : "move",
        x0: e.clientX,
        y0: e.clientY,
        x: e.clientX,
        y: e.clientY,
        active: false,
        cancelled: false,
        timer: null,
        raf: null,
        id: el.dataset.appt!,
        name: el.dataset.name || "Termin",
        startsAt,
        endsAt,
        therapistId: el.dataset.therapist,
        grabMin: view === "monat" ? 0 : Math.max(0, (e.clientY - r.top) / pxPerMin),
        srcCol: el.closest<HTMLElement>("[data-dnd-col]"),
        target: null,
      };
      session.current = s;
      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("touchmove", onTouchMove, { passive: false });
      el.addEventListener("contextmenu", onContext);
      if (touch) s.timer = window.setTimeout(() => session.current === s && !s.active && activate(s), LONG_PRESS_MS);
    };

    box.addEventListener("pointerdown", onDown);
    return () => {
      box.removeEventListener("pointerdown", onDown);
      end();
    };
  }, [enabled, view, pxPerMin, run]);

  const hidden = pending?.id ?? null;
  const shownGhost = ghost ?? pending?.ghost ?? confirm?.ghost ?? null;
  const ghostState = ghost ? "drag" : "pending";

  return (
    <>
      <div ref={ref} className={`relative ${className}`} role="region" aria-label={ariaLabel} aria-busy={pending ? true : undefined}>
        {dragging || hidden ? (
          <style>{`${dragging ? `[data-appt="${css(dragging)}"]{opacity:.35}` : ""}${hidden ? `[data-appt="${css(hidden)}"]{visibility:hidden}` : ""}`}</style>
        ) : null}
        {children}
        {shownGhost ? (
          <div
            data-dnd-ghost={ghostState}
            className={`pointer-events-none absolute z-[15] flex flex-col overflow-hidden rounded-md border-2 px-1.5 py-0.5 text-xs font-semibold leading-tight shadow-lg ${
              shownGhost.valid
                ? shownGhost.cell
                  ? "border-primary bg-primary-soft/60 text-primary-soft-text"
                  : ghostState === "drag"
                    ? "border-primary bg-primary-soft text-primary-soft-text"
                    : "border-dashed border-primary bg-primary-soft text-primary-soft-text"
                : "border-dashed border-accent bg-accent-soft/80 text-accent-soft-text"
            }`}
            style={{ top: shownGhost.rect.top, left: shownGhost.rect.left, width: shownGhost.rect.width, height: shownGhost.rect.height }}
            aria-hidden
          >
            <span className={`tabular-nums ${shownGhost.cell ? "mt-8 rounded bg-surface px-1 text-[11px] shadow-sm" : ""}`}>{shownGhost.label}</span>
            {ghostState === "pending" && !ghost ? <span className="font-normal opacity-80">{confirm ? "wartet auf Bestätigung" : "wird verschoben …"}</span> : null}
          </div>
        ) : null}
      </div>

      <p className="sr-only" role="status" aria-live="polite">{announce}</p>

      {toast ? (
        <div
          className={`fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 mx-auto flex w-[min(34rem,calc(100vw-2rem))] items-center gap-3 rounded-xl border px-4 py-3 text-sm shadow-xl ${
            toast.error ? "border-accent bg-accent-soft text-accent-soft-text" : "border-border bg-surface text-text"
          }`}
          data-dnd-toast
        >
          <span className="min-w-0 flex-1">{toast.text}</span>
          {toast.undo ? (
            <Button type="button" variant="secondary" className="shrink-0" onClick={() => toast.undo && !busy.current && run(toast.undo, true, false, null)}>
              <Undo2 size={16} aria-hidden /> Rückgängig
            </Button>
          ) : null}
          <button type="button" onClick={() => setToast(null)} aria-label="Hinweis schließen" className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg hover:bg-surface-2">
            <X size={16} aria-hidden />
          </button>
        </div>
      ) : null}

      <dialog
        ref={dialogRef}
        aria-modal="true"
        aria-labelledby={titleId}
        onCancel={(e) => {
          e.preventDefault();
          abort();
        }}
        className="fixed inset-0 m-auto hidden w-[min(30rem,calc(100vw-2rem))] flex-col gap-4 rounded-[var(--radius-card)] border border-border bg-surface p-5 text-text shadow-2xl backdrop:bg-black/55 open:flex"
      >
        {confirm ? (
          <>
            <h2 id={titleId} className="font-display text-lg font-semibold">
              {confirm.undo ? "Trotzdem zurücksetzen?" : "Trotzdem verschieben?"}
            </h2>
            <p className="text-sm">
              <strong>{confirm.plan.name}</strong> → {moveLabelLong(confirm.plan.to.startsAt, endOf(confirm.plan.to))}
            </p>
            <p className="rounded-xl bg-warn-soft p-3 text-sm text-warn-soft-text">{confirm.message}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" onClick={abort} autoFocus>Abbrechen</Button>
              <Button type="button" onClick={() => run(confirm.plan, confirm.undo, true, confirm.ghost)}>
                {confirm.undo ? "Trotzdem zurücksetzen" : "Trotzdem verschieben"}
              </Button>
            </div>
          </>
        ) : null}
      </dialog>
    </>
  );

  function abort() {
    if (!confirm) return;
    const text = `${confirm.undo ? "Nicht zurückgesetzt" : "Nicht verschoben"} – ${confirm.plan.name} bleibt ${moveLabelLong(confirm.plan.from.startsAt, endOf(confirm.plan.from))}.`;
    setConfirm(null);
    setPending(null);
    setAnnounce(text);
  }
}
