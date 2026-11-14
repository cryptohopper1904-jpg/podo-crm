"use client";

import { useEffect } from "react";
import { RotateCw } from "lucide-react";
import { mayQuickReload, parseReloadHistory, PROBE_MS, quickProbeDelay } from "@/lib/pwa/offline-resume";

const HISTORY_KEY = "podo-offline-quick-reloads";

/** Weiter zur gewünschten Seite; wurde /offline direkt aufgerufen, führte ein Neuladen nur hierher zurück → /heute */
function resume() {
  if (location.pathname === "/offline") location.replace("/heute");
  else location.reload();
}

/** Antwortet der Server? (/api/health greift der Service Worker nicht ab – geht direkt ins Netz) */
function serverReachable(): Promise<boolean> {
  return fetch("/api/health", { cache: "no-store", credentials: "omit" })
    .then((r) => r.ok)
    .catch(() => false);
}

/**
 * Lädt die aufgerufene Seite neu – auf Knopfdruck sofort, sonst erst, wenn der Server wirklich antwortet
 * (Regeln und Begründung: src/lib/pwa/offline-resume.ts):
 *  - nach „online“ und beim Erscheinen der Ersatzseite trotz Verbindung: schnelle Prüfungen (sofort, 0,5 s, 1 s, …),
 *    begrenzt auf wenige schnelle Neuladungen je Minute,
 *  - zusätzlich alle 25 s, solange die Seite sichtbar ist (WLAN ohne Internet, Server-Neustart).
 * data-offline-ready am <html>: Seite ist hydriert (für Tests).
 */
export function RetryButton() {
  useEffect(() => {
    let stopped = false;
    let quickTimer: ReturnType<typeof setTimeout> | undefined;

    const quickReload = () => {
      let history: number[] = [];
      try {
        history = parseReloadHistory(sessionStorage.getItem(HISTORY_KEY), Date.now());
        if (!mayQuickReload(history, Date.now())) return false;
        sessionStorage.setItem(HISTORY_KEY, JSON.stringify([...history, Date.now()]));
      } catch {
        // ohne Sitzungsspeicher: trotzdem neu laden (die Begrenzung entfällt dann)
      }
      resume();
      return true;
    };

    // schnelle Prüfkette; eine neue Kette (z. B. nächstes „online“) ersetzt die laufende
    const startQuickProbes = () => {
      clearTimeout(quickTimer);
      const step = (attempt: number) => {
        const delay = quickProbeDelay(attempt);
        if (delay == null) return;
        quickTimer = setTimeout(() => {
          serverReachable().then((ok) => {
            if (stopped) return;
            if (ok) quickReload();
            else step(attempt + 1);
          });
        }, delay);
      };
      step(0);
    };

    addEventListener("online", startQuickProbes);
    // Ersatzseite erscheint, obwohl der Browser „online“ meldet (Verbindung kam gerade erst, Neuladen war zu früh)
    if (navigator.onLine) startQuickProbes();
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      serverReachable().then((ok) => {
        if (ok && !stopped) resume();
      });
    }, PROBE_MS);
    document.documentElement.dataset.offlineReady = "1";
    return () => {
      stopped = true;
      removeEventListener("online", startQuickProbes);
      clearTimeout(quickTimer);
      clearInterval(timer);
    };
  }, []);
  return (
    <button
      type="button"
      onClick={resume}
      className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[15px] font-semibold text-on-primary hover:bg-primary-hover"
    >
      <RotateCw size={18} aria-hidden /> Erneut versuchen
    </button>
  );
}
