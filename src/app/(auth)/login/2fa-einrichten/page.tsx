import { redirect } from "next/navigation";
import { LogoutForm } from "@/components/pwa/logout-form";
import { getAuthState, getSession } from "@/lib/auth/session";
import { TotpSetup } from "@/app/(app)/einstellungen/sicherheit/totp-setup";
import { confirmOwnTotpAction, logoutAction, startOwnTotpAction } from "../../actions";

export const metadata = { title: "Zwei-Faktor-Anmeldung einrichten" };

/**
 * 2FA-Einrichtung ohne Praxis-Zugriff – für alle mit Pflicht-2FA (Inhaber:innen, Plattform-Admins, ggf. alle Rollen
 * der Praxis; src/lib/auth/two-factor.ts). Bis zur Einrichtung sind nur diese Seite und Abmelden erreichbar.
 * Erreichbar nur mit bestätigter Sitzung und solange 2FA aus ist.
 */
export default async function TotpEnrollPage() {
  const row = await getSession();
  if (!row) redirect("/login");
  if (!row.session.verified) redirect("/login/2fa");
  if (row.user.totpEnabled) redirect(row.session.organizationId ? "/heute" : "/plattform");
  const { twoFactorSetupRequired } = await getAuthState();
  return (
    <>
      <h1 className="text-center font-display text-2xl font-semibold">Zwei-Faktor-Anmeldung einrichten</h1>
      <p className="mt-1 mb-6 text-center text-sm text-muted">
        {!row.session.organizationId
          ? "Die Plattform-Konsole ist nur mit aktiver Zwei-Faktor-Anmeldung zugänglich."
          : twoFactorSetupRequired
            ? "Für dein Konto ist die Zwei-Faktor-Anmeldung Pflicht. Erst danach öffnet sich die Praxis."
            : "Für den Zugriff auf Gesundheitsdaten dringend empfohlen."}{" "}
        Funktioniert mit jeder Authenticator-App (z. B. Apple Passwörter, Google Authenticator, 1Password).
      </p>
      <TotpSetup email={row.user.email} startAction={startOwnTotpAction} confirmAction={confirmOwnTotpAction} />
      <LogoutForm action={logoutAction} className="mt-6 text-center">
        <button type="submit" className="text-sm font-semibold text-muted hover:text-text">Abmelden</button>
      </LogoutForm>
    </>
  );
}
