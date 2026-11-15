import { Download } from "lucide-react";
import { Card, CardTitle } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { CONSENT_HINT, DSGVO_HINT, HELP_STAND, RETENTION_HINT, SOURCE_HELP } from "@/lib/import/uebernahme/help";
import { SUPPORTED_FORMATS } from "@/lib/import/uebernahme/detect";
import { doctolibImportAction, excelImportAction } from "./actions";
import { DoctolibImportForm, ExcelImportForm } from "./import-forms";
import { uebernahmeAction } from "./uebernahme-actions";
import { UebernahmeForm } from "./uebernahme-form";

export const metadata = { title: "Import" };

export default async function ImportSettings() {
  const auth = await requireAuth("import.run");
  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">
        Hochgeladene Dateien werden nur im Arbeitsspeicher verarbeitet und nicht gespeichert. Zuerst prüfen, dann importieren –
        der Import läuft in einem Schritt und wird bei einem Fehler vollständig zurückgenommen.
      </p>
      <Card aria-labelledby="daten-uebernehmen">
        <h2 id="daten-uebernehmen" className="mb-1 font-display text-xl font-semibold">Daten übernehmen</h2>
        <p className="mb-4 text-sm text-muted">
          Sie wechseln von einer anderen Software? Laden Sie deren Exportdateien hier hoch – auch mehrere auf einmal oder als ZIP. PodoHero erkennt jede
          Datei automatisch, zeigt Ihnen vorher, was übernommen wird, und ergänzt nur: Es wird nichts gelöscht oder überschrieben, und ein erneuter Upload
          legt nichts doppelt an.
        </p>
        <UebernahmeForm action={uebernahmeAction} />
        <details className="mt-5 text-sm">
          <summary className="cursor-pointer font-semibold">Welche Dateien werden erkannt?</summary>
          <ul className="mt-2 list-disc pl-5">{SUPPORTED_FORMATS.map((f) => <li key={f}>{f}</li>)}</ul>
        </details>
        <p className="mt-3 text-xs text-muted">{HELP_STAND}</p>
        {SOURCE_HELP.map((h) => (
          <details key={h.id} className="mt-3 text-sm">
            <summary className="cursor-pointer font-semibold">So finden Sie den Export in {h.title}</summary>
            <ol className="mt-2 list-decimal pl-5">{h.steps.map((x) => <li key={x}>{x}</li>)}</ol>
            {h.missing.length ? (
              <>
                <p className="mt-2 font-medium">Was nicht im Export ist</p>
                <ul className="list-disc pl-5">{h.missing.map((x) => <li key={x}>{x}</li>)}</ul>
              </>
            ) : null}
            {h.tips.map((x) => <p key={x} className="mt-2">{x}</p>)}
          </details>
        ))}
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-semibold">Aufbewahrung und Einwilligungen (alle Quellen)</summary>
          <p className="mt-2">{RETENTION_HINT}</p>
          <p className="mt-2">{CONSENT_HINT}</p>
        </details>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-semibold">Daten fehlen im Export? (Online-Software: {SOURCE_HELP.filter((h) => h.online).map((h) => h.title).join(", ")})</summary>
          <p className="mt-2">{DSGVO_HINT}</p>
        </details>
      </Card>
      <h2 className="mt-2 font-display text-xl font-semibold">Einzelne Datei importieren</h2>
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
          <p className="mb-4 text-sm text-muted">Alle aktiven Patient:innen im Doctolib-Importformat (CSV). Der Export wird protokolliert.</p>
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
