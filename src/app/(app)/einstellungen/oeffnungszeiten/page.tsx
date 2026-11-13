import Link from "next/link";
import { eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { OpeningHoursEditor } from "@/components/opening-hours-editor";
import { Card } from "@/components/ui";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { STATES, type StateCode } from "@/lib/holidays";
import { DEFAULT_WEEK, NO_HOURS_NOTE, storedPracticeHours } from "@/lib/opening-hours";
import { websiteSettings } from "@/lib/website";
import { saveOpeningHoursAction } from "../actions";

export const metadata = { title: "Öffnungszeiten" };

export default async function OpeningHoursSettings() {
  const auth = await requireAuth("settings.manage");
  const [o] = await db.select({ settings: organizations.settings, state: organizations.state }).from(organizations).where(eq(organizations.id, auth.organization.id));
  const settings = o.settings ?? {};
  const stored = storedPracticeHours(settings);
  const websiteOwn = websiteSettings(settings).customHours;
  return (
    <Card>
      <h2 className="mb-1 font-display text-lg font-semibold">Öffnungszeiten</h2>
      <p className="mb-4 text-sm text-muted">
        Je Wochentag geschlossen oder ein bis mehrere Zeitfenster (z. B. mit Mittagspause). Gilt für freie Termine bei Online-Buchung,
        KI-Telefon und Antwortvorschlägen, für Teammitglieder ohne eigene Arbeitszeiten und für die Praxis-Website
        {websiteOwn ? " (dort sind derzeit abweichende Zeiten eingestellt)" : ""}. An gesetzlichen Feiertagen ({STATES[o.state as StateCode] ?? o.state}) ist
        automatisch geschlossen.
      </p>
      {stored ? null : (
        <p className="mb-4 rounded-xl bg-info-soft p-3 text-sm text-info-soft-text">
          {NO_HOURS_NOTE}. Website und Telefon-Assistent nennen erst nach dem Speichern Öffnungszeiten.
        </p>
      )}
      <ActionForm action={saveOpeningHoursAction}>
        <OpeningHoursEditor name="hours" initial={stored ?? DEFAULT_WEEK} />
        <p className="text-xs text-muted">
          Eigene Arbeitszeiten und Abwesenheiten je Person unter <Link className="underline" href="/team">Team</Link>, Website-Zeiten unter{" "}
          <Link className="underline" href="/einstellungen/website">Einstellungen → Website</Link>.
        </p>
      </ActionForm>
    </Card>
  );
}
