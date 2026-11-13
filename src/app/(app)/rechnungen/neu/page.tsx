import Link from "next/link";
import { Building2, CalendarCheck, Info } from "lucide-react";
import { Button, Card, Field, Input, PageHeader, Select } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { isPrivateOnly } from "@/lib/features";
import { berlinDateIso, dateDe, money } from "@/lib/format";
import { INVOICE_KIND_LABEL } from "@/lib/invoice-labels";
import { parseYear } from "@/lib/year-end";
import { billingFromSource, patientYearSuggestion } from "@/server/appointment-billing";
import { careHomes, collectiveSuggestion } from "@/server/invoice-delivery";
import { invoiceFormData } from "@/server/invoices";
import { travelSuggestions } from "@/server/trips";
import { InvoiceForm, type InvoicePreset } from "../invoice-form";

export const metadata = { title: "Neue Rechnung" };

const prevMonth = () => {
  const [y, m] = berlinDateIso().split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};
const str = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : null);

/**
 * Neue Rechnung. Vorlagen über Suchparameter:
 *  - ?termin=<id> bzw. ?behandlung=<id>: Rechnung aus Termin/Doku-Eintrag (Leistungen vorausgefüllt)
 *  - ?sammel=<kunde>&jahr=2026: Sammelrechnung einer Patient:in über das Jahr (Anzahlungen werden angerechnet)
 *  - ?pflegeheim=<id>&monat=2026-10: Sammelrechnung Pflegeheim
 */
export default async function NewInvoicePage(props: PageProps<"/rechnungen/neu">) {
  const auth = await requireAuth("invoices.write");
  const sp = await props.searchParams;
  const termin = str(sp.termin);
  const behandlung = str(sp.behandlung);
  const sammel = str(sp.sammel);
  const year = parseYear(sp.jahr, Number(berlinDateIso().slice(0, 4)));
  const careHomeId = str(sp.pflegeheim);
  const month = typeof sp.monat === "string" && /^\d{4}-\d{2}$/.test(sp.monat) ? sp.monat : prevMonth();

  const source = termin || behandlung ? await billingFromSource(auth, { appointmentId: termin, recordId: behandlung }) : null;
  const yearSug = !source && sammel ? await patientYearSuggestion(auth, sammel, year) : null;
  const suggestion = !source && !yearSug && careHomeId ? await collectiveSuggestion(auth, careHomeId, month) : null;
  const presetPatient = source?.patient?.id ?? yearSug?.patient.id ?? null;
  const patient = presetPatient ?? str(sp.patient);

  const data = await invoiceFormData(auth, patient, year);
  const homes = source || yearSug ? [] : await careHomes(auth);
  const travel = patient ? await travelSuggestions(auth, patient) : null;

  let preset: InvoicePreset | undefined;
  let presetKey = "plain";
  if (source?.patient) {
    // Leistungsdatum steht über den Termin-/Doku-Bezug in der Überschrift („Rechnung zur Behandlung am …“)
    preset = { kind: "invoice", patientId: source.patient.id, lines: source.lines };
    presetKey = `src-${source.appointmentId ?? source.recordId}`;
  } else if (yearSug) {
    const first = yearSug.lines.length ? yearSug.lines[0].description.slice(0, 10) : null;
    const last = yearSug.lines.length ? yearSug.lines.at(-1)!.description.slice(0, 10) : null;
    preset = {
      kind: "collective",
      patientId: yearSug.patient.id,
      billingContactId: yearSug.patient.billingContactId,
      notes: `Sammelrechnung ${year}${first && last ? ` – Behandlungen vom ${first} bis ${last}` : ""}`,
      lines: yearSug.lines,
    };
    presetKey = `year-${yearSug.patient.id}-${year}`;
  } else if (suggestion) {
    preset = {
      kind: "collective",
      billingContactId: suggestion.contact.id,
      notes: `Sammelrechnung ${suggestion.contact.name}, Behandlungszeitraum ${month.slice(5)}/${month.slice(0, 4)}`,
      lines: suggestion.lines,
    };
    presetKey = `${suggestion.contact.id}-${month}`;
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Neue Rechnung" subtitle="Rechnung, Quittung, Sammelrechnung oder Ausfallhonorar" />

      {termin || behandlung ? (
        <Card className="mb-6">
          {!source ? (
            <p className="text-sm text-danger">Termin bzw. Behandlung nicht gefunden.</p>
          ) : !source.patient ? (
            <p className="text-sm text-danger">{source.error}</p>
          ) : (
            <div className="flex flex-col gap-2 text-sm">
              <p className="flex items-center gap-2 font-display text-lg font-semibold">
                <CalendarCheck size={20} aria-hidden /> Rechnung zur Behandlung am {dateDe(source.at)} – {source.patient.name}
              </p>
              <p className="text-muted">
                Mit den Leistungen des Termins vorausgefüllt. Weitere Positionen (z. B. Pflegeprodukte, Wegegeld) ergänzen Sie unten mit „+ Position“ – erst „ausstellen“ macht die Rechnung endgültig.
              </p>
              {source.billedBy.length ? (
                <p className="font-semibold text-danger">
                  Bereits abgerechnet in {source.billedBy.map((d) => `${INVOICE_KIND_LABEL[d.kind]} ${d.number}`).join(", ")} – eine zweite Rechnung zu dieser Behandlung ist nicht möglich.
                </p>
              ) : null}
              {source.prescription ? (
                <p className="flex gap-2 rounded-xl bg-info-soft p-3 text-info-soft-text">
                  <Info size={18} className="mt-0.5 shrink-0" aria-hidden /> Behandlung auf Verordnung – die Leistung selbst rechnen Sie mit der Krankenkasse ab. Hier nur Zusatzleistungen berechnen.
                </p>
              ) : null}
            </div>
          )}
        </Card>
      ) : null}

      {sammel ? (
        <Card className="mb-6">
          {!yearSug ? (
            <p className="text-sm text-danger">Patient:in nicht gefunden.</p>
          ) : (
            <div className="flex flex-col gap-2 text-sm">
              <p className="flex items-center gap-2 font-display text-lg font-semibold">
                <CalendarCheck size={20} aria-hidden /> Sammelrechnung {year} – {yearSug.patient.name}
              </p>
              <p className="text-muted">
                {yearSug.items} noch nicht abgerechnete Behandlung(en) als Positionen vorgeschlagen
                {yearSug.skipped ? `, ${yearSug.skipped} bereits abgerechnet (übersprungen)` : ""}.
                {yearSug.deposits.length
                  ? ` ${yearSug.deposits.length} Anzahlung(en) über ${money(yearSug.deposits.reduce((s, d) => s + d.totalCents, 0))} werden angerechnet.`
                  : ""}{" "}
                Bitte prüfen – Positionen ohne Preis ergänzen.
              </p>
              {!yearSug.lines.length ? <p className="font-semibold">Keine offenen Behandlungen gefunden – bitte die Positionen selbst eintragen.</p> : null}
              <Link href={`/rechnungen/sammelrechnungen?jahr=${year}`} className="self-start font-semibold text-primary">← Übersicht Sammelrechnungen {year}</Link>
            </div>
          )}
        </Card>
      ) : null}

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
      <InvoiceForm key={presetKey} {...data} preselectPatientId={patient} preset={preset} travel={travel} privateOnly={isPrivateOnly(auth.organization)} />
    </div>
  );
}
