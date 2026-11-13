"use client";

import { useEffect } from "react";
import { RotateCw } from "lucide-react";

/** Abstand der automatischen Prüfung, solange die Seite sichtbar ist */
const PROBE_MS = 25_000;

/**
 * Lädt die aufgerufene Seite neu – auf Knopfdruck, sobald der Browser „online“ meldet, und zusätzlich alle 25 s,
 * wenn der Server wieder antwortet (WLAN ohne Internet oder Server-Neustart lösen kein „online“-Ereignis aus).
 * data-offline-ready am <html>: Seite ist hydriert (für Tests).
 */
export function RetryButton() {
  useEffect(() => {
    const onOnline = () => location.reload();
    addEventListener("online", onOnline);
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      fetch("/api/health", { cache: "no-store", credentials: "omit" })
        .then((r) => {
          if (r.ok) location.reload();
        })
        .catch(() => {
          // weiterhin offline
        });
    }, PROBE_MS);
    document.documentElement.dataset.offlineReady = "1";
    return () => {
      removeEventListener("online", onOnline);
      clearInterval(timer);
    };
  }, []);
  return (
    <button
      type="button"
      onClick={() => location.reload()}
      className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[15px] font-semibold text-on-primary hover:bg-primary-hover"
    >
      <RotateCw size={18} aria-hidden /> Erneut versuchen
    </button>
  );
}
