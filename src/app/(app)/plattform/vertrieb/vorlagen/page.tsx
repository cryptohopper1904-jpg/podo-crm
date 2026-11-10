import { Card } from "@/components/ui";
import { PLACEHOLDERS, PLACEHOLDER_HELP } from "@/lib/vertrieb/constants";
import { requirePlatformAdmin } from "@/server/platform";
import { getSalesSettings } from "@/server/vertrieb";
import { resetTemplatesAction, saveTemplatesAction } from "../actions";
import { TemplatesForm } from "./templates-form";

export const metadata = { title: "Vorlagen · Vertrieb" };

export default async function TemplatesPage() {
  await requirePlatformAdmin();
  const s = await getSalesSettings();
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
      <TemplatesForm action={saveTemplatesAction} templates={s.templates} delays={s.delays} />
      <div className="flex flex-col gap-5">
        <Card className="text-sm">
          <h2 className="font-display text-lg font-semibold">Platzhalter</h2>
          <ul className="mt-2 flex flex-col gap-1.5">
            {PLACEHOLDERS.map((p) => (
              <li key={p}><code>{`{{${p}}}`}</code> – {PLACEHOLDER_HELP[p]}</li>
            ))}
          </ul>
          <p className="mt-3 text-muted">Reiner Text, kein HTML. Impressum und Abmeldelink werden automatisch unter jede Mail gesetzt.</p>
        </Card>
        <Card className="text-sm">
          <h2 className="font-display text-lg font-semibold">Standard</h2>
          <form action={resetTemplatesAction} className="mt-2">
            <button className="font-semibold text-primary">Auf Standardvorlagen zurücksetzen</button>
          </form>
        </Card>
      </div>
    </div>
  );
}
