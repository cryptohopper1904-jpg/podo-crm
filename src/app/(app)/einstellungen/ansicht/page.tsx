import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Card, CardTitle } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { VIEW_LEVEL_HINTS, VIEW_LEVEL_LABELS, VIEW_LEVELS } from "@/lib/view-level";
import { currentViewLevel } from "@/server/view-level";
import { saveViewLevelAction } from "./actions";

export const metadata = { title: "Ansicht" };

/** Persönliche Ansicht (für alle Rollen; gilt nur für die angemeldete Person). */
export default async function ViewSettings() {
  const auth = await requireAuth();
  const level = await currentViewLevel();
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardTitle>Ansicht</CardTitle>
        <p className="mb-4 text-sm text-muted">
          Legt fest, wie viele Bereiche links in der Navigation und auf der Startseite „Heute“ erscheinen. Gilt nur für dein Konto.
          Ausgeblendete Bereiche bleiben erreichbar – unten in der Navigation unter „Mehr“ oder über{" "}
          <Link href="/bereiche" className="font-semibold text-primary hover:underline">Alle Bereiche</Link>. Rechte ändern sich dadurch nicht.
        </p>
        {auth.support ? (
          <p className="text-sm text-muted">Im Support-Modus nicht änderbar.</p>
        ) : (
          <ActionForm action={saveViewLevelAction}>
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">Ansicht wählen</legend>
              {VIEW_LEVELS.map((l) => (
                <label key={l} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 hover:bg-surface-2 has-[:checked]:border-primary has-[:checked]:bg-surface-2">
                  <input type="radio" name="level" value={l} defaultChecked={l === level} className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]" />
                  <span className="min-w-0">
                    <span className="block text-[15px] font-semibold">{VIEW_LEVEL_LABELS[l]}{l === "komplex" ? " (Standard)" : ""}</span>
                    <span className="block text-sm text-muted">{VIEW_LEVEL_HINTS[l]}</span>
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
