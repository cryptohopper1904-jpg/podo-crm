/**
 * 2FA-Pflicht (Gesamt-Review H1, Art. 32 DSGVO / ASVS L2 V2.7).
 *
 * - Inhaber:innen und Plattform-Admins: immer Pflicht.
 * - Alle anderen Rollen: Pflicht, wenn die Praxis es unter Einstellungen → Sicherheit festlegt
 *   (`organizations.settings.security.require2faAllRoles`).
 *
 * Ohne aktive 2FA ist die Anmeldung trotzdem möglich (Schonfrist), die Sitzung erhält aber keinen
 * Praxis-Zugriff: getAuth() liefert null, Seiten leiten auf /login/2fa-einrichten (dort auch Abmelden).
 */
import type { Role } from "./permissions";

export const TWO_FACTOR_SETUP_PATH = "/login/2fa-einrichten";

export type SecuritySettings = { require2faAllRoles: boolean };

export function securitySettingsOf(settings: Record<string, unknown> | null | undefined): SecuritySettings {
  const sec = (settings?.security ?? {}) as Record<string, unknown>;
  return { require2faAllRoles: sec.require2faAllRoles === true };
}

export function twoFactorRequired(p: { role: Role | null; isPlatformAdmin: boolean; orgSettings?: Record<string, unknown> | null }): boolean {
  if (p.isPlatformAdmin) return true;
  if (p.role === "owner") return true;
  if (p.role === null) return false;
  return securitySettingsOf(p.orgSettings).require2faAllRoles;
}

/** true = Sitzung darf (noch) nicht auf Praxisdaten zugreifen, weil die Pflicht-2FA fehlt. */
export function twoFactorPending(p: { totpEnabled: boolean; role: Role | null; isPlatformAdmin: boolean; orgSettings?: Record<string, unknown> | null }): boolean {
  return !p.totpEnabled && twoFactorRequired(p);
}
