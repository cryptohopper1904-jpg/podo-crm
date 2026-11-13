import "server-only";
import { and, count, eq } from "drizzle-orm";
import { withOrg } from "@/db";
import { messages } from "@/db/schema";
import type { AuthContext } from "@/lib/auth/session";
import { removeHiddenNav } from "@/lib/features";
import type { NavKey } from "@/lib/nav";

/** Navigationspunkte, die diese Person nach Rolle/Rechten und Praxis-Schaltern sehen darf (App-Layout, /bereiche). */
export function navAllowed(auth: AuthContext): NavKey[] {
  const allowed: NavKey[] = ["heute"];
  if (auth.can("appointments.read")) allowed.push("kalender", "touren");
  if (auth.can("patients.read")) allowed.push("kunden", "verordnungen", "pflegeheime");
  if (auth.can("medical.write")) allowed.push("doku");
  if (auth.can("messages.read")) allowed.push("posteingang", "telefon", "bewertungen");
  if (auth.can("invoices.read")) allowed.push("rechnungen", "gutscheine");
  if (auth.can("cash.read")) allowed.push("kasse");
  if (auth.can("invoices.read")) allowed.push("produkte");
  if (auth.can("medical.read") || auth.can("patients.write")) allowed.push("hygiene");
  if (auth.role !== "accountant") allowed.push("team");
  allowed.push("news");
  if (auth.can("finance.read")) allowed.push("auswertung");
  if (auth.can("settings.manage")) allowed.push("einstellungen");
  if (auth.user.isPlatformAdmin && auth.user.totpEnabled && !auth.support) allowed.push("plattform");
  removeHiddenNav(auth.organization, allowed); // Kassen-Themen bei „nur Privat-/Selbstzahler“ (src/lib/features.ts)
  return allowed;
}

/** Zähler für die Navigation (Posteingang: neue Nachrichten) */
export async function navBadges(auth: AuthContext): Promise<Partial<Record<NavKey, number>>> {
  let unread = 0;
  if (auth.can("messages.read")) {
    const [r] = await withOrg(auth.organization.id, (tx) =>
      tx
        .select({ n: count() })
        .from(messages)
        .where(and(eq(messages.organizationId, auth.organization.id), eq(messages.status, "new"))),
    );
    unread = r?.n ?? 0;
  }
  return { posteingang: unread };
}
