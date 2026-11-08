"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

function subscribe(cb: () => void) {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => obs.disconnect();
}
const getTheme = () => document.documentElement.dataset.theme ?? "light";

/** Hell/Dunkel-Umschalter. Merkt sich die Wahl pro Gerät. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, getTheme, () => "light");
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      aria-label={theme === "dark" ? "Hellen Modus einschalten" : "Dunklen Modus einschalten"}
      title="Hell/Dunkel umschalten"
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem("podo-theme", next);
        } catch {
          // privates Fenster – Wahl gilt nur für diese Sitzung
        }
      }}
      className={`inline-flex size-11 items-center justify-center rounded-xl border border-border bg-surface text-text hover:bg-surface-2 ${className}`}
    >
      {theme === "dark" ? <Sun size={20} aria-hidden /> : <Moon size={20} aria-hidden />}
    </button>
  );
}
