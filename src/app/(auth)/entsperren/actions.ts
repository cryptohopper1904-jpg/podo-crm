"use server";

import { redirect } from "next/navigation";
import { and, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { patientLinks, sessions } from "@/db/schema";
import { audit } from "@/lib/audit";
import { verifyPassword } from "@/lib/auth/password";
import { destroySession, getSessionIncludingLocked, HANDOVER_MAX_FAILURES, isSafeReturnPath } from "@/lib/auth/session";

export type UnlockState = { error?: string } | undefined;

/**
 * Übergabe-Modus beenden: PIN (falls eingerichtet) oder Passwort der angemeldeten Person.
 * Nach HANDOVER_MAX_FAILURES Fehlversuchen wird die Sitzung beendet (dann Anmeldung mit Passwort + 2FA).
 */
export async function unlockAction(_: UnlockState, form: FormData): Promise<UnlockState> {
  const row = await getSessionIncludingLocked();
  if (!row) redirect("/login");
  if (!row.session.lockedAt) redirect("/heute");
  const input = String(form.get("secret") ?? "").slice(0, 200);
  if (!input) return { error: "Bitte PIN oder Passwort eingeben." };
  // Versuch VOR der Prüfung atomar reservieren: auch parallel höchstens HANDOVER_MAX_FAILURES Prüfungen je Sperre
  const [slot] = await db
    .update(sessions)
    .set({ unlockFailures: sql`${sessions.unlockFailures} + 1` })
    .where(and(eq(sessions.id, row.session.id), isNotNull(sessions.lockedAt), lt(sessions.unlockFailures, HANDOVER_MAX_FAILURES)))
    .returning({ n: sessions.unlockFailures });
  if (!slot) {
    // entweder schon entsperrt (paralleler Erfolg) oder alle Versuche verbraucht
    const [still] = await db.select({ lockedAt: sessions.lockedAt }).from(sessions).where(eq(sessions.id, row.session.id));
    if (still && !still.lockedAt) redirect("/heute");
    await audit({ organizationId: row.session.organizationId, userId: row.user.id, action: "handover.locked_out" });
    await destroySession();
    redirect("/login?entsperren=gesperrt");
  }
  const pinOk = !!row.user.unlockPinHash && /^\d{4,8}$/.test(input) && (await verifyPassword(row.user.unlockPinHash, input));
  const ok = pinOk || (await verifyPassword(row.user.passwordHash, input));
  if (!ok) {
    if (slot.n >= HANDOVER_MAX_FAILURES) {
      await audit({ organizationId: row.session.organizationId, userId: row.user.id, action: "handover.locked_out" });
      await destroySession();
      redirect("/login?entsperren=gesperrt");
    }
    return { error: `Falsche Eingabe. Noch ${HANDOVER_MAX_FAILURES - slot.n} Versuch(e), danach ist eine neue Anmeldung nötig.` };
  }
  const [done] = await db
    .update(sessions)
    .set({ lockedAt: null, lockReturn: null, unlockFailures: 0 })
    .where(and(eq(sessions.id, row.session.id), isNotNull(sessions.lockedAt)))
    .returning({ id: sessions.id });
  if (!done) redirect("/heute");
  // noch nicht ausgefüllte Übergabe-Links dieser Person widerrufen (Token steht sonst im Browserverlauf des Geräts)
  await db
    .update(patientLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(patientLinks.createdBy, row.user.id), eq(patientLinks.purpose, "anamnesis"), isNull(patientLinks.usedAt), isNull(patientLinks.revokedAt), gte(patientLinks.createdAt, new Date(row.session.lockedAt.getTime() - 60_000))));
  await audit({ organizationId: row.session.organizationId, userId: row.user.id, action: "handover.unlocked", meta: { via: pinOk ? "pin" : "password" } });
  const back = row.session.lockReturn && isSafeReturnPath(row.session.lockReturn) ? row.session.lockReturn : "/heute";
  redirect(back);
}
