"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { getSession, requestMeta } from "@/lib/auth/session";
import { clientKey } from "@/lib/rate-limit";
import { platformSendPasswordReset, requestPasswordReset, resetPassword } from "@/server/password-reset";

export type ResetState = { error?: string; ok?: string } | undefined;

/** Mindestdauer der Antwort – mit und ohne Konto gleich (keine Konten-Erkennung über die Laufzeit). */
const MIN_RESPONSE_MS = 600;

/** Öffentlich: „Passwort vergessen“ – immer dieselbe Antwort, Versand nach der Antwort. */
export async function requestPasswordResetAction(_: ResetState, form: FormData): Promise<ResetState> {
  const started = Date.now();
  const meta = await requestMeta();
  const r = await requestPasswordReset(String(form.get("email") ?? ""), { ip: meta.ip, key: clientKey(meta) });
  if (r.send) after(() => r.send!().then(() => undefined, () => undefined));
  const wait = MIN_RESPONSE_MS - (Date.now() - started);
  if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  return { ok: r.message };
}

/** Öffentlich (Token aus der E-Mail): neues Passwort setzen. */
export async function resetPasswordAction(_: ResetState, form: FormData): Promise<ResetState> {
  const token = String(form.get("token") ?? "");
  const next = String(form.get("password") ?? "");
  if (next !== String(form.get("confirm") ?? "")) return { error: "Die beiden Passwörter stimmen nicht überein." };
  const r = await resetPassword(token, next);
  if (!r.ok) return { error: r.error };
  redirect("/login?passwort=neu");
}

/**
 * Plattform-Konsole: Link zum Zurücksetzen an ein Konto schicken (Plattform-Admin mit 2FA, bestätigte Sitzung).
 * Das Passwort sieht dabei niemand. Formularfeld `userId`.
 */
export async function platformSendPasswordResetAction(_: ResetState, form: FormData): Promise<ResetState> {
  const row = await getSession();
  if (!row || !row.session.verified || !row.user.isPlatformAdmin || !row.user.totpEnabled) return { error: "Nur Plattform-Admins mit aktiver Zwei-Faktor-Anmeldung." };
  const userId = z.uuid().safeParse(form.get("userId"));
  if (!userId.success) return { error: "Konto nicht gefunden." };
  try {
    const r = await platformSendPasswordReset(row.user, userId.data);
    return r.sent ? { ok: "Link zum Zurücksetzen wurde per E-Mail verschickt (30 Minuten gültig)." } : { error: "E-Mail konnte nicht verschickt werden (SMTP_URL prüfen)." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Fehler" };
  }
}
