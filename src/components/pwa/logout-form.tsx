"use client";

/**
 * Abmelde-Formular: schickt die Server Action wie bisher und bittet vorher den Service Worker, die Caches der App zu
 * leeren (Nachricht CLEAR_CACHES, src/lib/pwa/service-worker.ts). Die Caches enthalten ohnehin nur Programmdateien
 * und die Offline-Hinweisseite – Vorsorge für gemeinsam genutzte Geräte. Ohne Service Worker passiert nichts weiter.
 */
import type { ComponentProps } from "react";

export function LogoutForm({ onSubmit, ...props }: ComponentProps<"form">) {
  return (
    <form
      {...props}
      onSubmit={(e) => {
        try {
          navigator.serviceWorker?.controller?.postMessage({ type: "CLEAR_CACHES" });
        } catch {
          // ohne Service Worker nichts zu tun
        }
        onSubmit?.(e);
      }}
    />
  );
}
