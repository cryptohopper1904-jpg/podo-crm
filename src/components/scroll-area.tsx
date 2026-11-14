"use client";

import clsx from "clsx";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Seitlich scrollbarer Bereich (v. a. Tabellen, src/components/ui.tsx Table):
 *  - nur wenn der Inhalt wirklich breiter ist: per Tab erreichbar (tabIndex 0) und als benannte Region
 *    (axe „scrollable-region-focusable“), Pfeiltasten scrollen dann nativ;
 *  - Schatten am linken/rechten Rand zeigen, dass es dort weitergeht.
 * `max-w-full min-w-0`: der Bereich wird nie breiter als sein Platz – die Seite selbst scrollt nicht seitlich.
 */
export function ScrollArea({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ scrollable: false, left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      const next = { scrollable: max > 1, left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 };
      setEdges((prev) => (prev.scrollable === next.scrollable && prev.left === next.left && prev.right === next.right ? prev : next));
    };
    // ResizeObserver meldet sich direkt nach observe() einmal – kein synchroner Aufruf im Effekt nötig
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, []);
  const shade = "pointer-events-none absolute inset-y-0 w-6 transition-opacity duration-150 from-[color-mix(in_srgb,var(--text)_16%,transparent)] to-transparent";
  return (
    <div className={clsx("relative max-w-full min-w-0 overflow-hidden", className)}>
      <div
        ref={ref}
        className="podo-scroll relative overflow-x-auto"
        {...(edges.scrollable ? { tabIndex: 0, role: "region", "aria-label": label ? `${label} (seitlich scrollbar)` : "Tabelle (seitlich scrollbar)" } : {})}
      >
        {children}
      </div>
      <span aria-hidden className={clsx(shade, "left-0 bg-gradient-to-r", edges.left ? "opacity-100" : "opacity-0")} />
      <span aria-hidden className={clsx(shade, "right-0 bg-gradient-to-l", edges.right ? "opacity-100" : "opacity-0")} />
    </div>
  );
}
