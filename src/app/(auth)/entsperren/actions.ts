"use server";

import { redirect } from "next/navigation";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, sessions } from "@/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { destroySession, getSession, HANDOVER_MAX_FAILURES } from "@/lib/auth/session";

export type UnlockState = { error?: string } | undefined;

/**
 * Übergabe-Modus beenden: PIN (falls eingerichtet) oder Passwort der angemeldeten Person.
 * Nach HANDOVER_MAX_FAILURES Fehlversuchen wird die Sitzung beendet (dann Anmeldung mit Passwort + 2FA).
 */
export async function unlockAction(_: UnlockState, form: FormData): Promise<UnlockState> {
  const row = await getSession();
  if (!row || !row.session.lockedAt) redirect("/login");
  const input = String(form.get("secret") ?? "").slice(0, 200);
  if (!input) return { error: "Bitte PIN oder Passwort eingeben." };
  const pinOk = !!row.user.unlockPinHash && /^\d{4,8}$/.test(input) && (await verifyPassword(row.user.unlockPinHash, input));
  const ok = pinOk || (await verifyPassword(row.user.passwordHash, input));
  if (!ok) {
    const [r] = await db
      .update(sessions)
      .set({ unlockFailures: sql`${sessions.unlockFailures} + 1` })
      .where(and(eq(sessions.id, row.session.id), isNotNull(sessions.lockedAt)))
      .returning({ n: sessions.unlockFailures });
    if (!r || r.n >= HANDOVER_MAX_FAILURES) {
      await db.insert(auditLog).values({ organizationId: row.session.organizationId, userId: row.user.id, action: "handover.locked_out", meta: { failures: r?.n ?? null } });
      await destroySession();
      redirect("/login?entsperren=gesperrt");
    }
    return { error: `Falsche Eingabe. Noch ${HANDOVER_MAX_FAILURES - r.n} Versuch(e), danach ist eine neue Anmeldung nötig.` };
  }
  const [done] = await db
    .update(sessions)
    .set({ lockedAt: null, lockReturn: null, unlockFailures: 0 })
    .where(and(eq(sessions.id, row.session.id), isNotNull(sessions.lockedAt)))
    .returning({ id: sessions.id });
  if (!done) redirect("/login");
  await db.insert(auditLog).values({ organizationId: row.session.organizationId, userId: row.user.id, action: "handover.unlocked", meta: { via: pinOk ? "pin" : "password" } });
  const back = row.session.lockReturn && /^\/(?!\/)/.test(row.session.lockReturn) ? row.session.lockReturn : "/heute";
  redirect(back);
}
