import Link from "next/link";
import { resetTokenValid } from "@/server/password-reset";
import { NewPasswordForm } from "./new-password-form";

export const metadata = { title: "Neues Passwort", referrer: "no-referrer" };

export default async function NewPasswordPage(props: PageProps<"/login/passwort-neu">) {
  const sp = await props.searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  const valid = await resetTokenValid(token);
  return (
    <>
      <h1 className="font-display text-2xl font-semibold">Neues Passwort festlegen</h1>
      {valid ? (
        <>
          <p className="mt-1 text-sm text-muted">Mindestens 12 Zeichen. Danach wirst du auf allen Geräten abgemeldet; die Zwei-Faktor-Anmeldung bleibt aktiv.</p>
          <NewPasswordForm token={token} />
        </>
      ) : (
        <p className="mt-3 text-sm text-danger">Der Link ist ungültig, abgelaufen oder wurde bereits verwendet.</p>
      )}
      <p className="mt-6 text-center text-sm text-muted">
        <Link href={valid ? "/login" : "/login/passwort-vergessen"} className="font-semibold text-primary">{valid ? "Zurück zur Anmeldung" : "Neuen Link anfordern"}</Link>
      </p>
    </>
  );
}
