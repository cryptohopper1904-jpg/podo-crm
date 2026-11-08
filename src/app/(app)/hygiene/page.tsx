import Link from "next/link";
import { CheckCircle2, Circle } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Empty, Field, Stat, Textarea } from "@/components/ui";
import { berlinDateIso, dateDe, timeDe } from "@/lib/format";
import { DEADLINE_FIELDS, DEADLINE_LABELS, deadlineStatus, needsReorder } from "@/lib/hygiene-rules";
import { checklistState, getChecklist, listBatches, listDevices, listMaterials, syncHygieneTasks } from "@/server/hygiene";
import { canEditHygiene, canViewHygiene, canViewMaterials, requireHygiene } from "./access";
import { completeCheckAction, saveChecklistAction, undoCheckAction } from "./actions";
import { DeadlineBadge } from "./badges";

export const metadata = { title: "Hygiene" };

export default async function HygieneOverview() {
  const auth = await requireHygiene(canViewHygiene);
  const org = auth.organization.id;
  const today = berlinDateIso();
  // Fristen → Aufgaben (erscheinen auch auf „Heute“)
  await syncHygieneTasks(org, today);
  const [checks, devs, batches, mats, list] = await Promise.all([
    checklistState(org, today),
    listDevices(auth, { activeOnly: true }),
    listBatches(auth, 100),
    canViewMaterials(auth) ? listMaterials(auth, { activeOnly: true }) : Promise.resolve([]),
    auth.can("settings.manage") ? getChecklist(org) : Promise.resolve(null),
  ]);
  const edit = canEditHygiene(auth);
  const deadlines = devs
    .flatMap((d) => DEADLINE_FIELDS.map((f) => ({ device: d, field: f, date: d[f], st: deadlineStatus(d[f], today) })))
    .filter((x) => x.st.status === "overdue" || x.st.status === "soon")
    .sort((a, b) => (a.st.daysLeft ?? 0) - (b.st.daysLeft ?? 0));
  const pending = batches.filter((b) => b.b.result === "pending").length;
  const lowStock = mats.filter(needsReorder).length;
  const daily = checks.filter((c) => c.interval === "daily");
  const weekly = checks.filter((c) => c.interval === "weekly");

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Chargen ohne Freigabe" value={pending} tone={pending ? "warn" : "neutral"} sub={<Link href="/hygiene/chargen" className="underline">zu den Chargen</Link>} />
        <Stat label="Fristen ≤ 30 Tage / überfällig" value={deadlines.length} tone={deadlines.some((d) => d.st.status === "overdue") ? "accent" : deadlines.length ? "warn" : "primary"} sub={<Link href="/hygiene/geraete" className="underline">zu den Geräten</Link>} />
        {canViewMaterials(auth) ? (
          <Stat label="Material nachbestellen" value={lowStock} tone={lowStock ? "warn" : "neutral"} sub={<Link href="/hygiene/material/bestellliste" className="underline">Bestellliste</Link>} />
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Hygiene-Checkliste {dateDe(today)}</CardTitle>
          {checks.length === 0 ? (
            <Empty title="Keine Checkliste hinterlegt" />
          ) : (
            <div className="flex flex-col gap-5">
              {[{ label: "Täglich", items: daily }, { label: "Diese Woche", items: weekly }].map(({ label, items }) =>
                items.length ? (
                  <section key={label}>
                    <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{label}</h3>
                    <ul className="flex flex-col gap-1">
                      {items.map((c) => (
                        <li key={c.title} className="flex items-center gap-3 rounded-xl px-1 py-1">
                          {c.doneAt ? (
                            <>
                              <CheckCircle2 size={22} className="shrink-0 text-primary" aria-hidden />
                              <span className="flex-1">
                                {c.item}
                                <span className="block text-xs text-muted">erledigt {dateDe(c.doneAt)} {timeDe(c.doneAt)}{c.doneBy ? ` · ${c.doneBy}` : ""}</span>
                              </span>
                              {edit && c.taskId && berlinDateIso(c.doneAt) === today ? (
                                <form action={undoCheckAction}>
                                  <input type="hidden" name="taskId" value={c.taskId} />
                                  <button className="min-h-11 px-2 text-sm font-semibold text-muted hover:text-text">rückgängig</button>
                                </form>
                              ) : null}
                            </>
                          ) : edit ? (
                            <form action={completeCheckAction} className="flex flex-1">
                              <input type="hidden" name="interval" value={c.interval} />
                              <input type="hidden" name="item" value={c.item} />
                              <button className="flex min-h-11 flex-1 items-center gap-3 text-left hover:text-primary">
                                <Circle size={22} className="shrink-0 text-muted" aria-hidden />
                                <span>{c.item}</span>
                                <span className="sr-only">– als erledigt markieren</span>
                              </button>
                            </form>
                          ) : (
                            <>
                              <Circle size={22} className="shrink-0 text-muted" aria-hidden />
                              <span>{c.item}</span>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null,
              )}
            </div>
          )}
          {list ? (
            <details className="mt-5">
              <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-primary">Checkliste anpassen</summary>
              <ActionForm action={saveChecklistAction} submit="Checkliste speichern">
                <Field label="Täglich" hint="Ein Punkt pro Zeile">
                  <Textarea name="daily" rows={6} defaultValue={list.daily.join("\n")} />
                </Field>
                <Field label="Wöchentlich" hint="Ein Punkt pro Zeile">
                  <Textarea name="weekly" rows={4} defaultValue={list.weekly.join("\n")} />
                </Field>
              </ActionForm>
            </details>
          ) : null}
        </Card>

        <Card>
          <CardTitle>Anstehende Fristen</CardTitle>
          {deadlines.length === 0 ? (
            <Empty title="Keine Fristen in den nächsten 30 Tagen" />
          ) : (
            <ul className="flex flex-col gap-2">
              {deadlines.map((d) => (
                <li key={`${d.device.id}-${d.field}`} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2">
                  <Link href={`/hygiene/geraete/${d.device.id}`} className="font-semibold hover:underline">
                    {DEADLINE_LABELS[d.field]}: {d.device.name}
                  </Link>
                  <DeadlineBadge date={d.date} today={today} />
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-sm text-muted">Fristen ≤ 30 Tage werden automatisch als Aufgabe angelegt und erscheinen auf „Heute“.</p>
        </Card>
      </div>

      <Card>
        <CardTitle action={<Link href="/hygiene/chargen" className="text-sm font-semibold text-primary">alle Chargen</Link>}>Letzte Chargen</CardTitle>
        {batches.length === 0 ? (
          <Empty title="Noch keine Chargen erfasst" />
        ) : (
          <ul className="flex flex-wrap gap-2">
            {batches.slice(0, 8).map((b) => (
              <li key={b.b.id}>
                <Link href={`/hygiene/charge/${encodeURIComponent(b.b.code)}`} className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm hover:bg-surface-2">
                  <span className="font-mono font-semibold">{b.b.code}</span>
                  <Badge tone={b.b.result === "released" ? "primary" : b.b.result === "rejected" ? "accent" : "warn"}>
                    {b.b.result === "released" ? "frei" : b.b.result === "rejected" ? "gesperrt" : "offen"}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
