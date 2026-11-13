import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Empty, Field, Input, Table, Textarea } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { safeHttpUrl } from "@/lib/hygiene-rules";
import { listSuppliers } from "@/server/products";
import { saveSupplierAction, setSupplierActiveAction } from "../actions";

export const metadata = { title: "Lieferanten" };

export default async function SuppliersPage(props: PageProps<"/produkte/lieferanten">) {
  const auth = await requireAuth("invoices.read");
  const sp = await props.searchParams;
  const rows = await listSuppliers(auth);
  const manage = auth.can("settings.manage");
  const editing = typeof sp.edit === "string" ? rows.find((r) => r.supplier.id === sp.edit)?.supplier : undefined;

  return (
    <div className="flex flex-col gap-6">
      {rows.length === 0 ? (
        <Empty title="Noch keine Lieferanten" />
      ) : (
        <Table>
          <thead><tr><th>Lieferant</th><th>Kundennr.</th><th>Kontakt</th><th className="text-right">Produkte</th><th></th></tr></thead>
          <tbody>
            {rows.map(({ supplier: s, products }) => {
              const url = safeHttpUrl(s.website);
              return (
                <tr key={s.id} className={s.active ? undefined : "opacity-60"}>
                  <td>
                    <p className="font-semibold">{s.name}</p>
                    {!s.active ? <Badge>archiviert</Badge> : null}
                    {s.note ? <p className="text-xs text-muted">{s.note}</p> : null}
                  </td>
                  <td className="text-sm">{s.customerNumber ?? "–"}</td>
                  <td className="text-sm">
                    {s.email ? <a href={`mailto:${encodeURIComponent(s.email)}`} className="block text-primary">{s.email}</a> : null}
                    {s.phone ? <span className="block">{s.phone}</span> : null}
                    {url ? (
                      <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary">
                        Website <ExternalLink size={13} aria-hidden />
                      </a>
                    ) : null}
                  </td>
                  <td className="text-right tabular-nums">{products}</td>
                  <td>
                    {manage ? (
                      <div className="flex items-center gap-3">
                        <Link href={{ pathname: "/produkte/lieferanten", query: { edit: s.id } }} className="text-sm font-semibold text-primary">bearbeiten</Link>
                        <form action={setSupplierActiveAction}>
                          <input type="hidden" name="id" value={s.id} />
                          <input type="hidden" name="active" value={s.active ? "0" : "1"} />
                          <button className="text-sm font-semibold text-muted hover:underline">{s.active ? "archivieren" : "wiederherstellen"}</button>
                        </form>
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {manage ? (
        <Card>
          <CardTitle action={editing ? <Link href="/produkte/lieferanten" className="text-sm font-semibold text-muted">Abbrechen</Link> : undefined}>
            {editing ? `Bearbeiten: ${editing.name}` : "Lieferant hinzufügen"}
          </CardTitle>
          <ActionForm key={editing?.id ?? `neu-${rows.length}`} action={saveSupplierAction} submit={editing ? "Änderung speichern" : "Lieferant anlegen"}>
            {editing ? <input type="hidden" name="id" value={editing.id} /> : null}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Name *"><Input name="name" defaultValue={editing?.name} required maxLength={160} /></Field>
              <Field label="Unsere Kundennummer"><Input name="customerNumber" defaultValue={editing?.customerNumber ?? ""} maxLength={60} /></Field>
              <Field label="Telefon"><Input name="phone" defaultValue={editing?.phone ?? ""} maxLength={60} /></Field>
              <Field label="E-Mail (Bestellungen)"><Input name="email" type="email" defaultValue={editing?.email ?? ""} maxLength={200} /></Field>
              <Field label="Website / Shop" className="lg:col-span-2"><Input name="website" type="url" defaultValue={editing?.website ?? ""} placeholder="https://" maxLength={300} /></Field>
              <Field label="Notiz" className="sm:col-span-2 lg:col-span-3"><Textarea name="note" defaultValue={editing?.note ?? ""} maxLength={500} placeholder="z. B. Mindestbestellwert, Lieferzeit" /></Field>
            </div>
          </ActionForm>
          <p className="mt-2 text-xs text-muted">Nur Geschäftsdaten des Lieferanten – keine Patientendaten.</p>
        </Card>
      ) : null}
    </div>
  );
}
