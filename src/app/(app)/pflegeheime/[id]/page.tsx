import Link from "next/link";
import { notFound } from "next/navigation";
import { ClipboardList, FileText } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Checkbox, Empty, Field, LinkButton, Select, Table, pageTitleBox, pageTitleCls, BackLink } from "@/components/ui";
import { RiskBadges } from "@/components/risk-badges";
import { requireAuth } from "@/lib/auth/session";
import { dateDe, fullName } from "@/lib/format";
import { getCareHome } from "@/server/care-homes";
import { assignResidentAction, removeResidentAction, saveCareHomeAction } from "../actions";
import { CareHomeFields } from "../care-home-fields";

export const metadata = { title: "Pflegeheim" };

export default async function CareHomePage(props: PageProps<"/pflegeheime/[id]">) {
  const { id } = await props.params;
  const auth = await requireAuth("patients.read");
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const data = await getCareHome(auth, id);
  if (!data) notFound();
  const { home, residents, candidates } = data;
  const canWrite = auth.can("patients.write");
  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex flex-wrap items-end gap-4">
        <div className={pageTitleBox}>
          <BackLink href="/pflegeheime" label="Pflegeheime" />
          <h1 className={pageTitleCls}>{home.name}</h1>
          <p className="text-sm text-muted">{[home.street, [home.zip, home.city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "Adresse fehlt"}{home.phone ? ` · ${home.phone}` : ""}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <LinkButton href={`/pflegeheime/${id}/besuchstag`}><ClipboardList size={18} aria-hidden /> Besuchstag</LinkButton>
          {auth.can("invoices.write") ? <LinkButton href={`/rechnungen/neu?pflegeheim=${id}`} variant="secondary"><FileText size={18} aria-hidden /> Sammelrechnung</LinkButton> : null}
        </div>
      </header>

      <div className="flex flex-wrap gap-6">
        <div className="flex min-w-0 flex-[2_1_480px] flex-col gap-6">
          <Card>
            <CardTitle>Bewohner:innen ({residents.length})</CardTitle>
            {residents.length === 0 ? (
              <Empty title="Noch niemand zugeordnet" />
            ) : (
              <Table>
                <thead><tr><th>Name</th><th>Geburtsdatum</th><th>Risiken</th><th>Rechnung an</th>{canWrite ? <th><span className="sr-only">Aktionen</span></th> : null}</tr></thead>
                <tbody>
                  {residents.map((p) => (
                    <tr key={p.id}>
                      <td><Link href={`/kunden/${p.id}`} className="font-semibold hover:text-primary">{fullName(p)}</Link><div className="text-xs text-muted">#{p.number}</div></td>
                      <td>{dateDe(p.birthDate)}</td>
                      <td><RiskBadges flags={p.riskFlags} compact /></td>
                      <td>{p.billingContactId === id ? <Badge tone="info">Pflegeheim</Badge> : <span className="text-sm text-muted">{p.billingContactId ? "anderer Empfänger" : "Patient"}</span>}</td>
                      {canWrite ? (
                        <td className="text-right">
                          <form action={removeResidentAction}>
                            <input type="hidden" name="careHomeId" value={id} />
                            <input type="hidden" name="patientId" value={p.id} />
                            <button type="submit" className="text-sm font-semibold text-danger">entfernen</button>
                          </form>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
        {canWrite ? (
          <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-6">
            <Card>
              <CardTitle>Bewohner:in zuordnen</CardTitle>
              <ActionForm action={assignResidentAction} submit="Zuordnen">
                <input type="hidden" name="careHomeId" value={id} />
                <Field label="Patient">
                  <Select name="patientId" defaultValue="" required>
                    <option value="" disabled>Bitte wählen …</option>
                    {candidates.map((c) => <option key={c.id} value={c.id}>{c.lastName}{c.firstName ? `, ${c.firstName}` : ""} (#{c.number}{c.birthDate ? `, ${dateDe(c.birthDate)}` : ""})</option>)}
                  </Select>
                </Field>
                <Checkbox name="billToHome" label="Rechnungen an das Pflegeheim (Sammelrechnung)" />
              </ActionForm>
            </Card>
            <Card>
              <CardTitle>Daten der Einrichtung</CardTitle>
              <ActionForm action={saveCareHomeAction}>
                <CareHomeFields home={home} />
              </ActionForm>
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  );
}
