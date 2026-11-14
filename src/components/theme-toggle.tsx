"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

function subscribe(cb: () => void) {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => obs.disconnect();
}
const getTheme = () => document.documentElement.dataset.theme ?? "light";

/**
 * Hell/Dunkel-Umschalter. Merkt sich die Wahl pro Gerät.
 * `labelled`: Zeile mit Text (Konto-Menü der Kopfzeile) statt Symbol-Knopf; `className` ersetzt dann das Aussehen.
 */
export function ThemeToggle({ className = "", labelled = false }: { className?: string; labelled?: boolean }) {
  const theme = useSyncExternalStore(subscribe, getTheme, () => "light");
  const next = theme === "dark" ? "light" : "dark";
  const label = theme === "dark" ? "Hellen Modus einschalten" : "Dunklen Modus einschalten";
  const Icon = theme === "dark" ? Sun : Moon;
  return (
    <button
      type="button"
      aria-label={labelled ? undefined : label}
      title={labelled ? undefined : "Hell/Dunkel umschalten"}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem("podo-theme", next);
        } catch {
          // privates Fenster – Wahl gilt nur für diese Sitzung
        }
      }}
      className={labelled ? className : `inline-flex size-11 items-center justify-center rounded-xl border border-border bg-surface text-text hover:bg-surface-2 ${className}`}
    >
      <Icon size={labelled ? 19 : 20} aria-hidden />
      {labelled ? (theme === "dark" ? "Heller Modus" : "Dunkler Modus") : null}
    </button>
  );
}
