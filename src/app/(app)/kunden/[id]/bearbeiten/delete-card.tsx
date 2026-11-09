import { ActionForm } from "@/components/action-form";
import { Card, CardTitle, Field, Input } from "@/components/ui";
import { dateDe } from "@/lib/format";
import type { deletionStatus } from "@/server/patient-deletion";
import { deletePatientAction, erasePatientContactAction } from "../../actions";

type Status = NonNullable<Awaited<ReturnType<typeof deletionStatus>>>;

/** „Kund:in löschen“ für Inhaber:innen (Gesamt-Review H3): vollständig oder – bei Aufbewahrungspflicht – Kontaktdaten. */
export function DeletePatientCard({ id, number, status }: { id: string; number: number; status: Status }) {
  return (
    <Card className="mt-6 border-danger/40">
      <CardTitle>Kund:in löschen</CardTitle>
      {status.mode === "delete" ? (
        <>
          <p className="mb-4 text-sm text-muted">
            Es gibt keine Behandlungsdokumentation, keine Anamnese und keine Rechnungen. Die Person wird mit Terminen, Nachrichten, Einwilligungen
            und Fotos vollständig gelöscht (Art. 17 DSGVO). Das lässt sich nicht rückgängig machen.
          </p>
          <ActionForm action={deletePatientAction} submit="Endgültig löschen">
            <input type="hidden" name="id" value={id} />
            <Field label={`Zur Bestätigung die Kundennummer ${number} eintragen`}>
              <Input name="confirm" inputMode="numeric" autoComplete="off" required />
            </Field>
          </ActionForm>
        </>
      ) : (
        <>
          <p className="text-sm text-muted">
            Eine vollständige Löschung ist nicht zulässig, weil aufbewahrungspflichtige Unterlagen existieren (Art. 17 Abs. 3 lit. b DSGVO):
          </p>
          <ul className="my-2 list-disc pl-5 text-sm text-muted">
            {status.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="mb-4 text-sm text-muted">
            {status.expired
              ? `Die Frist ist am ${dateDe(status.retainUntil)} abgelaufen. Die endgültige Löschung der Akte erfolgt über den Betreiber (Fristen-Löschung).`
              : `Aufbewahrung bis voraussichtlich ${dateDe(status.retainUntil)}.`}{" "}
            Möglich ist jetzt: Telefon, E-Mail, Straße und Notizen löschen, alle Werbe- und Kanal-Einwilligungen widerrufen, Marketing-Fotos löschen und die Person
            archivieren. Name, Geburtsdatum und Akte bleiben für die Dokumentationspflicht erhalten.
          </p>
          {status.contactErasedAt ? (
            <p className="text-sm">Kontaktdaten wurden am {dateDe(status.contactErasedAt)} gelöscht.</p>
          ) : (
            <ActionForm action={erasePatientContactAction} submit="Kontaktdaten löschen">
              <input type="hidden" name="id" value={id} />
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input type="checkbox" name="confirm" required className="size-5" />
                Ich habe die Person über die verbleibende Aufbewahrung informiert.
              </label>
            </ActionForm>
          )}
        </>
      )}
    </Card>
  );
}
