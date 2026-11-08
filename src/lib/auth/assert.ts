import type { Permission } from "./permissions";

export class ForbiddenError extends Error {
  constructor(public readonly permission: Permission) {
    super("Keine Berechtigung für diese Aktion.");
    this.name = "ForbiddenError";
  }
}

/**
 * Defense in Depth: Fachfunktionen prüfen das nötige Recht selbst – auch wenn die aufrufende
 * Route/Server Action bereits requireAuth(...) verwendet.
 */
export function assertCan(auth: { can: (p: Permission) => boolean }, permission: Permission): void {
  if (!auth.can(permission)) throw new ForbiddenError(permission);
}
