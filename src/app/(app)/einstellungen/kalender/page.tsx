import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Card, CardTitle } from "@/components/ui";
import { getSession, requireAuth } from "@/lib/auth/session";
import { gridScale, SLOT_STEP_LABELS, SLOT_STEPS } from "@/lib/calendar-grid";
import { calendarSlotOf } from "@/server/calendar-board";
import { saveCalendarSlotAction } from "./actions";

export const metadata = { title: "Kalender" };

const HINTS: Record<number, string> = {
  60: "Eine Zeile je Stunde – viel vom Tag auf einen Blick.",
  30: "Halbe Stunden.",
  15: "Viertelstunden wie bisher.",
  10: "Feiner – die Stunde wird höher.",
  5: "Sehr fein, jede Zeile mit Uhrzeit – die Stunde wird deutlich höher.",
};

/** Persönliche Kalender-Einstellungen (gilt nur für die angemeldete Person). */
export default async function CalendarSettings() {
  const auth = await requireAuth("appointments.read");
  const session = await getSession();
  const current = calendarSlotOf(session?.user.prefs);
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardTitle>Raster der Zeitachse</CardTitle>
        <p className="mb-4 text-sm text-muted">
          Gilt für die vollständige Kalenderansicht (Tag und Woche): jede Rasterzeile trägt ihre Uhrzeit, ein Klick in eine freie Zeile legt dort
          einen Termin an, beim Ziehen rasten Termine im gewählten Raster ein. Termine zu anderen Zeiten (z. B. 10:20 bei 15 Minuten) stehen weiterhin
          genau an ihrer Uhrzeit. Gilt nur für dein Konto. Weitere Anzeige-Optionen (Behandler:innen, Hausbesuche, Feiertage …) findest du im{" "}
          <Link href="/kalender" className="font-semibold text-primary hover:underline">Kalender</Link> unter „Anzeige“.
        </p>
        {auth.support ? (
          <p className="text-sm text-muted">Im Support-Modus nicht änderbar.</p>
        ) : (
          <ActionForm action={saveCalendarSlotAction}>
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">Raster wählen</legend>
              {SLOT_STEPS.map((s) => (
                <label key={s} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 hover:bg-surface-2 has-[:checked]:border-primary has-[:checked]:bg-surface-2">
                  <input type="radio" name="slotMin" value={s} defaultChecked={s === current} className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]" />
                  <span className="min-w-0">
                    <span className="block text-[15px] font-semibold">{SLOT_STEP_LABELS[s]}</span>
                    <span className="block text-sm text-muted">{HINTS[s]} {gridScale(s).hourPx} px je Stunde.</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </ActionForm>
        )}
      </Card>
    </div>
  );
}
