import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Checkbox, Empty, Field, Select, Table, Textarea } from "@/components/ui";
import { denyAccess, requireAuth } from "@/lib/auth/session";
import { dateTimeDe } from "@/lib/format";
import { listSupportAdmins, listSupportGrants } from "@/server/support";
import { grantSupportAction, revokeSupportAction } from "./actions";

export const metadata = { title: "Support-Zugriff" };

export default async function SupportSettings() {
  const auth = await requireAuth("users.manage", { allowReadOnly: true });
  if (auth.role !== "owner" || auth.support) denyAccess(auth, "users.manage");
  const [grants, admins] = await Promise.all([listSupportGrants(auth), listSupportAdmins()]);
  const now = new Date();
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardTitle>Support-Zugriff freigeben</CardTitle>
        <p className="mb-4 text-sm text-muted">
          Der PodoHero-Support hat <strong>keinen</strong> Zugriff auf eure Praxisdaten. Nur wenn du hier eine zeitlich begrenzte Freigabe erteilst,
          kann sich die ausgewählte Person beim Support (mit Zwei-Faktor-Anmeldung) die Praxis ansehen – standardmäßig nur lesend. Jede aufgerufene Seite wird im{" "}
          <Link href="/einstellungen/protokoll" className="font-semibold text-primary">Zugriffsprotokoll</Link> festgehalten. Der Zugriff endet automatisch
          oder sofort, wenn du ihn widerrufst.
        </p>
        {admins.length === 0 ? (
          <p className="text-sm text-muted">Derzeit ist niemand beim Support mit Zwei-Faktor-Anmeldung eingerichtet – eine Freigabe ist nicht möglich.</p>
        ) : (
        <ActionForm action={grantSupportAction} submit="Freigeben">
          <Field label="Person beim Support" hint="Nur diese Person darf zugreifen.">
            <Select name="granteeUserId" required defaultValue={admins.length === 1 ? admins[0].id : ""}>
              {admins.length > 1 ? <option value="" disabled>Bitte auswählen …</option> : null}
              {admins.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.email})</option>)}
            </Select>
          </Field>
          <Field label="Grund" hint="z. B. Ticketnummer oder Beschreibung des Problems">
            <Textarea name="reason" required minLength={5} maxLength={500} />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Dauer" hint="1 bis 72 Stunden">
              <Select name="hours" defaultValue="4">
                {[1, 2, 4, 8, 24, 48, 72].map((h) => <option key={h} value={h}>{h} {h === 1 ? "Stunde" : "Stunden"}</option>)}
              </Select>
            </Field>
            <Field label="Umfang">
              <Select name="scope" defaultValue="read">
                <option value="read">Nur lesen (empfohlen)</option>
                <option value="write">Lesen + Einstellungen/Schnittstellen korrigieren</option>
              </Select>
            </Field>
          </div>
          <Checkbox name="confirm" required label="Ich gebe den Support-Zugriff im Rahmen des Auftragsverarbeitungsvertrags (AVV) frei." />
        </ActionForm>
        )}
      </Card>
      <Card>
        <CardTitle>Freigaben</CardTitle>
        {grants.length === 0 ? (
          <Empty title="Noch keine Freigaben" />
        ) : (
          <Table label="Freigaben">
            <thead><tr><th>Erteilt</th><th>Für</th><th>Grund</th><th>Umfang</th><th>Gültig bis</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {grants.map(({ g, grantedByName, granteeName, granteeEmail }) => {
                const active = !g.revokedAt && g.expiresAt > now;
                return (
                  <tr key={g.id}>
                    <td><p>{dateTimeDe(g.createdAt)}</p><p className="text-sm text-muted">{grantedByName}</p></td>
                    <td>
                      {g.granteeUserId ? (
                        <><p>{granteeName}</p><p className="text-sm text-muted">{granteeEmail}</p></>
                      ) : (
                        <Badge tone="warn">alle Betreiber-Admins</Badge>
                      )}
                      {!g.granteeUserId && active ? <p className="mt-1 text-[13px] text-muted">Ältere Freigabe ohne Person – bitte widerrufen und personengebunden neu erteilen.</p> : null}
                    </td>
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
