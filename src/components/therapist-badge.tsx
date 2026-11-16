import { initials } from "@/lib/calendar-grid";
import { colorVar, type TherapistColor } from "@/lib/therapist-colors";

const SIZE = {
  /** Terminzeile (Heute, Kalender-Liste) */
  md: "size-7 text-[12px]",
  /** Termin-Block der Zeitachse – so hoch wie die Symbole N/R, als schmale Pille (zwei Buchstaben in 9 px lesbar) */
  sm: "h-4 min-w-5 px-[3px] text-[9px]",
} as const;

/**
 * Behandler:in als rundes Kürzel-Badge in der Kalenderfarbe (wie Kontakt-Bilder am iPhone), z. B. „SK“.
 * Getönte Fläche + Text in der dunklen bzw. hellen Variante der Farbe (Kontrast hell/dunkel aus den Tokens) und farbiger
 * Ring; ohne Farbe neutral. Der volle Name steht in title und aria-label.
 */
export function TherapistBadge({ name, color, size = "md", className = "" }: { name: string; color?: TherapistColor | null; size?: keyof typeof SIZE; className?: string }) {
  const ring = size === "sm" ? 1 : 2;
  return (
    <span
      role="img"
      aria-label={`Behandler:in: ${name}`}
      title={name}
      data-testid="behandler-kuerzel"
      className={`inline-flex shrink-0 items-center justify-center rounded-full leading-none font-bold ${SIZE[size]} ${color ? "" : "bg-surface-2 text-text ring-1 ring-border-strong"} ${className}`}
      style={color ? { background: colorVar(color, "soft"), color: colorVar(color, "text"), boxShadow: `inset 0 0 0 ${ring}px ${colorVar(color)}` } : undefined}
    >
      {initials(name)}
    </span>
  );
}
