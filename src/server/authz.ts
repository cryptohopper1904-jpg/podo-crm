import type { AuthContext } from "@/lib/auth/session";
import type { Permission } from "@/lib/auth/permissions";

export class ForbiddenError extends Error {
  constructor(permission: Permission) {
    super(`Keine Berechtigung (${permission}).`);
    this.name = "ForbiddenError";
  }
}

/**
 * Defense in Depth: Fachfunktionen prüfen die Berechtigung selbst – unabhängig davon,
 * ob die aufrufende Seite/Route schon requireAuth(...) verwendet.
 */
export function assertCan(auth: Pick<AuthContext, "can">, ...permissions: Permission[]): void {
  for (const p of permissions) if (!auth.can(p)) throw new ForbiddenError(p);
}
