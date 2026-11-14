"use client";

import { useSyncExternalStore } from "react";
import { Empty } from "@/components/ui";

/** Merker je Tab (sessionStorage): dieses Angebot wurde eben HIER angenommen. Schlüssel ohne den vollständigen Token. */
export const acceptedKey = (token: string) => `podo-angebot-angenommen:${token.slice(-12)}`;

function readAccepted(token: string): boolean {
  try {
    return window.sessionStorage.getItem(acceptedKey(token)) === "1";
  } catch {
    return false;
  }
}

/**
 * Angenommenes Angebot: „Termin angenommen“, wenn es in diesem Tab gerade angenommen wurde (nach dem Annehmen lädt die
 * Seite neu und zeigt diesen Zustand), sonst „Termin bereits angenommen“ (z. B. Link später erneut geöffnet).
 */
export function AcceptedNotice({ token, titleId, children }: { token: string; titleId?: string; children?: React.ReactNode }) {
  const justNow = useSyncExternalStore(
    () => () => undefined,
    () => readAccepted(token),
    () => false,
  );
  return <Empty titleId={titleId} title={justNow ? "Termin angenommen" : "Termin bereits angenommen"}>{children}</Empty>;
}
