import { notFound } from "next/navigation";
import { Badge, Button, Card } from "@/components/ui";
import { dateTimeDe } from "@/lib/format";
import { LEAD_STATUSES, SEQUENCE_STEPS, STATUS_LABEL, isLeadStatus } from "@/lib/vertrieb/constants";
import { delayBefore } from "@/lib/vertrieb/eligibility";
import { requirePlatformAdmin } from "@/server/platform";
import { getLead, getSalesSettings } from "@/server/vertrieb";
import { deleteLeadAction, setStatusAction, updateLeadAction } from "../actions";
import { LeadForm } from "../lead-form";

export const metadata = { title: "Praxis · Vertrieb" };

export default async function LeadPage({ params }: PageProps<"/plattform/vertrieb/[id]">) {
  await requirePlatformAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await getLead(id);
  if (!data) notFound();
  const { lead, sends, suppressed } = data;
  const settings = await getSalesSettings();
  const nextStep = lead.step + 1;
  const dueAt = lead.step > 0 && lead.step < SEQUENCE_STEPS && lead.lastSentAt ? new Date(lead.lastSentAt.getTime() + delayBefore(nextStep, settings.delays) * 86_400_000) : null;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
      <Card>
        <h2 className="mb-4 font-display text-xl font-semibold">{lead.name}</h2>
        <LeadForm
          action={updateLeadAction}
          submit="Speichern"
          values={{ ...lead }}
        />
      </Card>
      <div className="flex flex-col gap-5">
        <Card>
          <h2 className="font-display text-lg font-semibold">Status</h2>
          <p className="mt-1 text-sm">
            <Badge tone="info">{isLeadStatus(lead.status) ? STATUS_LABEL[lead.status] : lead.status}</Badge>{" "}
            {suppressed ? <Badge tone="accent">auf der Sperrliste</Badge> : null}
          </p>
          <form action={setStatusAction} className="mt-3 flex items-center gap-2">
            <input type="hidden" name="id" value={lead.id} />
            <label className="sr-only" htmlFor="status">Status</label>
            <select id="status" name="status" defaultValue={lead.status} className="h-10 flex-1 rounded-xl border border-border bg-surface px-3 text-sm">
              {LEAD_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
            <Button type="submit" variant="secondary" className="h-10">Setzen</Button>
          </form>
          <p className="mt-2 text-xs text-muted">„Geantwortet“, „Interessiert“, „Kein Interesse“, „Abgemeldet“ und „Kunde“ beenden die Sequenz. „Abgemeldet“ sperrt die Adresse dauerhaft.</p>
        </Card>
        <Card>
          <h2 className="font-display text-lg font-semibold">Verlauf</h2>
          {sends.length ? (
            <ol className="mt-3 flex flex-col gap-2 text-sm">
              {sends.map((s) => (
                <li key={s.id} className="rounded-xl border border-border px-3 py-2">
                  <p className="font-semibold">Mail {s.step} · {dateTimeDe(s.sentAt)}</p>
                  <p className={s.ok ? "text-muted" : "text-danger"}>
                    {s.ok ? (s.mock ? "Testmodus – nicht wirklich versendet" : "versendet") : `Fehler: ${s.error ?? "unbekannt"}`}
                  </p>
                  {s.messageId ? <p className="break-all text-xs text-muted">{s.messageId}</p> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-sm text-muted">Noch keine Mail gesendet.</p>
          )}
          <p className="mt-3 text-sm">
            {lead.step >= SEQUENCE_STEPS ? "Sequenz abgeschlossen." : dueAt ? `Mail ${nextStep} fällig ab ${dueAt.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" })}.` : lead.step === 0 ? "Mail 1 kann gesendet werden." : null}
          </p>
          <p className="mt-1 text-xs text-muted">Angelegt {dateTimeDe(lead.createdAt)} · geändert {dateTimeDe(lead.updatedAt)}</p>
        </Card>
        <Card>
          <h2 className="font-display text-lg font-semibold">Löschen</h2>
          <form action={deleteLeadAction} className="mt-2 flex flex-col gap-2 text-sm">
            <input type="hidden" name="id" value={lead.id} />
            <label className="flex items-center gap-2">
              <input type="checkbox" name="confirm" value="ja" required className="size-5" /> Eintrag endgültig löschen
            </label>
            <p className="text-xs text-muted">Eine Sperre (Abmeldung) bleibt bestehen, auch wenn der Eintrag gelöscht wird.</p>
            <div><Button type="submit" variant="danger" className="h-10">Löschen</Button></div>
          </form>
        </Card>
      </div>
    </div>
  );
}
