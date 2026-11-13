"use client";

/**
 * Service Worker der installierbaren Web-App: Registrierung (nur Produktion) und Update-Hinweis.
 * Eine neue Version übernimmt erst nach Bestätigung („Neu laden“) – so geht keine halb ausgefüllte Dokumentation
 * durch ein automatisches Neuladen verloren. Regeln des Workers: src/lib/pwa/sw-rules.ts.
 */
import { useEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";

const SW_URL = "/sw.js";

export function PwaClient() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const reloading = useRef(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    let reg: ServiceWorkerRegistration | undefined;
    let cancelled = false;

    const offer = (w: ServiceWorker | null) => {
      // nur, wenn bereits eine Version aktiv ist (erste Installation braucht keinen Hinweis)
      if (w && navigator.serviceWorker.controller && !cancelled) setWaiting(w);
    };
    const onControllerChange = () => {
      // nur nach Bestätigung neu laden (nicht beim allerersten Aktivieren)
      if (reloading.current) location.reload();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reg?.update().catch(() => {});
    };

    navigator.serviceWorker
      .register(SW_URL, { scope: "/", updateViaCache: "none" })
      .then((r) => {
        reg = r;
        offer(r.waiting);
        r.addEventListener("updatefound", () => {
          const next = r.installing;
          next?.addEventListener("statechange", () => {
            if (next.state === "installed") offer(next);
          });
        });
      })
      .catch(() => {
        // z. B. privater Modus oder blockiert – die App funktioniert ohne Service Worker genauso (nur ohne Offline-Hinweis)
      });
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    // installierte Apps bleiben oft tagelang offen: beim Zurückkehren nach Updates sehen
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!waiting || dismissed) return null;
  return (
    <div
      role="status"
      className="no-print fixed inset-x-0 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-40 flex justify-center px-[max(1rem,env(safe-area-inset-left))] lg:bottom-[max(1.5rem,env(safe-area-inset-bottom))]"
    >
      <div className="flex w-full max-w-md items-center gap-3 rounded-[var(--radius-card)] border border-border bg-surface p-3 pl-4 shadow-lg">
        <RefreshCw size={20} aria-hidden className="shrink-0 text-primary" />
        <p className="min-w-0 flex-1 text-[15px] font-medium">Neue Version verfügbar</p>
        <button
          type="button"
          onClick={() => {
            reloading.current = true;
            waiting.postMessage({ type: "SKIP_WAITING" });
            // Fallback, falls controllerchange ausbleibt (z. B. Worker bereits aktiv)
            setTimeout(() => location.reload(), 3000);
          }}
          className="inline-flex h-11 shrink-0 cursor-pointer items-center rounded-xl bg-primary px-4 text-[15px] font-semibold text-on-primary hover:bg-primary-hover"
        >
          Neu laden
        </button>
        <button
          type="button"
          aria-label="Später"
          title="Später"
          onClick={() => setDismissed(true)}
          className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted hover:bg-surface-2"
        >
          <X size={18} aria-hidden />
        </button>
      </div>
    </div>
  );
}

