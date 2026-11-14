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
import { TherapistColorForm } from "@/components/therapist-color-fieldset";
import { assignTherapistColors, byJoined, dotStyle } from "@/lib/therapist-colors";
import { therapists } from "@/server/appointments";

export const metadata = { title: "Team" };

/** Rolle ändern (Tabelle und Handy-Karte) */
function RoleForm({ id, role, idPrefix = "" }: { id: string; role: (typeof ROLES)[number]; idPrefix?: string }) {
  return (
    <form action={updateMemberAction} className="flex flex-wrap gap-2">
      <input type="hidden" name="id" value={id} />
      <label className="sr-only" htmlFor={`${idPrefix}role-${id}`}>Rolle</label>
      <select id={`${idPrefix}role-${id}`} name="role" defaultValue={role} className="h-11 min-w-0 rounded-xl border border-border bg-surface px-3 text-[15px]">
        {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
      </select>
      <button className="h-11 rounded-xl px-3 text-sm font-semibold text-primary hover:bg-surface-2">ändern</button>
    </form>
  );
}

/** Zugang sperren/entsperren */
function LockForm({ id, active }: { id: string; active: boolean }) {
  return (
    <form action={updateMemberAction}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="active" value={active ? "0" : "1"} />
      <button className="h-11 rounded-xl px-3 text-sm font-semibold text-primary hover:bg-surface-2">{active ? "sperren" : "entsperren"}</button>
    </form>
  );
}

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
  const calendarTeam = byJoined(await therapists(auth));
  const colors = assignTherapistColors(calendarTeam);
  return (
    <div className="flex flex-col gap-6">
      <div className={`flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 text-sm ${plaetze === "voll" || used >= limit ? "bg-warn-soft text-warn-soft-text" : "bg-surface-2"}`}>
        <span>
          {plaetze === "voll" ? "Änderung nicht gespeichert: Alle Plätze sind belegt. " : null}
          Plätze belegt: <strong className="tabular-nums">{used} / {Number.isFinite(limit) ? limit : "∞"}</strong> {auth.billing.plan === "free" ? "(kostenloser Tarif: 1 Person, Steuerberatung zählt nicht)" : `– Inhaber:in, Podolog:innen und Azubis. ${SEAT_FREE_NOTE}`}
        </span>
        {auth.role === "owner" && used >= limit ? <Link href="/einstellungen/abo" className="inline-flex min-h-11 items-center font-semibold text-warn-soft-text underline underline-offset-2">Weitere Plätze buchen / Tarif wechseln →</Link> : null}
      </div>
      {/* Handy: Karte je Person (die Tabelle wäre doppelt so breit wie der Bildschirm) */}
      <ul className="flex flex-col gap-3 md:hidden" aria-label="Team">
        {team.map((t) => (
          <li key={t.m.id} className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
            <p className="font-semibold wrap-break-word">{t.name}</p>
            <p className="text-sm text-muted [overflow-wrap:anywhere]">{t.email}</p>
            <p className="mt-2 flex flex-wrap gap-2">
              {t.totp ? <Badge tone="primary">2FA aktiv</Badge> : <Badge tone="warn">2FA fehlt</Badge>}
              {t.m.active ? <Badge tone="primary">aktiv</Badge> : <Badge>gesperrt</Badge>}
            </p>
            {t.m.userId === auth.user.id ? (
              <p className="mt-2 text-sm">Rolle: {ROLE_LABELS[t.m.role]}</p>
            ) : (
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <RoleForm id={t.m.id} role={t.m.role} idPrefix="m-" />
                <LockForm id={t.m.id} active={t.m.active} />
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
        <Table label="Team">
          <thead><tr><th>Name</th><th>Rolle</th><th>2FA</th><th>Status</th><th><span className="sr-only">Aktion</span></th></tr></thead>
          <tbody>
            {team.map((t) => (
              <tr key={t.m.id}>
                <td><p className="font-semibold">{t.name}</p><p className="text-sm text-muted">{t.email}</p></td>
                <td>{t.m.userId === auth.user.id ? ROLE_LABELS[t.m.role] : <RoleForm id={t.m.id} role={t.m.role} />}</td>
                <td>{t.totp ? <Badge tone="primary">aktiv</Badge> : <Badge tone="warn">fehlt</Badge>}</td>
                <td>{t.m.active ? <Badge tone="primary">aktiv</Badge> : <Badge>gesperrt</Badge>}</td>
                <td>{t.m.userId !== auth.user.id ? <LockForm id={t.m.id} active={t.m.active} /> : null}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      {calendarTeam.length ? (
        <Card>
          <CardTitle>Kalenderfarben</CardTitle>
          <p className="mb-4 text-sm text-muted">Termine im Kalender erscheinen in der Farbe der Behandler:in. „Automatisch“ vergibt die nächste freie Farbe. Jede Person kann ihre eigene Farbe auch unter Einstellungen → Ansicht wählen.</p>
          <ul className="flex flex-col divide-y divide-border">
            {calendarTeam.map((t) => (
              <li key={t.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <p className="flex items-center gap-2 font-semibold">
                  <span className="inline-block size-3 rounded-full" style={dotStyle(colors.get(t.id)!)} aria-hidden />
                  {t.name}
                </p>
                {auth.support || auth.readOnly ? null : <TherapistColorForm userId={t.id} stored={t.color} effective={colors.get(t.id)!} legend={`Kalenderfarbe für ${t.name}`} />}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card>
        <CardTitle>Person hinzufügen</CardTitle>
        <ActionForm action={inviteMemberAction} submit="Hinzufügen">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Name"><Input name="name" required /></Field>
            <Field label="E-Mail"><Input name="email" type="email" required /></Field>
            <Field label="Rolle" hint={auth.billing.plan === "free" ? undefined : "Empfang und Steuerberatung belegen keinen Platz; nur Inhaber:in und Podolog:in haben eine eigene Kalenderspalte"}><Select name="role" defaultValue="therapist">{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</Select></Field>
            <Field label="Startpasswort" hint="min. 12 Zeichen"><Input name="password" type="text" minLength={12} autoComplete="off" /></Field>
          </div>
        </ActionForm>
      </Card>
      <Card>
        <CardTitle>Was darf welche Rolle?</CardTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ROLES.map((r) => (
            <div key={r} className="rounded-xl bg-surface-2 p-3 text-sm">
              <p className="font-semibold">{ROLE_LABELS[r]}</p>
              <p className="text-[13px] text-muted">{`${hasOwnCalendar(r) ? "eigener Kalender" : "kein eigener Kalender"}, ${seatCounts(r, auth.billing.plan) ? "belegt einen Platz" : "kein Platz"}`}</p>
              <p className="mt-1 text-muted">{permissionsFor(r).join(", ")}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
