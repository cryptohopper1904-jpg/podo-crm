import { PageHeader } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { invoiceFormData } from "@/server/invoices";
import { InvoiceForm } from "../invoice-form";

export const metadata = { title: "Neue Rechnung" };

export default async function NewInvoicePage(props: PageProps<"/rechnungen/neu">) {
  const auth = await requireAuth("invoices.write");
  const sp = await props.searchParams;
  const patient = typeof sp.patient === "string" ? sp.patient : null;
  const data = await invoiceFormData(auth, patient);
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Neue Rechnung" subtitle="Rechnung, Quittung, Sammelrechnung oder Ausfallhonorar" />
      <InvoiceForm {...data} preselectPatientId={patient} />
    </div>
  );
}
