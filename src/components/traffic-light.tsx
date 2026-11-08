import type { Light } from "@/lib/rules/prescription";
import { cx } from "./ui";

const LIGHT: Record<Light, { cls: string; label: string }> = {
  green: { cls: "bg-primary", label: "in Ordnung" },
  yellow: { cls: "bg-warn-soft-text ring-2 ring-warn-soft", label: "Achtung" },
  red: { cls: "bg-danger", label: "Frist verpasst" },
  blue: { cls: "bg-info-soft-text", label: "abrechnungsreif" },
  gray: { cls: "bg-border-strong", label: "abgeschlossen" },
};

/** Ampel-Punkt mit Text für Screenreader (Farbe nie allein als Information). */
export function TrafficLight({ light, className, showLabel = false }: { light: Light; className?: string; showLabel?: boolean }) {
  const l = LIGHT[light];
  return (
    <span className={cx("inline-flex items-center gap-2", className)}>
      <span aria-hidden className={cx("inline-block size-3 shrink-0 rounded-full", l.cls)} />
      <span className={showLabel ? "text-sm font-medium" : "sr-only"}>{l.label}</span>
    </span>
  );
}
