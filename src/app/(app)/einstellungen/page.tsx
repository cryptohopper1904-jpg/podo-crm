import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/session";
import { firstSettingsHref } from "@/lib/settings-tabs";
import { settingsGroupsFor } from "@/server/features";

/** /einstellungen → erster Bereich, den die Rolle öffnen darf (Inhaber:in: Praxisdaten, sonst z. B. Sicherheit) */
export default async function SettingsIndex() {
  const auth = await requireAuth();
  redirect(firstSettingsHref(await settingsGroupsFor(auth)));
}
