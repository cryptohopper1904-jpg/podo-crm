import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Field, Input } from "@/components/ui";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations, users } from "@/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { securitySettingsOf, twoFactorRequired } from "@/lib/auth/two-factor";
import { changePasswordAction, saveSecurityPolicyAction, setUnlockPinAction } from "../actions";
import { TotpSetup } from "./totp-setup";

export const metadata = { title: "Sicherheit" };

export default async function SecuritySettings() {
  const auth = await requireAuth();
  const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, auth.organization.id));
  const policy = securitySettingsOf(org?.settings);
  const [me] = await db.select({ pin: users.unlockPinHash }).from(users).where(eq(users.id, auth.user.id));
  const mandatory = twoFactorRequired({ role: auth.role, isPlatformAdmin: auth.user.isPlatformAdmin, orgSettings: org?.settings });
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardTitle>Zwei-Faktor-Anmeldung {auth.user.totpEnabled ? <Badge tone="primary">aktiv</Badge> : <Badge tone="warn">nicht aktiv</Badge>}</CardTitle>
        <p className="mb-4 text-sm text-muted">{mandatory ? "Für dein Konto Pflicht." : "Für den Zugriff auf Gesundheitsdaten dringend empfohlen."} Funktioniert mit jeder Authenticator-App (z. B. Apple Passwörter, Google Authenticator, 1Password).</p>
        {auth.user.totpEnabled ? <p className="text-sm">Bei jeder Anmeldung wird ein Code abgefragt.</p> : <TotpSetup email={auth.user.email} />}
      </Card>
      {auth.can("users.manage") ? (
        <Card>
          <CardTitle>2FA-Pflicht im Team</CardTitle>
          <p className="mb-4 text-sm text-muted">
            Für Inhaber:innen ist die Zwei-Faktor-Anmeldung immer Pflicht. Hier legst du fest, ob alle im Team sie brauchen. Wer sie noch nicht eingerichtet hat,
            wird ab dem nächsten Seitenaufruf zur Einrichtung geleitet und sieht bis dahin keine Praxisdaten.
          </p>
          <ActionForm action={saveSecurityPolicyAction}>
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input type="checkbox" name="require2faAllRoles" defaultChecked={policy.require2faAllRoles} className="size-5" />
              Zwei-Faktor-Anmeldung für alle Rollen verlangen
            </label>
          </ActionForm>
        </Card>
      ) : null}
      <Card>
        <CardTitle>PIN für die Übergabe an Patient:innen {me?.pin ? <Badge tone="primary">eingerichtet</Badge> : <Badge tone="warn">keine</Badge>}</CardTitle>
        <p className="mb-4 text-sm text-muted">
          Mit „An Patient:in übergeben“ (Akte → Anamnese) zeigt das Gerät nur noch den Anamnesebogen mit Datenschutz-Einwilligungen. Zurück in die Praxisdaten geht es nur mit
          dieser PIN oder deinem Passwort. Nach 5 Fehlversuchen oder 30 Minuten ist eine neue Anmeldung nötig.
        </p>
        <ActionForm action={setUnlockPinAction} submit={me?.pin ? "PIN ändern" : "PIN speichern"}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Neue PIN" hint="4–8 Ziffern, nicht 1234 o. Ä."><Input name="pin" type="password" inputMode="numeric" pattern="[0-9]{4,8}" required autoComplete="off" /></Field>
            <Field label="Dein Passwort zur Bestätigung"><Input name="current" type="password" required autoComplete="current-password" /></Field>
          </div>
        </ActionForm>
        {me?.pin ? (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer font-semibold text-muted">PIN entfernen</summary>
            <ActionForm action={setUnlockPinAction} submit="PIN entfernen">
              <input type="hidden" name="remove" value="1" />
              <Field label="Dein Passwort zur Bestätigung"><Input name="current" type="password" required autoComplete="current-password" /></Field>
            </ActionForm>
          </details>
        ) : null}
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
