import { Download } from "lucide-react";
import { Card, CardTitle } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { doctolibImportAction, excelImportAction } from "./actions";
import { DoctolibImportForm, ExcelImportForm } from "./import-forms";

export const metadata = { title: "Import" };

export default async function ImportSettings() {
  const auth = await requireAuth("import.run");
  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">
        Hochgeladene Dateien werden nur im Arbeitsspeicher verarbeitet und nicht gespeichert. Zuerst prüfen, dann importieren –
        der Import läuft in einem Schritt und wird bei einem Fehler vollständig zurückgenommen.
      </p>
      <Card>
        <CardTitle>Excel „Podologie Rechnungsmanager“</CardTitle>
        <p className="mb-4 text-sm text-muted">
          Übernimmt die Blätter Patienten, Leistungen, Gutscheine, Rechnungen und Kalkulation (Fixkosten). Alte Rechnungen werden mit ihrer
          ursprünglichen Nummer als ausgestellt bzw. bezahlt übernommen; die Nummernkreise laufen danach lückenlos weiter.
        </p>
        <ExcelImportForm action={excelImportAction} />
      </Card>
      <Card>
        <CardTitle>Doctolib – Patientenliste (CSV)</CardTitle>
        <p className="mb-4 text-sm text-muted">
          Patientenexport aus Doctolib (22 Spalten). Bereits importierte Personen (gleiche Doctolib-ID) werden übersprungen.
        </p>
        <DoctolibImportForm action={doctolibImportAction} />
      </Card>
      {auth.can("patients.read") ? (
        <Card>
          <CardTitle>Export für Doctolib</CardTitle>
          <p className="mb-4 text-sm text-muted">Alle aktiven Kund:innen im Doctolib-Importformat (CSV). Der Export wird protokolliert.</p>
          <a
            href="/api/export/doctolib"
            className="inline-flex h-11 items-center gap-2 rounded-xl border border-border bg-surface px-4 text-[15px] font-semibold hover:bg-surface-2"
          >
            <Download size={18} aria-hidden /> CSV herunterladen
          </a>
        </Card>
      ) : null}
    </div>
  );
}
