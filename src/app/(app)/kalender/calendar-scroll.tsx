"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * Wochenplan auf dem Handy (3-Tage-Fenster, seitlich einrastend): beim Öffnen die Spalte des gewählten Tages bzw. von
 * heute an den Anfang holen statt immer Montag. Nur wenn der Plan überhaupt seitlich scrollt (sonst nichts tun).
 * Muss direkt im scrollenden Bereich stehen (Kind der DndSurface).
 */
export function ScrollToColumn({ date }: { date: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const box = ref.current?.parentElement;
    if (!box || box.scrollWidth <= box.clientWidth + 1) return;
    const col = box.querySelector<HTMLElement>(`[data-dnd-col][data-date="${date}"]`);
    const axis = box.querySelector<HTMLElement>("[data-dnd-col]")?.offsetLeft ?? 0;
    if (col) box.scrollLeft = col.offsetLeft - axis;
  }, [date]);
  return <span ref={ref} hidden />;
}
