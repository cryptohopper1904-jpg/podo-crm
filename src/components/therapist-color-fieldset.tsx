import { ActionForm } from "./action-form";
import { saveCalendarColorAction } from "@/app/(app)/einstellungen/ansicht/actions";
import { THERAPIST_COLORS, THERAPIST_COLOR_LABELS, dotStyle, isTherapistColor, type TherapistColor } from "@/lib/therapist-colors";

/**
 * Kalenderfarbe wählen (Farbpunkte). `stored` = gespeicherte Wahl (null = automatisch), `effective` = derzeit
 * angezeigte Farbe (bei „automatisch“ die vergebene). Speichern über saveCalendarColorAction (Rechte serverseitig).
 */
export function TherapistColorForm({ userId, stored, effective, legend }: { userId: string; stored: string | null; effective: TherapistColor; legend: string }) {
  const current = isTherapistColor(stored) ? stored : "";
  return (
    <ActionForm action={saveCalendarColorAction} submit="Farbe speichern" className="flex flex-col gap-3">
      <input type="hidden" name="userId" value={userId} />
      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="sr-only">{legend}</legend>
        <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border border-border px-3 text-sm has-[:checked]:border-primary has-[:checked]:font-semibold has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring">
          <input type="radio" name="color" value="" defaultChecked={current === ""} className="sr-only" />
          <span className="inline-block size-3.5 rounded-full" style={dotStyle(effective)} aria-hidden />
          automatisch
        </label>
        {THERAPIST_COLORS.map((c) => (
          <label
            key={c}
            title={THERAPIST_COLOR_LABELS[c]}
            className="inline-flex size-9 cursor-pointer items-center justify-center rounded-full ring-offset-2 ring-offset-surface has-[:checked]:ring-2 has-[:checked]:ring-text has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"
          >
            <input type="radio" name="color" value={c} defaultChecked={current === c} className="sr-only" />
            <span className="inline-block size-6 rounded-full" style={dotStyle(c)} aria-hidden />
            <span className="sr-only">{THERAPIST_COLOR_LABELS[c]}</span>
          </label>
        ))}
      </fieldset>
    </ActionForm>
  );
}
