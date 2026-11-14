"use client";

import { useCallback, useSyncExternalStore } from "react";
import { Empty } from "@/components/ui";

/**
 * Merker je Tab (sessionStorage): dieses Angebot wurde eben HIER angenommen. Schlüssel aus einem SHA-256-Kürzel des
 * Tokens (kein Klartext-Teil des Tokens im Speicher). Ohne crypto.subtle (z. B. kein sicherer Kontext) gibt es keinen
 * Merker – dann bleibt es bei „Termin bereits angenommen“.
 */
const keyCache = new Map<string, string>();

async function acceptedKey(token: string): Promise<string | null> {
  const hit = keyCache.get(token);
  if (hit) return hit;
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(token));
    const hex = Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
    const key = `podo-angebot-angenommen:${hex}`;
    keyCache.set(token, key);
    return key;
  } catch {
    return null;
  }
}

/** Schlüssel vorab berechnen (Formular beim Anzeigen), damit er beim Absenden und nach dem Neuladen sofort da ist */
export function prepareAcceptedKey(token: string): void {
  void acceptedKey(token);
}

function store(key: string): void {
  try {
    window.sessionStorage.setItem(key, "1");
  } catch {
    // ohne sessionStorage bleibt es bei „bereits angenommen“
  }
}

/** Merker setzen: dieses Angebot wurde in diesem Tab angenommen */
export function markAccepted(token: string): void {
  const key = keyCache.get(token);
  if (key) store(key);
  else void acceptedKey(token).then((k) => k && store(k));
}

function readAccepted(token: string): boolean {
  const key = keyCache.get(token);
  if (!key) return false;
  try {
    return window.sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/**
 * Angenommenes Angebot: „Termin angenommen“, wenn es in diesem Tab gerade angenommen wurde (nach dem Annehmen lädt die
 * Seite neu und zeigt diesen Zustand), sonst „Termin bereits angenommen“ (z. B. Link später erneut geöffnet).
 */
export function AcceptedNotice({ token, titleId, children }: { token: string; titleId?: string; children?: React.ReactNode }) {
  // Schlüssel wird asynchron berechnet (falls nicht schon im Speicher) – danach neu lesen
  const subscribe = useCallback(
    (onChange: () => void) => {
      let live = true;
      void acceptedKey(token).then(() => live && onChange());
      return () => {
        live = false;
      };
    },
    [token],
  );
  const justNow = useSyncExternalStore(
    subscribe,
    () => readAccepted(token),
    () => false,
  );
  return <Empty titleId={titleId} title={justNow ? "Termin angenommen" : "Termin bereits angenommen"}>{children}</Empty>;
}
