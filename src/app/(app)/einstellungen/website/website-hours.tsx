"use client";

import Link from "next/link";
import { useState } from "react";
import { OpeningHoursEditor } from "@/components/opening-hours-editor";
import { Checkbox } from "@/components/ui";
import { weekSummary, type WeekHours } from "@/lib/opening-hours";

/** Website-Zeiten: Standard = Praxis-Öffnungszeiten; optional abweichend gepflegt (settings.openingHours). */
export function WebsiteHours({ custom, practice, own }: { custom: boolean; practice: WeekHours | null; own: WeekHours }) {
  const [same, setSame] = useState(!custom);
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-4">
      <legend className="px-1 text-sm font-semibold">Praxiszeiten auf der Website</legend>
      <Checkbox name="samePracticeHours" checked={same} onChange={(e) => setSame(e.target.checked)} label="wie Praxis-Öffnungszeiten" />
      {same ? (
        <p className="text-sm text-muted">
          {practice ? weekSummary(practice) : "Noch keine Öffnungszeiten gespeichert – die Website zeigt keine Zeiten"} – {practice ? "ändern" : "pflegen"} unter{" "}
          <Link className="font-semibold text-primary underline" href="/einstellungen/oeffnungszeiten">Einstellungen → Öffnungszeiten</Link>.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted">Abweichende Zeiten nur für die Website (freie Termine richten sich weiter nach den Praxis-Öffnungszeiten).</p>
          <OpeningHoursEditor name="websiteHours" initial={own} legend="Abweichende Website-Zeiten" />
        </>
      )}
    </fieldset>
  );
}
