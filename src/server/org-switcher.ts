import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { memberships, organizations } from "@/db/schema";
import { isDemoPractice } from "@/lib/demo-practice";
import { switcherModel, type SwitcherModel } from "@/lib/org-switcher";

/** Aktive Mitgliedschaften der Person (nur Praxisname, keine Inhalte) → Modell für den Praxis-/Plattform-Wechsel. */
export async function loadSwitcherModel(p: { userId: string; currentOrgId: string | null; isPlatformAdmin: boolean; totpEnabled: boolean; support: boolean }): Promise<SwitcherModel> {
  const rows = await db
    .select({ organizationId: memberships.organizationId, name: organizations.name, settings: organizations.settings })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(and(eq(memberships.userId, p.userId), eq(memberships.active, true)))
    .orderBy(asc(organizations.name));
  return switcherModel({
    memberships: rows.map((r) => ({ organizationId: r.organizationId, name: r.name, demo: isDemoPractice(r.settings) })),
    currentOrgId: p.currentOrgId,
    isPlatformAdmin: p.isPlatformAdmin,
    totpEnabled: p.totpEnabled,
    support: p.support,
  });
}
