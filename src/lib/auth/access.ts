/**
 * Effektive Rechte unter Berücksichtigung von
 *  - Nur-Lesen-Modus der Praxis (Abo abgelaufen/überfällig, siehe src/lib/plans.ts) und
 *  - Support-Zugriff (Break-Glass, PLAN.md 14.4): Plattform-Betreiber mit zeitlich begrenzter Freigabe.
 *
 * Reine Funktionen (ohne DB/Request), damit sie direkt testbar sind. Die Verdrahtung passiert in
 * src/lib/auth/session.ts (getAuth/requireAuth).
 */
import { can, type Permission, type Role } from "./permissions";

export const isReadPermission = (p: Permission) => p.endsWith(".read");

/**
 * Support mit Scope „write“ darf zusätzlich nur Konfiguration korrigieren – nie Team/Rechte,
 * nie Patientendaten oder Dokumentation ändern.
 */
export const SUPPORT_WRITE_PERMISSIONS: readonly Permission[] = ["settings.manage", "integrations.manage"];

export type SupportScope = "read" | "write";
export type SupportContext = { grantId: string; scope: SupportScope; expiresAt: Date };

export type AccessState = {
  role: Role;
  /** Praxis im Nur-Lesen-Modus (Abo) */
  readOnly: boolean;
  /** Aktuelle Anfrage verändert Daten (POST/Server Action/Route-Handler außer GET/HEAD) */
  mutating: boolean;
  support: SupportContext | null;
};

export function effectiveCan(s: AccessState, p: Permission): boolean {
  if (s.support) {
    if (isReadPermission(p)) return true;
    if (s.support.scope !== "write" || !SUPPORT_WRITE_PERMISSIONS.includes(p)) return false;
    if (s.readOnly && s.mutating) return false;
    return true;
  }
  if (!can(s.role, p)) return false;
  if (s.readOnly && s.mutating && !isReadPermission(p)) return false;
  return true;
}

/**
 * Darf eine schreibende Anfrage, die keine konkrete Berechtigung prüft (requireAuth() ohne Recht), passieren?
 * Im Support-Modus nie (auch nicht mit Scope „write“).
 */
export function mutationAllowedWithoutPermission(s: Pick<AccessState, "support" | "mutating">): boolean {
  if (!s.mutating) return true;
  // Support schreibt nie „nebenbei“ – auch mit Scope „write“ nur über die explizit erlaubten Rechte.
  return !s.support;
}

/**
 * Datei-Downloads und Exporte (Gesamt-Review H5). Support (Break-Glass) darf Daten in der Praxis ansehen,
 * aber nichts massenhaft oder als Datei mitnehmen (§ 203 Abs. 3 StGB: Offenbarung nur, soweit für die
 * Fehlersuche erforderlich). Erlaubt bleiben nur einzelne Belege, deren Darstellung Support prüfen muss
 * (Rechnungs-PDF, Z-Bon) – jeder Abruf landet als support.view im Audit-Log der Praxis.
 */
export const DOWNLOAD_KINDS = [
  "practice_export",
  "patient_export",
  "patient_list_export",
  "media",
  "billing_batch_export",
  "cash_export",
  "invoice_pdf",
  "z_bon_pdf",
] as const;
export type DownloadKind = (typeof DOWNLOAD_KINDS)[number];

export const SUPPORT_DOWNLOAD_DENIED = "Im Support-Modus sind Exporte und Datei-Downloads gesperrt.";

const SUPPORT_DOWNLOADS: readonly DownloadKind[] = ["invoice_pdf", "z_bon_pdf"];

export function downloadAllowed(s: Pick<AccessState, "support">, kind: DownloadKind): boolean {
  return !s.support || SUPPORT_DOWNLOADS.includes(kind);
}

export type GrantRow = {
  id: string;
  granteeUserId: string | null;
  scope: string;
  expiresAt: Date;
  revokedAt: Date | null;
};

export function isGrantActive(g: GrantRow, userId: string, now: Date = new Date()): boolean {
  if (g.revokedAt) return false;
  if (g.expiresAt.getTime() <= now.getTime()) return false;
  return g.granteeUserId === null || g.granteeUserId === userId;
}

/** Wählt die aktive Freigabe für userId (bei mehreren: die am längsten gültige; „read“ hat Vorrang vor nichts). */
export function pickActiveGrant(grants: GrantRow[], userId: string, now: Date = new Date()): SupportContext | null {
  const active = grants.filter((g) => isGrantActive(g, userId, now)).sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime());
  const g = active[0];
  if (!g) return null;
  return { grantId: g.id, scope: g.scope === "write" ? "write" : "read", expiresAt: g.expiresAt };
}

export const SUPPORT_MIN_HOURS = 1;
export const SUPPORT_MAX_HOURS = 72;
