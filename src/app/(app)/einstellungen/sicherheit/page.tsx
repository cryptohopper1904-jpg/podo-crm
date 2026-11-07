import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Field, Input } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { changePasswordAction } from "../actions";
import { TotpSetup } from "./totp-setup";

export const metadata = { title: "Sicherheit" };

export default async function SecuritySettings() {
  const auth = await requireAuth();
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardTitle>Zwei-Faktor-Anmeldung {auth.user.totpEnabled ? <Badge tone="primary">aktiv</Badge> : <Badge tone="warn">nicht aktiv</Badge>}</CardTitle>
        <p className="mb-4 text-sm text-muted">Für den Zugriff auf Gesundheitsdaten dringend empfohlen. Funktioniert mit jeder Authenticator-App (z. B. Apple Passwörter, Google Authenticator, 1Password).</p>
        {auth.user.totpEnabled ? <p className="text-sm">Bei jeder Anmeldung wird ein Code abgefragt.</p> : <TotpSetup email={auth.user.email} />}
      </Card>
      <Card>
        <CardTitle>Passwort ändern</CardTitle>
        <ActionForm action={changePasswordAction} submit="Passwort ändern">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Aktuelles Passwort"><Input name="current" type="password" required autoComplete="current-password" /></Field>
            <Field label="Neues Passwort" hint="mindestens 12 Zeichen"><Input name="next" type="password" required minLength={12} autoComplete="new-password" /></Field>
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}
