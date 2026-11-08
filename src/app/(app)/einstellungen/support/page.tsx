import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Checkbox, Empty, Field, Select, Table, Textarea } from "@/components/ui";
import { denyAccess, requireAuth } from "@/lib/auth/session";
import { dateTimeDe } from "@/lib/format";
import { listSupportGrants } from "@/server/support";
import { grantSupportAction, revokeSupportAction } from "./actions";

export const metadata = { title: "Support-Zugriff" };

export default async function SupportSettings() {
  const auth = await requireAuth("users.manage", { allowReadOnly: true });
  if (auth.role !== "owner" || auth.support) denyAccess(auth, "users.manage");
  const grants = await listSupportGrants(auth);
  const now = new Date();
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardTitle>Support-Zugriff freigeben</CardTitle>
        <p className="mb-4 text-sm text-muted">
          Der PodoCRM-Support hat <strong>keinen</strong> Zugriff auf eure Praxisdaten. Nur wenn du hier eine zeitlich begrenzte Freigabe erteilst,
          kann sich der Support (mit Zwei-Faktor-Anmeldung) die Praxis ansehen – standardmäßig nur lesend. Jede aufgerufene Seite wird im{" "}
          <Link href="/einstellungen/protokoll" className="font-semibold text-primary">Zugriffsprotokoll</Link> festgehalten. Der Zugriff endet automatisch
          oder sofort, wenn du ihn widerrufst.
        </p>
        <ActionForm action={grantSupportAction} submit="Freigeben">
          <Field label="Grund" hint="z. B. Ticketnummer oder Beschreibung des Problems">
            <Textarea name="reason" required minLength={5} maxLength={500} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Dauer" hint="1 bis 72 Stunden">
              <Select name="hours" defaultValue="4">
                {[1, 2, 4, 8, 24, 48, 72].map((h) => <option key={h} value={h}>{h} {h === 1 ? "Stunde" : "Stunden"}</option>)}
              </Select>
            </Field>
            <Field label="Umfang">
              <Select name="scope" defaultValue="read">
                <option value="read">Nur lesen (empfohlen)</option>
                <option value="write">Lesen + Einstellungen/Schnittstellen/Import korrigieren</option>
              </Select>
            </Field>
          </div>
          <Checkbox name="confirm" required label="Ich gebe den Support-Zugriff im Rahmen des Auftragsverarbeitungsvertrags (AVV) frei." />
        </ActionForm>
      </Card>
      <Card>
        <CardTitle>Freigaben</CardTitle>
        {grants.length === 0 ? (
          <Empty title="Noch keine Freigaben" />
        ) : (
          <Table>
            <thead><tr><th>Erteilt</th><th>Grund</th><th>Umfang</th><th>Gültig bis</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {grants.map(({ g, grantedByName }) => {
                const active = !g.revokedAt && g.expiresAt > now;
                return (
                  <tr key={g.id}>
                    <td><p>{dateTimeDe(g.createdAt)}</p><p className="text-sm text-muted">{grantedByName}</p></td>
                    <td className="max-w-xs break-words">{g.reason}</td>
                    <td>{g.scope === "write" ? "Lesen + Konfiguration" : "Nur lesen"}</td>
                    <td>{dateTimeDe(g.expiresAt)}</td>
                    <td>{g.revokedAt ? <Badge>widerrufen</Badge> : active ? <Badge tone="accent">aktiv</Badge> : <Badge>abgelaufen</Badge>}</td>
                    <td>
                      {active ? (
                        <form action={revokeSupportAction}>
                          <input type="hidden" name="id" value={g.id} />
                          <button className="text-sm font-semibold text-danger">widerrufen</button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
