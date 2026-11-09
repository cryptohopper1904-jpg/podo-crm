import Link from "next/link";
import { count } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getAuth, getSession } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export const metadata = { title: "Anmelden" };

export default async function LoginPage() {
  if (await getAuth()) redirect("/heute");
  // Plattform-Admin ohne Praxis: bestätigte Sitzung ohne Praxis-Kontext → Konsole bzw. 2FA-Einrichtung
  const row = await getSession();
  if (row?.session.verified && !row.session.organizationId && row.user.isPlatformAdmin) redirect(row.user.totpEnabled ? "/plattform" : "/login/2fa-einrichten");
  const [{ n }] = await db.select({ n: count() }).from(users);
  if (n === 0) redirect("/einrichtung");
  return (
    <>
      <h1 className="font-display text-2xl font-semibold">Anmelden</h1>
      <p className="mt-1 text-sm text-muted">Willkommen zurück in deiner Praxis.</p>
      <LoginForm />
      {process.env.ALLOW_SIGNUP === "true" ? (
        <p className="mt-6 text-center text-sm text-muted">
          Neue Praxis? <Link href="/einrichtung" className="font-semibold text-primary">Kostenlos registrieren</Link>
        </p>
      ) : null}
    </>
  );
}
