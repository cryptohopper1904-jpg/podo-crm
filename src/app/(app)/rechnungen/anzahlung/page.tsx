import Link from "next/link";
import { Info, Receipt } from "lucide-react";
import { PatientPicker } from "@/components/patient-search";
import { Card, LinkButton, PageHeader } from "@/components/ui";
import { fiscalIsTestMode } from "@/integrations/tse";
import { requireAuth } from "@/lib/auth/session";
import { depositAllowed } from "@/lib/deposit-rules";
import { berlinDateIso, dateDe, money } from "@/lib/format";
import { DEPOSIT_PAST_ERROR, DEPOSIT_PURPOSE_HINT, INVOICE_KIND_LABEL } from "@/lib/invoice-labels";
import { billingFromSource, depositPatient } from "@/server/appointment-billing";
import { DepositForm } from "./deposit-form";

export const metadata = { title: "Anzahlung (Vorauszahlung)" };

const str = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : null);
const euro = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");

/**
 * Anzahlung (Vorauszahlung vor der Behandlung, z. B. Nagelspange) – aus einem künftigen Termin (?termin=) oder ohne
 * Termin für eine Person (?patient=). Wird später auf die Rechnung bzw. Sammelrechnung angerechnet. Für erbrachte
 * Behandlungen (Termin heute/früher, Doku-Eintrag) gibt es die Quittung – createDeposit lehnt dort ab.
 */
export default async function DepositPage(props: PageProps<"/rechnungen/anzahlung">) {
  const auth = await requireAuth("invoices.write");
  const sp = await props.searchParams;
  const termin = str(sp.termin);
  const behandlung = str(sp.behandlung);
  const src = termin || behandlung ? await billingFromSource(auth, { appointmentId: termin, recordId: behandlung }) : null;
  // archivierte Person bzw. gelöschte Kontaktdaten: keine Anzahlung (wie depositPatient/createDeposit)
  const srcPatientActive = src?.patient ? !!(await depositPatient(auth, src.patient.id)) : true;
  const smallBusiness = auth.organization.smallBusiness;
  const today = berlinDateIso();
  const patientParam = str(sp.patient);
  const chosen = termin || behandlung ? null : await depositPatient(auth, patientParam);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Anzahlung (Vorauszahlung)" subtitle="Zahlung vor der Behandlung annehmen – wird später auf die Rechnung bzw. Sammelrechnung angerechnet" />
      <p className="mb-6 flex gap-2 rounded-xl bg-info-soft p-3 text-sm text-info-soft-text">
        <Info size={18} className="mt-0.5 shrink-0" aria-hidden />
        <span>{DEPOSIT_PURPOSE_HINT}</span>
      </p>
      {termin || behandlung ? (
        !src ? (
          <Card><p className="text-sm text-danger">Termin bzw. Behandlung nicht gefunden.</p></Card>
        ) : !src.patient ? (
          <Card><p className="text-sm text-danger">{src.error}</p></Card>
        ) : !srcPatientActive ? (
          <Card><p className="text-sm text-danger">{src.patient.name} ist archiviert – keine Anzahlung möglich.</p></Card>
        ) : src.appointmentStatus === "cancelled" || src.appointmentStatus === "no_show" ? (
          <Card><p className="text-sm text-danger">Der Termin am {dateDe(src.at)} ist abgesagt bzw. versäumt – keine Anzahlung möglich.</p></Card>
        ) : !depositAllowed({ appointmentDay: berlinDateIso(src.at), today, hasRecord: !!src.recordId, appointmentStatus: src.appointmentStatus }) ? (
          <Card>
            <p className="text-sm font-semibold">
              {src.patient.name} · Behandlung am {dateDe(src.at)}: {DEPOSIT_PAST_ERROR}
            </p>
            {src.billedBy.length ? (
              <p className="mt-2 text-sm text-muted">Bereits abgerechnet: {src.billedBy.map((d) => `${INVOICE_KIND_LABEL[d.kind]} ${d.number}`).join(", ")}.</p>
            ) : (
              <div className="mt-3">
                <LinkButton href={src.appointmentId && !behandlung ? `/rechnungen/neu?termin=${src.appointmentId}&art=quittung` : `/rechnungen/neu?behandlung=${src.recordId}&art=quittung`}>
                  <Receipt size={18} aria-hidden /> Quittung erstellen
                </LinkButton>
              </div>
            )}
          </Card>
        ) : (
          <>
            <Card className="mb-6">
              <p className="flex items-center gap-2 font-display text-lg font-semibold">
                <Receipt size={20} aria-hidden /> {src.patient.name} · Termin am {dateDe(src.at)}
              </p>
              <p className="mt-1 text-sm text-muted">
                Die Patient:in erhält jetzt eine Quittung über die Anzahlung. Die Leistung selbst steht später auf der Rechnung bzw. Sammelrechnung; dort wird die Anzahlung abgezogen.
              </p>
              {src.billedBy.length ? (
                <p className="mt-2 text-sm font-semibold text-danger">
                  Achtung: Diese Behandlung ist bereits abgerechnet ({src.billedBy.map((d) => `${INVOICE_KIND_LABEL[d.kind]} ${d.number}`).join(", ")}). Eine Zahlung dazu bitte dort erfassen.
                </p>
              ) : null}
              {src.documents.some((d) => d.kind === "deposit" && d.status !== "cancelled") ? (
                <p className="mt-2 text-sm">
                  Bereits angezahlt:{" "}
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
            {src.billedBy.length || src.documents.some((d) => d.kind === "deposit" && d.status === "paid" && !d.collectiveInvoiceId) ? (
              <Card>
                <p className="text-sm font-semibold">Für diesen Termin gibt es bereits eine Anzahlung bzw. Rechnung (siehe oben) – eine zweite Anzahlung ist nicht möglich.</p>
              </Card>
            ) : (
              <DepositForm
                smallBusiness={smallBusiness}
                tseTestMode={fiscalIsTestMode()}
                defaults={{
                  patientId: src.patient.id,
                  appointmentId: src.appointmentId,
                  treatmentRecordId: null,
                  description: `Anzahlung: Behandlung am ${dateDe(src.at)}${
                    src.lines.some((l) => l.serviceId) ? ` (${src.lines.filter((l) => l.serviceId).map((l) => l.description.replace(/^\d{2}\.\d{2}\.\d{4}: /, "")).join(", ")})` : ""
                  }`.slice(0, 300),
                  amount: src.estimateCents ? euro(src.estimateCents) : "",
                  vatRate: src.lines[0]?.vatRate ?? 0,
                }}
              />
            )}
          </>
        )
      ) : chosen ? (
        <>
          <Card className="mb-6">
            <p className="flex items-center gap-2 font-display text-lg font-semibold">
              <Receipt size={20} aria-hidden /> {chosen.name} · Anzahlung ohne Termin
            </p>
            <p className="mt-1 text-sm text-muted">
              Die Patient:in erhält jetzt eine Quittung über die Anzahlung. Bei der späteren Rechnung bzw. Sammelrechnung wählen Sie die Anzahlung zur Anrechnung aus.{" "}
              <Link href="/rechnungen/anzahlung" className="font-semibold text-primary">Andere Person</Link>
            </p>
          </Card>
          <DepositForm
            smallBusiness={smallBusiness}
            tseTestMode={fiscalIsTestMode()}
            descriptionPlaceholder="z. B. Nagelspange"
            defaults={{ patientId: chosen.id, appointmentId: null, treatmentRecordId: null, description: "", amount: "", vatRate: 0 }}
          />
        </>
      ) : (
        <Card>
          {patientParam ? <p className="mb-3 text-sm text-danger">Patient:in nicht gefunden.</p> : null}
          <p className="mb-4 text-sm text-muted">
            Am einfachsten aus einem künftigen Termin heraus (Kalender → Termin → „Anzahlung (Vorauszahlung)“). Ohne Termin hier die Patient:in suchen und auswählen:
          </p>
          <PatientPicker hrefPrefix="/rechnungen/anzahlung?patient=" label="Patient:in für die Anzahlung suchen" />
        </Card>
      )}
    </div>
  );
}
