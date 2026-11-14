import { redirect } from "next/navigation";
import { LogoutForm } from "@/components/pwa/logout-form";
import { getSession } from "@/lib/auth/session";
import { logoutAction } from "../../actions";
import { TotpForm } from "./totp-form";

export const metadata = { title: "Bestätigung" };

export default async function TwoFactorPage() {
  const row = await getSession();
  if (!row) redirect("/login");
  if (row.session.verified) redirect(row.session.organizationId ? "/heute" : "/plattform");
  return (
    <>
      <h1 className="font-display text-2xl font-semibold">Zwei-Faktor-Bestätigung</h1>
      <p className="mt-1 text-sm text-muted">Gib den 6-stelligen Code aus deiner Authenticator-App ein.</p>
      <TotpForm />
      <p className="mt-6 text-sm text-muted">
        Kein Zugriff auf die Authenticator-App? Wende dich an die Inhaber:in deiner Praxis bzw. an den PodoHero-Support.
      </p>
      <LogoutForm action={logoutAction} className="mt-2">
        <button type="submit" className="inline-flex min-h-11 w-full items-center justify-center rounded-xl text-sm font-semibold text-muted hover:bg-surface-2 hover:text-text">
          Abmelden / anderes Konto
        </button>
      </LogoutForm>
    </>
  );
}
