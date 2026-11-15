import { initials } from "@/lib/calendar-grid";
import { colorVar, type TherapistColor } from "@/lib/therapist-colors";

/**
 * Behandler:in als rundes Kürzel-Badge in der Kalenderfarbe (wie Kontakt-Bilder am iPhone), z. B. „SK“.
 * Getönte Fläche + Text in der dunklen bzw. hellen Variante der Farbe (Kontrast hell/dunkel aus den Tokens) und farbiger
 * Ring; ohne Farbe neutral. Der volle Name steht in title und aria-label.
 */
export function TherapistBadge({ name, color, className = "" }: { name: string; color?: TherapistColor | null; className?: string }) {
  return (
    <span
      role="img"
      aria-label={`Behandler:in: ${name}`}
      title={name}
      data-testid="behandler-kuerzel"
      className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[12px] leading-none font-bold ${color ? "" : "bg-surface-2 text-text ring-1 ring-border-strong"} ${className}`}
      style={color ? { background: colorVar(color, "soft"), color: colorVar(color, "text"), boxShadow: `inset 0 0 0 2px ${colorVar(color)}` } : undefined}
    >
      {initials(name)}
    </span>
  );
}
