import Link from "next/link";
import { Building2 } from "lucide-react";
import { Button, Card, Field, Input, PageHeader, Select } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { isPrivateOnly } from "@/lib/features";
import { berlinDateIso } from "@/lib/format";
import { careHomes, collectiveSuggestion } from "@/server/invoice-delivery";
import { invoiceFormData } from "@/server/invoices";
import { travelSuggestions } from "@/server/trips";
import { InvoiceForm, type InvoicePreset } from "../invoice-form";

export const metadata = { title: "Neue Rechnung" };

const prevMonth = () => {
  const [y, m] = berlinDateIso().split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

export default async function NewInvoicePage(props: PageProps<"/rechnungen/neu">) {
  const auth = await requireAuth("invoices.write");
  const sp = await props.searchParams;
  const patient = typeof sp.patient === "string" ? sp.patient : null;
  const careHomeId = typeof sp.pflegeheim === "string" ? sp.pflegeheim : null;
  const month = typeof sp.monat === "string" && /^\d{4}-\d{2}$/.test(sp.monat) ? sp.monat : prevMonth();
  const data = await invoiceFormData(auth, patient);
  const homes = await careHomes(auth);
  const travel = patient ? await travelSuggestions(auth, patient) : null;
  const suggestion = careHomeId ? await collectiveSuggestion(auth, careHomeId, month) : null;

  const preset: InvoicePreset | undefined = suggestion
    ? {
        kind: "collective",
        billingContactId: suggestion.contact.id,
        notes: `Sammelrechnung ${suggestion.contact.name}, Behandlungszeitraum ${month.slice(5)}/${month.slice(0, 4)}`,
        lines: suggestion.lines,
      }
    : undefined;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Neue Rechnung" subtitle="Rechnung, Quittung, Sammelrechnung oder Ausfallhonorar" />
      {homes.length ? (
        <Card className="mb-6">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <h2 className="flex w-full items-center gap-2 font-display text-lg font-semibold">
              <Building2 size={20} aria-hidden /> Sammelrechnung Pflegeheim vorbereiten
            </h2>
            <Field label="Pflegeheim">
              <Select name="pflegeheim" defaultValue={suggestion?.contact.id ?? careHomeId ?? homes[0].id}>
                {homes.map((h) => (
                  <option key={h.id} value={h.id}>{h.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Monat">
              <Input type="month" name="monat" defaultValue={month} />
            </Field>
            <Button type="submit" variant="secondary">Positionen vorschlagen</Button>
            {suggestion ? (
              <Link href="/rechnungen/neu" className="inline-flex h-11 items-center px-3 text-sm font-semibold text-muted">Zurücksetzen</Link>
            ) : null}
            {suggestion ? (
              <p className="w-full text-sm text-muted">
                {suggestion.records} Behandlung(en) der Bewohner:innen im Monat gefunden, {suggestion.lines.length} Position(en) vorgeschlagen
                {suggestion.skipped ? `, ${suggestion.skipped} vermutlich bereits abgerechnet (übersprungen)` : ""}. Bitte prüfen – Positionen ohne Preis ergänzen.
              </p>
            ) : careHomeId ? (
              <p className="w-full text-sm text-danger">Pflegeheim nicht gefunden.</p>
            ) : null}
          </form>
        </Card>
      ) : null}
      <InvoiceForm key={suggestion ? `${suggestion.contact.id}-${month}` : "plain"} {...data} preselectPatientId={patient} preset={preset} travel={travel} privateOnly={isPrivateOnly(auth.organization)} />
    </div>
  );
}
