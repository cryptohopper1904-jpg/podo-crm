"use client";

import { ArrowLeft } from "lucide-react";
import { useSyncExternalStore } from "react";

const noop = () => () => {};

/**
 * „Zurück“ im Browserverlauf (für Fehlerseiten). Ohne Verlauf (neuer Tab, Link aus einer Mail, installierte App)
 * erscheint der Knopf nicht – dann gäbe es kein „zurück“.
 */
export function HistoryBack({ className, label = "Zurück" }: { className?: string; label?: string }) {
  const canGoBack = useSyncExternalStore(noop, () => history.length > 1, () => false);
  if (!canGoBack) return null;
  return (
    <button type="button" className={className} onClick={() => history.back()}>
      <ArrowLeft size={18} aria-hidden />
      {label}
    </button>
  );
}
