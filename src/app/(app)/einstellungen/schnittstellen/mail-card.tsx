import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Field, Input } from "@/components/ui";
import type { AuthContext } from "@/lib/auth/session";
import { mailOverview } from "@/server/mail";
import { sendTestMailAction } from "./mail-actions";

/** E-Mail-Versand: aktuelle Versandart, Zustellbarkeit (SPF/DKIM/DMARC), Testmail. */
export async function MailCard({ auth }: { auth: AuthContext }) {
  const m = await mailOverview(auth);
  const tone = m.kind === "smtp" ? "primary" : m.kind === "mock" ? "info" : "accent";
  const label = m.kind === "smtp" ? (m.source === "org" ? "eigener SMTP" : "Plattform-SMTP") : m.kind === "mock" ? "Testmodus" : "nicht eingerichtet";
  return (
    <Card>
      <CardTitle action={<Badge tone={tone}>{label}</Badge>}>E-Mail-Versand</CardTitle>
      <p className={`mb-3 text-sm ${m.kind === "unconfigured" ? "text-danger" : ""}`}>{m.description}</p>
      <div className="mb-4 rounded-xl bg-surface-2 p-4 text-sm">
        <p className="font-semibold">Zustellbarkeit: SPF, DKIM, DMARC</p>
        <ul className="mt-1 list-disc pl-5 text-muted">
          <li><strong>SPF:</strong> Im DNS der Absenderdomain muss der SMTP-Server erlaubt sein, z. B. <code>v=spf1 include:&lt;Mailanbieter&gt; ~all</code> (Wert liefert dein Mailanbieter).</li>
          <li><strong>DKIM:</strong> Beim Mailanbieter die DKIM-Signatur aktivieren und den angezeigten TXT-/CNAME-Eintrag im DNS hinterlegen.</li>
          <li><strong>DMARC:</strong> mindestens <code>v=DMARC1; p=none; rua=mailto:…</code> unter <code>_dmarc.&lt;domain&gt;</code>, später <code>p=quarantine</code>.</li>
          <li>Ohne diese Einträge landen Rechnungen und Erinnerungen oft im Spam. Beim Plattform-Server ist die Absenderdomain bereits eingerichtet; Antworten gehen an die E-Mail-Adresse der Praxis.</li>
        </ul>
        <p className="mt-2 text-[13px] text-muted">Höchstens {m.ratePerHour} E-Mails pro Stunde je Praxis. Verbindung nur verschlüsselt (TLS ab Version 1.2). Das Passwort wird verschlüsselt gespeichert und nie angezeigt.</p>
      </div>
      <ActionForm action={sendTestMailAction} submit="Testmail senden" className="flex flex-col gap-3">
        <Field label="Empfänger" hint="Leer lassen: an deine Anmeldeadresse">
          <Input name="to" type="email" autoComplete="email" placeholder={auth.user.email} />
        </Field>
      </ActionForm>
    </Card>
  );
}
