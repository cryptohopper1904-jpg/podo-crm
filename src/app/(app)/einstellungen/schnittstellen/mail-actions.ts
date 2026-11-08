"use server";

import { revalidatePath } from "next/cache";
import { MailNotConfiguredError, MailSendError } from "@/integrations/mail/mail";
import { requireAuth } from "@/lib/auth/session";
import { sendTestMail } from "@/server/mail";

export type MailTestState = { error?: string; ok?: string } | undefined;

/** „Testmail senden“ – Fehler werden mit sicherer Meldung angezeigt (nie mit Passwort/Server-Antwort). */
export async function sendTestMailAction(_: MailTestState, form: FormData): Promise<MailTestState> {
  const auth = await requireAuth("integrations.manage");
  try {
    const r = await sendTestMail(auth, String(form.get("to") ?? ""));
    revalidatePath("/einstellungen/schnittstellen");
    return { ok: r.mock ? `Testmodus: Mail an ${r.to} wurde nicht wirklich versendet.` : `Testmail an ${r.to} versendet. Bitte Posteingang (und Spam-Ordner) prüfen.` };
  } catch (e) {
    revalidatePath("/einstellungen/schnittstellen");
    if (e instanceof MailSendError || e instanceof MailNotConfiguredError) return { error: e.message };
    return { error: "E-Mail-Versand fehlgeschlagen (Details im Synchronisationsprotokoll)." };
  }
}
