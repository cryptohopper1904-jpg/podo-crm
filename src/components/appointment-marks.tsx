import { MARK_LABELS, markKinds, type AppointmentMark, type MarkKind } from "@/lib/appointment-marks";
import type { TherapistColor } from "@/lib/therapist-colors";
import { TherapistBadge } from "./therapist-badge";

/**
 * Symbol eines Termins: „N“ Neupatient:in (Akzentfarbe), „R“ Rechnung offen (grau) / geschrieben (grün).
 * Farben aus den Tokens (hell/dunkel, Kontrast ≥ 4,5:1); die Bedeutung steht zusätzlich in title/aria-label.
 * `md` für Terminzeilen (Heute, Kalender-Liste), `sm` im Termin-Block der Zeitachse.
 */
export function MarkBadge({ kind, size = "sm" }: { kind: MarkKind; size?: "sm" | "md" }) {
  const cls =
    kind === "newPatient"
      ? "bg-accent-soft text-accent-soft-text ring-accent-soft-text/50"
      : kind === "written"
        ? "bg-primary text-on-primary ring-primary"
        : "bg-surface text-muted ring-border-strong";
  const label = MARK_LABELS[kind];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-mark={kind}
      className={`inline-flex shrink-0 items-center justify-center rounded-full leading-none font-bold no-underline ring-1 ${size === "md" ? "size-6 text-[12px]" : "size-4 text-[10px]"} ${cls}`}
    >
      {kind === "newPatient" ? "N" : "R"}
    </span>
  );
}

/**
 * Markierungen eines Termins – überall gleich (Heute, Kalender-Liste, Tag, Woche, Monat auf dem Handy):
 * Symbole N/R und das Kürzel der Behandler:in in ihrer Kalenderfarbe. Ohne Inhalt: nichts.
 */
export function AppointmentMarks({
  mark,
  therapist,
  color,
  size = "md",
  fit = false,
  className = "",
}: {
  mark?: AppointmentMark | null;
  /** Name der Behandler:in (null = ohne Kürzel) */
  therapist?: string | null;
  color?: TherapistColor | null;
  size?: "sm" | "md";
  /**
   * Schmaler Platz (Termin-Block): nur ganze Symbole zeigen – was nicht in eine Zeile passt, bricht in eine
   * abgeschnittene zweite Zeile um (nie halb sichtbar); die Bedeutung steht zusätzlich im Tooltip des Blocks.
   */
  fit?: boolean;
  className?: string;
}) {
  const kinds = markKinds(mark);
  if (!kinds.length && !therapist) return null;
  return (
    <span data-testid="termin-markierungen" className={`inline-flex items-center ${fit ? `min-w-0 max-w-full flex-wrap justify-end overflow-hidden ${size === "md" ? "h-6" : "h-4"}` : "shrink-0"} ${size === "md" ? "gap-1" : "gap-0.5"} ${className}`}>
      {kinds.map((k) => (
        <MarkBadge key={k} kind={k} size={size} />
      ))}
      {therapist ? <TherapistBadge name={therapist} color={color} size={size} /> : null}
    </span>
  );
}

/** Legende der Symbole N/R (Kalender, Liste, Heute) */
export function MarkLegend({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex flex-wrap items-center gap-x-3 gap-y-1 ${className}`} data-testid="symbol-legende">
      <span className="inline-flex items-center gap-1"><MarkBadge kind="newPatient" /> {MARK_LABELS.newPatient}</span>
      <span className="inline-flex items-center gap-1"><MarkBadge kind="open" /> {MARK_LABELS.open}</span>
      <span className="inline-flex items-center gap-1"><MarkBadge kind="written" /> {MARK_LABELS.written}</span>
    </span>
  );
}
