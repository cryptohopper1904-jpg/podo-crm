import { eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Checkbox, Empty, Field, Input, Table } from "@/components/ui";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { dateTimeDe } from "@/lib/format";
import { CHANNEL_LABEL, parseReminderSettings, REMINDER_KIND_LABEL, REMINDER_STATUS_LABEL } from "@/lib/reminders";
import { reminderLogFor } from "@/server/reminders";
import { saveReminderSettingsAction } from "./actions";
import { RunNowButton } from "./run-now";

export const metadata = { title: "Erinnerungen" };

const TONE: Record<string, "primary" | "warn" | "neutral" | "accent"> = { sent: "primary", pending: "warn", skipped: "neutral", failed: "accent" };

export default async function ReminderSettingsPage() {
  const auth = await requireAuth("settings.manage");
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, auth.organization.id));
  const s = parseReminderSettings((o?.settings as Record<string, unknown> | undefined)?.reminders);
  const log = await reminderLogFor(auth.organization.id, 50);
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "reminders.log_read", meta: { n: log.length } });
  const cronReady = !!process.env.CRON_SECRET;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <h2 className="mb-1 font-display text-lg font-semibold">Automatische Erinnerungen</h2>
        <p className="mb-4 text-sm text-muted">
          Versand nur an Personen mit passender Einwilligung (Terminerinnerung per E-Mail/SMS bzw. WhatsApp) – bevorzugter Kanal zuerst.
          Die Texte enthalten keine Leistungs- oder Gesundheitsangaben. Jede Nachricht wird höchstens einmal versendet.
        </p>
        <ActionForm action={saveReminderSettingsAction}>
          <Checkbox name="r24" defaultChecked={s.r24} label="Terminerinnerung ca. 24 Stunden vorher (geplante/bestätigte Termine)" />
          <Checkbox name="recall" defaultChecked={s.recall} label="Rückholung bei überfälligen Kund:innen (höchstens alle 30 Tage)" />
          <Checkbox name="braceCheck" defaultChecked={s.braceCheck} label="Erinnerung bei laufender Spangenbehandlung ohne Termin seit über 4 Wochen" />
          <Field label="Standard-Intervall für die Rückholung (Wochen)" hint="Gilt, wenn in der Akte kein eigenes Intervall steht. Überfällig = Intervall + 2 Wochen." className="max-w-xs">
            <Input type="number" name="recallAfterWeeks" min={2} max={104} defaultValue={s.recallAfterWeeks} />
          </Field>
        </ActionForm>
      </Card>

      <Card>
        <h2 className="mb-1 font-display text-lg font-semibold">Zeitplan</h2>
        <p className="mb-3 text-sm text-muted">
          {cronReady
            ? "Der Erinnerungsdienst läuft alle 15 Minuten (Cron-Container bzw. Vercel Cron)."
            : "CRON_SECRET ist nicht gesetzt – der automatische Lauf ist deaktiviert. Siehe docs/BETRIEB.md."}
        </p>
        <RunNowButton />
      </Card>

      <section>
        <h2 className="mb-3 font-display text-lg font-semibold">Letzte 50 Einträge</h2>
        {log.length === 0 ? (
          <Empty title="Noch keine Erinnerungen versendet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Zeit</th>
                <th>Art</th>
                <th>Person</th>
                <th>Kanal</th>
                <th>Status</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {log.map(({ log: l, firstName, lastName }) => (
                <tr key={l.id}>
                  <td className="tabular-nums">{dateTimeDe(l.at)}</td>
                  <td>{REMINDER_KIND_LABEL[l.kind] ?? l.kind}</td>
                  <td>{lastName ? [firstName, lastName].filter(Boolean).join(" ") : "–"}</td>
                  <td>{CHANNEL_LABEL[l.channel] ?? l.channel}</td>
                  <td><Badge tone={TONE[l.status] ?? "neutral"}>{REMINDER_STATUS_LABEL[l.status] ?? l.status}</Badge></td>
                  <td className="text-sm text-muted">{l.detail ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
