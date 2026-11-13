import { redirect } from "next/navigation";
import { LogoutForm } from "@/components/pwa/logout-form";
import { Lock } from "lucide-react";
import { getSessionIncludingLocked } from "@/lib/auth/session";
import { logoutAction } from "../actions";
import { UnlockForm } from "./unlock-form";

export const metadata = { title: "Gerät entsperren" };

/**
 * Übergabe-Modus: Das Gerät war bei der Patient:in. Zurück in die Praxisdaten nur mit PIN/Passwort der
 * angemeldeten Person. Bewusst ohne Namen der Patient:in und ohne Praxisdaten.
 */
export default async function UnlockPage() {
  const row = await getSessionIncludingLocked();
  if (!row) redirect("/login");
  if (!row.session.lockedAt) redirect("/heute");
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <Lock size={28} className="text-primary" aria-hidden />
        <h1 className="font-display text-2xl font-semibold">Gerät gesperrt</h1>
      </div>
      <p className="text-sm text-muted">
        Dieses Gerät wurde an eine Patientin bzw. einen Patienten übergeben. Zum Entsperren gibt {row.user.name.split(" ")[0]} die eigene {row.user.unlockPinHash ? "PIN oder das Passwort" : "Passwort"} ein.
      </p>
      <UnlockForm hasPin={!!row.user.unlockPinHash} />
      <LogoutForm action={logoutAction}>
        <button type="submit" className="text-sm font-semibold text-muted hover:text-text">Stattdessen abmelden</button>
      </LogoutForm>
      <p className="text-xs text-muted">Nach 5 Fehlversuchen oder 30 Minuten ist eine neue Anmeldung nötig.</p>
    </div>
  );
}
