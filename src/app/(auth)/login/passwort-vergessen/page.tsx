import Link from "next/link";
import { ForgotPasswordForm } from "./forgot-form";

export const metadata = { title: "Passwort vergessen" };

export default function ForgotPasswordPage() {
  return (
    <>
      <h1 className="font-display text-2xl font-semibold">Passwort vergessen</h1>
      <p className="mt-1 text-sm text-muted">Gib die E-Mail-Adresse deines Kontos ein. Wir schicken dir einen Link, mit dem du ein neues Passwort festlegst.</p>
      <ForgotPasswordForm />
      <p className="mt-6 text-center text-sm text-muted">
        <Link href="/login" className="inline-flex min-h-11 items-center font-semibold text-primary">Zurück zur Anmeldung</Link>
      </p>
    </>
  );
}
