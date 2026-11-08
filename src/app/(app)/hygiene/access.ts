import "server-only";
import { denyAccess, requireAuth, type AuthContext } from "@/lib/auth/session";

/**
 * Rechte im Hygiene-Modul:
 * - Chargen, Geräte, Checkliste: ansehen mit medical.read, bearbeiten mit medical.write
 *   (Freigabe/Sperre zusätzlich nur Inhaber:in/Podolog:in, siehe canReleaseBatch)
 * - Material/Bestellliste: auch der Empfang (patients.write), nicht die Steuerberatung
 */
export const canViewHygiene = (a: AuthContext) => a.can("medical.read");
export const canEditHygiene = (a: AuthContext) => a.can("medical.write");
export const canViewMaterials = (a: AuthContext) => a.can("medical.read") || a.can("patients.write");
export const canEditMaterials = (a: AuthContext) => a.can("medical.write") || a.can("patients.write");

export async function requireHygiene(check: (a: AuthContext) => boolean): Promise<AuthContext> {
  const auth = await requireAuth();
  if (!check(auth)) denyAccess(auth);
  return auth;
}
