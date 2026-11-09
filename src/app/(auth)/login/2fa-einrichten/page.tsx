import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { TotpSetup } from "@/app/(app)/einstellungen/sicherheit/totp-setup";
import { confirmOwnTotpAction, startOwnTotpAction } from "../../actions";

export const metadata = { title: "Zwei-Faktor-Anmeldung einrichten" };

/**
 * 2FA-Einrichtung ohne Praxis-Kontext – v. a. für Plattform-Admins ohne Mitgliedschaft (BOOTSTRAP_ADMIN_*),
 * denn die Plattform-Konsole verlangt aktive 2FA. Erreichbar nur mit bestätigter Sitzung und solange 2FA aus ist.
 */
export default async function TotpEnrollPage() {
  const row = await getSession();
  if (!row) redirect("/login");
  if (!row.session.verified) redirect("/login/2fa");
  if (row.user.totpEnabled) redirect(row.session.organizationId ? "/heute" : "/plattform");
  return (
    <>
      <h1 className="font-display text-2xl font-semibold">Zwei-Faktor-Anmeldung einrichten</h1>
      <p className="mt-1 mb-6 text-sm text-muted">
        {row.session.organizationId
          ? "Für den Zugriff auf Gesundheitsdaten dringend empfohlen."
          : "Die Plattform-Konsole ist nur mit aktiver Zwei-Faktor-Anmeldung zugänglich."}{" "}
        Funktioniert mit jeder Authenticator-App (z. B. Apple Passwörter, Google Authenticator, 1Password).
      </p>
      <TotpSetup email={row.user.email} startAction={startOwnTotpAction} confirmAction={confirmOwnTotpAction} />
    </>
  );
}
