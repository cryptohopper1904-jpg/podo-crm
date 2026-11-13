"use client";

/**
 * Zustand der Installation im Browser: gemerktes `beforeinstallprompt`-Ereignis (Android/Chrome/Edge) und ob die App
 * bereits als installierte App (Standalone) läuft. Das Ereignis kann vor dem Hydrieren kommen – das Skript im
 * Root-Layout (src/app/layout.tsx) legt es dann in window.__podoBip ab.
 */
import { useSyncExternalStore } from "react";

export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

declare global {
  interface Window {
    __podoBip?: BeforeInstallPromptEvent | null;
  }
  interface Navigator {
    /** iOS Safari: true, wenn vom Home-Bildschirm gestartet */
    standalone?: boolean;
  }
}

const listeners = new Set<() => void>();
let installedNow = false;
let wired = false;

function emit() {
  listeners.forEach((l) => l());
}

function wire() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    window.__podoBip = e as BeforeInstallPromptEvent;
    emit();
  });
  addEventListener("appinstalled", () => {
    window.__podoBip = null;
    installedNow = true;
    emit();
  });
}

function subscribe(cb: () => void) {
  wire();
  listeners.add(cb);
  const mq = matchMedia("(display-mode: standalone)");
  mq.addEventListener("change", cb);
  return () => {
    listeners.delete(cb);
    mq.removeEventListener("change", cb);
  };
}

/** Läuft die Seite als installierte App (Home-Bildschirm/App-Fenster)? */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    navigator.standalone === true ||
    matchMedia("(display-mode: standalone)").matches ||
    matchMedia("(display-mode: minimal-ui)").matches ||
    matchMedia("(display-mode: fullscreen)").matches
  );
}

export function useInstallPrompt(): BeforeInstallPromptEvent | null {
  return useSyncExternalStore(subscribe, () => window.__podoBip ?? null, () => null);
}

/** null während des Server-Renderings (dann nichts anzeigen) */
export function useStandalone(): boolean | null {
  return useSyncExternalStore(subscribe, () => isStandalone() || installedNow, () => null);
}

/** Systemdialog „App installieren“ öffnen (nur wenn ein Ereignis vorliegt) */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const e = window.__podoBip;
  if (!e) return "unavailable";
  await e.prompt();
  const { outcome } = await e.userChoice;
  // ein Ereignis kann nur einmal verwendet werden
  window.__podoBip = null;
  emit();
  return outcome;
}
