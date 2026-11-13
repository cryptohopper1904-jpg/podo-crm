import Link from "next/link";
import { eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Field, Input, Select, Table } from "@/components/ui";
import { db } from "@/db";
import { memberships, users } from "@/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { hasOwnCalendar, ROLE_LABELS, ROLES, permissionsFor } from "@/lib/auth/permissions";
import { SEAT_FREE_NOTE, seatCounts, seatLimit } from "@/lib/plans";
import { usedSeats } from "@/server/billing";
import { inviteMemberAction, updateMemberAction } from "../actions";

export const metadata = { title: "Team" };

export default async function TeamSettings({ searchParams }: PageProps<"/einstellungen/team">) {
  const auth = await requireAuth("users.manage");
  const { plaetze } = await searchParams;
  const used = await usedSeats(auth.organization.id);
  const limit = seatLimit(auth.billing);
  const team = await db
    .select({ m: memberships, name: users.name, email: users.email, totp: users.totpEnabled, last: users.lastLoginAt })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.organizationId, auth.organization.id));
  return (
    <div className="flex flex-col gap-6">
      <div className={`flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 text-sm ${plaetze === "voll" || used >= limit ? "bg-warn-soft text-warn-soft-text" : "bg-surface-2"}`}>
        <span>
          {plaetze === "voll" ? "Änderung nicht gespeichert: Alle Plätze sind belegt. " : null}
          Plätze belegt: <strong className="tabular-nums">{used} / {Number.isFinite(limit) ? limit : "∞"}</strong> {auth.billing.plan === "free" ? "(kostenloser Tarif: 1 Person, Steuerberatung zählt nicht)" : `– Inhaber:in, Podolog:innen und Azubis. ${SEAT_FREE_NOTE}`}
        </span>
        {auth.role === "owner" && used >= limit ? <Link href="/einstellungen/abo" className="font-semibold text-primary">Weitere Plätze buchen / Tarif wechseln →</Link> : null}
      </div>
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
            <Field label="Rolle" hint={auth.billing.plan === "free" ? undefined : "Empfang und Steuerberatung belegen keinen Platz; nur Inhaber:in und Podolog:in haben eine eigene Kalenderspalte"}><Select name="role" defaultValue="therapist">{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</Select></Field>
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
              <p className="text-xs text-muted">{`${hasOwnCalendar(r) ? "eigener Kalender" : "kein eigener Kalender"}, ${seatCounts(r, auth.billing.plan) ? "belegt einen Platz" : "kein Platz"}`}</p>
              <p className="mt-1 text-muted">{permissionsFor(r).join(", ")}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
