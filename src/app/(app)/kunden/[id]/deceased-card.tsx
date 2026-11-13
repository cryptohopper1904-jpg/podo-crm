import { ActionForm } from "@/components/action-form";
import { Card, CardTitle, Field, Input } from "@/components/ui";
import { dateDe } from "@/lib/format";
import type { DeceasedInfo } from "@/lib/patient-deceased";
import { markDeceasedAction, undoDeceasedAction } from "../actions";

/**
 * „Patient:in verstorben“ (Recht patients.write): markieren mit optionalem Sterbedatum oder – bei Fehleingabe – zurücknehmen.
 * Die Akte bleibt erhalten (Aufbewahrungspflicht 10 Jahre); Rechnungen für erfolgte Behandlungen bleiben möglich.
 */
export function DeceasedCard({ id, info, futureOwn, futureFeed }: { id: string; info: DeceasedInfo | null; futureOwn: number; futureFeed: number }) {
  if (info) {
    return (
      <Card>
        <CardTitle>Verstorben</CardTitle>
        <p className="mb-3 text-sm text-muted">
          {info.date ? `Sterbedatum: ${dateDe(info.date)}. ` : "Sterbedatum nicht angegeben. "}
          {info.markedAt ? `Markiert am ${dateDe(info.markedAt)}. ` : ""}
          Keine Erinnerungen, Rückholung, Wartelisten-Angebote, Portal-Links oder neuen Termine. Die Akte bleibt lesbar; Rechnungen für erfolgte
          Behandlungen (an Erb:innen bzw. Rechnungsempfänger:in) sind weiter möglich.
        </p>
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-primary">Fehleingabe? Markierung zurücknehmen</summary>
          <div className="mt-3">
            <ActionForm action={undoDeceasedAction} submit="Zurücknehmen">
              <input type="hidden" name="id" value={id} />
              <Field label="Grund (optional)">
                <Input name="reason" maxLength={200} autoComplete="off" />
              </Field>
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input type="checkbox" name="confirm" required className="size-5" />
                Die Markierung war eine Fehleingabe.
              </label>
              <p className="text-xs text-muted">Abgesagte Termine, erledigte Wartelisten-Einträge und widerrufene Links werden nicht wiederhergestellt.</p>
            </ActionForm>
          </div>
        </details>
      </Card>
    );
  }
  return (
    <Card>
      <details>
        <summary className="cursor-pointer font-display text-xl font-semibold">Patient:in verstorben</summary>
        <div className="mt-3">
          <p className="mb-3 text-sm text-muted">
            Danach gibt es keine Erinnerungen, Rückholung, Wartelisten-Angebote, Portal-Links und keine neuen Termine mehr. Die Akte wird nicht gelöscht
            (Aufbewahrungspflicht 10 Jahre). Jede Änderung wird protokolliert und lässt sich bei einer Fehleingabe zurücknehmen.
          </p>
          <ActionForm action={markDeceasedAction} submit="Als verstorben markieren">
            <input type="hidden" name="id" value={id} />
            <Field label="Sterbedatum (optional)" hint="TT.MM.JJJJ">
              <Input name="deathDate" placeholder="TT.MM.JJJJ" inputMode="numeric" autoComplete="off" />
            </Field>
            {futureOwn > 0 ? (
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input type="checkbox" name="cancelFuture" required className="size-5" />
                {futureOwn === 1 ? "Den geplanten künftigen Termin absagen." : `Die ${futureOwn} geplanten künftigen Termine absagen.`}
              </label>
            ) : null}
            {futureFeed > 0 ? (
              <p className="text-xs text-muted">
                {futureFeed} künftige(r) Termin(e) stammen aus dem Kalender-Abo und müssen in der Quelle (z. B. Doctolib) abgesagt werden.
              </p>
            ) : null}
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input type="checkbox" name="confirm" required className="size-5" />
              Ich bestätige, dass die Patient:in verstorben ist.
            </label>
          </ActionForm>
        </div>
      </details>
    </Card>
  );
}
