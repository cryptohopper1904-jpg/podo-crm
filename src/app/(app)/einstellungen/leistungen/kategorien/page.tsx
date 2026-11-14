import { ArrowDown, ArrowUp } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Empty, Field, Input, PageHeader, Select } from "@/components/ui";
import { withOrg } from "@/db";
import { requireAuth } from "@/lib/auth/session";
import { SERVICE_CATEGORY_LABELS, SERVICE_KIND_HINTS } from "@/lib/catalog";
import { listServiceCategories, NEW_CATEGORY_KINDS } from "@/server/service-catalog";
import { createCategoryAction, deleteCategoryAction, moveCategoryAction, moveServicesAction, renameCategoryAction } from "../../actions";

export const metadata = { title: "Kategorien der Leistungen" };

const BASE = "/einstellungen/leistungen";

/**
 * Eigene Kategorien der Leistungen: anlegen, umbenennen, sortieren (Reihenfolge der Gruppen in Einstellungen →
 * Leistungen und im Kategorie-Filter), löschen – nur leere Kategorien; vorher lassen sich alle Leistungen in eine
 * andere Kategorie verschieben. Die Art (Behandlung, Nagelkorrektur …) wird beim Anlegen gewählt: an ihr hängen
 * Online-Buchung, Website und Wegegeld. „Verkauf (alt)“ lässt sich nicht neu anlegen (Produkte haben eine eigene Liste).
 */
export default async function ServiceCategoriesPage() {
  const auth = await requireAuth("settings.manage");
  const org = auth.organization.id;
  const cats = await withOrg(org, (tx) => listServiceCategories(tx, org));
  const iconBtn = "inline-flex size-11 items-center justify-center rounded-xl border border-border bg-surface hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Kategorien" subtitle="Leistungen" back={{ href: BASE, label: "Leistungen" }} />

      <Card>
        <CardTitle>Neue Kategorie</CardTitle>
        <ActionForm action={createCategoryAction} submit="Anlegen">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name"><Input name="name" required maxLength={60} placeholder="z. B. Fußpflege kosmetisch" /></Field>
            <Field
              label="Art"
              hint={
                <>
                  Bestimmt Online-Buchung, Website und Wegegeld; später nicht änderbar.{" "}
                  {NEW_CATEGORY_KINDS.map((k) => SERVICE_KIND_HINTS[k]).join(" · ")}
                </>
              }
            >
              <Select name="kind" defaultValue="treatment">
                {NEW_CATEGORY_KINDS.map((k) => (
                  <option key={k} value={k}>{SERVICE_CATEGORY_LABELS[k]}</option>
                ))}
              </Select>
            </Field>
          </div>
        </ActionForm>
      </Card>

      {cats.length === 0 ? (
        <Empty title="Noch keine Kategorien">Lege oben die erste Kategorie an.</Empty>
      ) : (
        <ol aria-label="Kategorien in Anzeige-Reihenfolge" className="flex flex-col gap-3">
          {cats.map((c, i) => (
            <li key={c.id}>
              <Card className="flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="w-full min-w-0 font-display text-lg font-semibold wrap-break-word sm:w-auto sm:flex-1">{c.name}</h2>
                  <Badge tone="neutral">{SERVICE_CATEGORY_LABELS[c.kind] ?? c.kind}</Badge>
                  <Badge tone={c.count ? "primary" : "neutral"}>{c.count} Leistung{c.count === 1 ? "" : "en"}</Badge>
                  <form action={moveCategoryAction} className="ml-auto flex gap-1">
                    <input type="hidden" name="id" value={c.id} />
                    <button name="dir" value="up" className={iconBtn} disabled={i === 0} aria-label={`${c.name} nach oben`} title="Nach oben">
                      <ArrowUp size={18} aria-hidden />
                    </button>
                    <button name="dir" value="down" className={iconBtn} disabled={i === cats.length - 1} aria-label={`${c.name} nach unten`} title="Nach unten">
                      <ArrowDown size={18} aria-hidden />
                    </button>
                  </form>
                </div>
                <details className="group">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center text-sm font-semibold text-primary [&::-webkit-details-marker]:hidden">
                    Umbenennen, verschieben oder löschen
                  </summary>
                  <div className="mt-2 grid grid-cols-1 gap-4 md:grid-cols-2">
                    <ActionForm action={renameCategoryAction} submit="Umbenennen">
                      <input type="hidden" name="id" value={c.id} />
                      <Field label={`Neuer Name für „${c.name}“`}><Input name="name" defaultValue={c.name} required maxLength={60} /></Field>
                    </ActionForm>
                    {c.count > 0 ? (
                      cats.length > 1 ? (
                        <ActionForm action={moveServicesAction} submit="Leistungen verschieben">
                          <input type="hidden" name="id" value={c.id} />
                          <Field label={`Alle ${c.count} Leistung(en) verschieben nach`} hint="Danach lässt sich die leere Kategorie löschen. Die Art der Leistungen folgt der Ziel-Kategorie.">
                            <Select name="to" required defaultValue="">
                              <option value="" disabled>Kategorie wählen …</option>
                              {cats.filter((x) => x.id !== c.id).map((x) => (
                                <option key={x.id} value={x.id}>{x.name}</option>
                              ))}
                            </Select>
                          </Field>
                        </ActionForm>
                      ) : (
                        <p className="text-[13px] leading-5 text-muted">Zum Löschen zuerst eine weitere Kategorie anlegen und die Leistungen dorthin verschieben.</p>
                      )
                    ) : (
                      <ActionForm action={deleteCategoryAction} submit="Kategorie löschen">
                        <input type="hidden" name="id" value={c.id} />
                        <p className="text-sm text-muted">„{c.name}“ ist leer und kann gelöscht werden.</p>
                      </ActionForm>
                    )}
                  </div>
                </details>
              </Card>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
