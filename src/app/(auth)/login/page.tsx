import Link from "next/link";
import { count } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getAuthState, getSession } from "@/lib/auth/session";
import { TWO_FACTOR_SETUP_PATH } from "@/lib/auth/two-factor";
import { LoginForm } from "./login-form";

export const metadata = { title: "Anmelden" };

export default async function LoginPage(props: PageProps<"/login">) {
  const sp = await props.searchParams;
  const state = await getAuthState();
  if (state.auth) redirect("/heute");
  // Übergabe-Modus: gesperrte Sitzung → nur über /entsperren zurück
  if (state.locked) redirect("/entsperren");
  // Pflicht-2FA noch nicht eingerichtet (Inhaber:in, Plattform-Admin, ggf. alle Rollen): zur Einrichtung
  if (state.twoFactorSetupRequired) redirect(TWO_FACTOR_SETUP_PATH);
  // Plattform-Admin ohne Praxis: bestätigte Sitzung ohne Praxis-Kontext → Konsole bzw. 2FA-Einrichtung
  const row = await getSession();
  if (row?.session.verified && !row.session.organizationId && row.user.isPlatformAdmin) redirect(row.user.totpEnabled ? "/plattform" : "/login/2fa-einrichten");
  const [{ n }] = await db.select({ n: count() }).from(users);
  if (n === 0) redirect("/einrichtung");
  return (
    <>
      <h1 className="font-display text-2xl font-semibold">Anmelden</h1>
      <p className="mt-1 text-sm text-muted">Willkommen zurück in deiner Praxis.</p>
      {sp.entsperren === "gesperrt" ? (
        <p role="status" className="mt-4 rounded-xl bg-warn-soft p-3 text-sm text-warn-soft-text">Zu viele Fehlversuche beim Entsperren bzw. Übergabe länger als 30 Minuten – bitte neu anmelden.</p>
      ) : null}
      {sp.passwort === "neu" ? (
        <p role="status" className="mt-4 rounded-xl bg-primary-soft p-3 text-sm">Dein Passwort wurde geändert und alle Sitzungen wurden beendet. Bitte melde dich neu an.</p>
      ) : null}
      <LoginForm />
      {process.env.ALLOW_SIGNUP === "true" ? (
        <p className="mt-6 text-center text-sm text-muted">
          Neue Praxis? <Link href="/einrichtung" className="font-semibold text-primary">Kostenlos registrieren</Link>
        </p>
      ) : null}
    </>
  );
}
