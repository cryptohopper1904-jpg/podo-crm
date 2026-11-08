import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { TotpForm } from "./totp-form";

export const metadata = { title: "Bestätigung" };

export default async function TwoFactorPage() {
  const row = await getSession();
  if (!row) redirect("/login");
  if (row.session.verified) redirect("/heute");
  return (
    <>
      <h1 className="font-display text-2xl font-semibold">Zwei-Faktor-Bestätigung</h1>
      <p className="mt-1 text-sm text-muted">Gib den 6-stelligen Code aus deiner Authenticator-App ein.</p>
      <TotpForm />
    </>
  );
}
