import Link from "next/link";
import { Receipt } from "lucide-react";
import { Card, PageHeader } from "@/components/ui";
import { fiscalIsTestMode } from "@/integrations/tse";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, dateDe, money } from "@/lib/format";
import { INVOICE_KIND_LABEL } from "@/lib/invoice-labels";
import { billingFromSource } from "@/server/appointment-billing";
import { DepositForm } from "./deposit-form";

export const metadata = { title: "Quittung für Sammelrechnung" };

const str = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : null);
const euro = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");

/** Quittung über eine Anzahlung aus Termin (?termin=) oder Behandlung (?behandlung=) – Anrechnung auf die Sammelrechnung. */
export default async function DepositPage(props: PageProps<"/rechnungen/anzahlung">) {
  const auth = await requireAuth("invoices.write");
  const sp = await props.searchParams;
  const src = await billingFromSource(auth, { appointmentId: str(sp.termin), recordId: str(sp.behandlung) });
  const smallBusiness = auth.organization.smallBusiness;
  const year = src?.patient ? Number(berlinDateIso(src.at).slice(0, 4)) : null;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Quittung für Sammelrechnung" subtitle="Zahlung jetzt annehmen – Anrechnung auf die Sammelrechnung zum Jahresende" />
      {!src ? (
        <Card><p className="text-sm text-danger">Bitte die Quittung aus einem Termin oder einer Behandlung heraus erstellen (Kalender → Termin bzw. Kundenakte → Behandlung).</p></Card>
      ) : !src.patient ? (
        <Card><p className="text-sm text-danger">{src.error}</p></Card>
      ) : (
        <>
          <Card className="mb-6">
            <p className="flex items-center gap-2 font-display text-lg font-semibold">
              <Receipt size={20} aria-hidden /> {src.patient.name} · Behandlung am {dateDe(src.at)}
            </p>
            <p className="mt-1 text-sm text-muted">
              Die Kund:in erhält jetzt eine Quittung über den gezahlten Betrag. Die Leistung selbst steht später auf der Sammelrechnung {year}; dort wird die Zahlung als Anzahlung abgezogen.
            </p>
            {src.billedBy.length ? (
              <p className="mt-2 text-sm font-semibold text-danger">
                Achtung: Diese Behandlung ist bereits abgerechnet ({src.billedBy.map((d) => `${INVOICE_KIND_LABEL[d.kind]} ${d.number}`).join(", ")}). Eine Zahlung dazu bitte dort erfassen.
              </p>
            ) : null}
            {src.documents.some((d) => d.kind === "deposit" && d.status !== "cancelled") ? (
              <p className="mt-2 text-sm">
                Bereits quittiert:{" "}
                {src.documents
                  .filter((d) => d.kind === "deposit" && d.status !== "cancelled")
                  .map((d) => (
                    <Link key={d.id} href={`/rechnungen/${d.id}`} className="mr-2 font-semibold text-primary">
                      {d.number} ({money(d.totalCents)})
                    </Link>
                  ))}
              </p>
            ) : null}
            {src.prescription ? (
              <p className="mt-2 rounded-xl bg-info-soft p-3 text-sm text-info-soft-text">Behandlung auf Verordnung – die Leistung selbst wird mit der Krankenkasse abgerechnet.</p>
            ) : null}
          </Card>
          <DepositForm
            smallBusiness={smallBusiness}
            tseTestMode={fiscalIsTestMode()}
            defaults={{
              patientId: src.patient.id,
              appointmentId: src.appointmentId,
              treatmentRecordId: src.recordId,
              description: `Anzahlung auf die Sammelrechnung ${year}: Behandlung am ${dateDe(src.at)}${
                src.lines.some((l) => l.serviceId) ? ` (${src.lines.filter((l) => l.serviceId).map((l) => l.description.replace(/^\d{2}\.\d{2}\.\d{4}: /, "")).join(", ")})` : ""
              }`.slice(0, 300),
              amount: src.estimateCents ? euro(src.estimateCents) : "",
              vatRate: src.lines[0]?.vatRate ?? 0,
            }}
          />
        </>
      )}
    </div>
  );
}
