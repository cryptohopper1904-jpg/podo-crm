import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { memberships } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, ForbiddenError } from "@/lib/auth/assert";
import { CALENDAR_ROLES } from "@/lib/auth/permissions";
import type { AuthContext } from "@/lib/auth/session";
import { assignTherapistColors, byJoined, isTherapistColor, type TherapistColor } from "@/lib/therapist-colors";
import { therapists } from "./appointments";

/** Kalenderfarbe je Behandler:in der Praxis (gewählt oder automatisch) */
export async function teamColors(auth: AuthContext): Promise<Map<string, TherapistColor>> {
  assertCan(auth, "appointments.read");
  return assignTherapistColors(byJoined(await therapists(auth)));
}

export type ColorResult = { ok: true } | { ok: false; error: string };

/**
 * Kalenderfarbe setzen (null = automatisch). Eigene Farbe: jede Behandler:in; Farbe anderer: nur mit Teamverwaltung
 * (users.manage). Im Support-Modus nie. Nur Personen mit eigener Kalenderspalte (Inhaber:in, Podolog:in).
 */
export async function setTherapistColor(auth: AuthContext, userId: string, color: string | null): Promise<ColorResult> {
  if (auth.support) throw new ForbiddenError("users.manage");
  if (userId !== auth.user.id) assertCan(auth, "users.manage");
  if (color !== null && !isTherapistColor(color)) return { ok: false, error: "Unbekannte Farbe." };
  const org = auth.organization.id;
  const rows = await db
    .update(memberships)
    .set({ color })
    .where(and(eq(memberships.organizationId, org), eq(memberships.userId, userId), eq(memberships.active, true), inArray(memberships.role, [...CALENDAR_ROLES])))
    .returning({ id: memberships.id });
  if (!rows.length) return { ok: false, error: "Nur Inhaber:in und Podolog:innen haben eine eigene Kalenderspalte." };
  await audit({ organizationId: org, userId: auth.user.id, action: "member.calendar_color", entity: "membership", entityId: rows[0].id, meta: { color, self: userId === auth.user.id } });
  return { ok: true };
}
