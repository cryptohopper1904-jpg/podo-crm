import Link from "next/link";
import { Building2 } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Card, CardTitle, Empty, PageHeader, Table } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { listCareHomes } from "@/server/care-homes";
import { saveCareHomeAction } from "./actions";
import { CareHomeFields } from "./care-home-fields";

export const metadata = { title: "Pflegeheime" };

export default async function CareHomesPage() {
  const auth = await requireAuth("patients.read");
  const homes = await listCareHomes(auth);
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Pflegeheime" subtitle="Viele Bewohner:innen an einem Ort – Besuchstag, Listen-Doku, Sammelrechnung" />
      <div className="flex flex-wrap gap-6">
        <div className="min-w-0 flex-[2_1_480px]">
          {homes.length === 0 ? (
            <Empty title="Noch keine Pflegeheime">Legen Sie rechts eine Einrichtung an und ordnen Sie dann die Bewohner:innen zu.</Empty>
          ) : (
            <Table>
              <thead><tr><th>Einrichtung</th><th>Ort</th><th>Bewohner:innen</th><th><span className="sr-only">Aktionen</span></th></tr></thead>
              <tbody>
                {homes.map((h) => (
                  <tr key={h.id}>
                    <td><Link href={`/pflegeheime/${h.id}`} className="inline-flex items-center gap-2 font-semibold hover:text-primary"><Building2 size={16} aria-hidden /> {h.name}</Link></td>
                    <td>{[h.zip, h.city].filter(Boolean).join(" ") || "–"}</td>
                    <td className="tabular-nums">{h.patientCount}</td>
                    <td className="text-right"><Link href={`/pflegeheime/${h.id}/besuchstag`} className="font-semibold text-primary">Besuchstag</Link></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
        {auth.can("patients.write") ? (
          <Card className="min-w-0 flex-[1_1_320px] self-start">
            <CardTitle>Neues Pflegeheim</CardTitle>
            <ActionForm action={saveCareHomeAction} submit="Anlegen">
              <CareHomeFields />
            </ActionForm>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
