import { eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Field, Input, Select, Table } from "@/components/ui";
import { db } from "@/db";
import { memberships, users } from "@/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { ROLE_LABELS, ROLES, permissionsFor } from "@/lib/auth/permissions";
import { inviteMemberAction, updateMemberAction } from "../actions";

export const metadata = { title: "Team" };

export default async function TeamSettings() {
  const auth = await requireAuth("users.manage");
  const team = await db
    .select({ m: memberships, name: users.name, email: users.email, totp: users.totpEnabled, last: users.lastLoginAt })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.organizationId, auth.organization.id));
  return (
    <div className="flex flex-col gap-6">
      <Table>
        <thead><tr><th>Name</th><th>Rolle</th><th>2FA</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {team.map((t) => (
            <tr key={t.m.id}>
              <td><p className="font-semibold">{t.name}</p><p className="text-sm text-muted">{t.email}</p></td>
              <td>
                {t.m.userId === auth.user.id ? ROLE_LABELS[t.m.role] : (
                  <form action={updateMemberAction} className="flex gap-2">
                    <input type="hidden" name="id" value={t.m.id} />
                    <label className="sr-only" htmlFor={`role-${t.m.id}`}>Rolle</label>
                    <select id={`role-${t.m.id}`} name="role" defaultValue={t.m.role} className="h-10 rounded-lg border border-border bg-surface px-2 text-sm">
                      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                    <button className="rounded-lg px-2 text-sm font-semibold text-primary">ändern</button>
                  </form>
                )}
              </td>
              <td>{t.totp ? <Badge tone="primary">aktiv</Badge> : <Badge tone="warn">fehlt</Badge>}</td>
              <td>{t.m.active ? <Badge tone="primary">aktiv</Badge> : <Badge>gesperrt</Badge>}</td>
              <td>
                {t.m.userId !== auth.user.id ? (
                  <form action={updateMemberAction}>
                    <input type="hidden" name="id" value={t.m.id} />
                    <input type="hidden" name="active" value={t.m.active ? "0" : "1"} />
                    <button className="text-sm font-semibold text-primary">{t.m.active ? "sperren" : "entsperren"}</button>
                  </form>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Card>
        <CardTitle>Person hinzufügen</CardTitle>
        <ActionForm action={inviteMemberAction} submit="Hinzufügen">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Name"><Input name="name" required /></Field>
            <Field label="E-Mail"><Input name="email" type="email" required /></Field>
            <Field label="Rolle"><Select name="role" defaultValue="therapist">{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</Select></Field>
            <Field label="Startpasswort" hint="min. 12 Zeichen"><Input name="password" type="text" minLength={12} autoComplete="off" /></Field>
          </div>
        </ActionForm>
      </Card>
      <Card>
        <CardTitle>Was darf welche Rolle?</CardTitle>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ROLES.map((r) => (
            <div key={r} className="rounded-xl bg-surface-2 p-3 text-sm">
              <p className="font-semibold">{ROLE_LABELS[r]}</p>
              <p className="mt-1 text-muted">{permissionsFor(r).join(", ")}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
