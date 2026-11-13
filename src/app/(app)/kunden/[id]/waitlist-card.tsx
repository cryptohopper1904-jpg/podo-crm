import { and, asc, eq, inArray } from "drizzle-orm";
import { withOrg } from "@/db";
import { services } from "@/db/schema";
import { Button, Card, CardTitle, Input } from "@/components/ui";
import type { AuthContext } from "@/lib/auth/session";
import { dateDe } from "@/lib/format";
import { DAYPART_LABEL, DAYPARTS } from "@/lib/waitlist";
import { listWaitlist } from "@/server/waitlist";
import { addWaitlistAction, resolveWaitlistAction } from "./waitlist-actions";

const WD = ["Mo", "Di", "Mi", "Do", "Fr", "Sa"];

/**
 * Warteliste je Person: wird ein passender Termin frei (Absage durch Praxis oder Patientenportal), bekommt die
 * Person – nur mit Erinnerungs-Einwilligung – automatisch ein Einmal-Angebot; sonst Vorschlag im Posteingang.
 */
export async function WaitlistCard({ auth, patientId }: { auth: AuthContext; patientId: string }) {
  const org = auth.organization.id;
  const [entries, svc] = [
    await listWaitlist(auth, patientId),
    await withOrg(org, (tx) =>
      tx
        .select({ id: services.id, name: services.name })
        .from(services)
        .where(and(eq(services.organizationId, org), eq(services.active, true), inArray(services.category, ["treatment", "cosmetic", "brace"])))
        .orderBy(asc(services.name)),
    ),
  ];
  return (
    <Card>
      <CardTitle>Warteliste</CardTitle>
      {entries.length ? (
        <ul className="mb-3 flex flex-col gap-2">
          {entries.map((e) => (
            <li key={e.id} className="flex items-start justify-between gap-2 rounded-xl bg-surface-2 p-3 text-sm">
              <span>
                <span className="font-semibold">{e.label}</span>
                <span className="block text-muted">seit {dateDe(e.createdAt)}{e.note ? ` · ${e.note}` : ""}</span>
              </span>
              <form action={resolveWaitlistAction}>
                <input type="hidden" name="id" value={e.id} />
                <input type="hidden" name="patientId" value={patientId} />
                <button type="submit" className="rounded-lg px-2 py-1 text-xs font-semibold text-primary hover:bg-surface">erledigt</button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-sm text-muted">Nicht auf der Warteliste.</p>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-semibold text-primary">Auf die Warteliste setzen</summary>
        <form action={addWaitlistAction} className="mt-3 flex flex-col gap-3 text-sm">
          <input type="hidden" name="patientId" value={patientId} />
          <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
            <legend className="mb-1 font-semibold">Leistung (leer = egal)</legend>
            {svc.map((s) => (
              <label key={s.id} className="flex items-center gap-1"><input type="checkbox" name="serviceId" value={s.id} /> {s.name}</label>
            ))}
          </fieldset>
          <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
            <legend className="mb-1 font-semibold">Wochentage (leer = egal)</legend>
            {WD.map((d, i) => (
              <label key={d} className="flex items-center gap-1"><input type="checkbox" name="weekday" value={i + 1} /> {d}</label>
            ))}
          </fieldset>
          <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
            <legend className="mb-1 font-semibold">Tageszeit (leer = egal)</legend>
            {DAYPARTS.map((d) => (
              <label key={d} className="flex items-center gap-1"><input type="checkbox" name="daypart" value={d} /> {DAYPART_LABEL[d]}</label>
            ))}
          </fieldset>
          <Input name="note" maxLength={500} placeholder="Notiz (optional, keine Diagnosen)" aria-label="Notiz" />
          <Button type="submit" variant="secondary">Eintragen</Button>
          <p className="text-xs text-muted">Angebote gehen nur mit Erinnerungs-Einwilligung (E-Mail/SMS/WhatsApp) raus, sonst als Anruf-Vorschlag in den Posteingang.</p>
        </form>
      </details>
    </Card>
  );
}
