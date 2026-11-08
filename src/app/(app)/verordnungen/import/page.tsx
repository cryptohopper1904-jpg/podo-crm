import { PageHeader } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { EverordnungImport } from "./import-form";

export const metadata = { title: "eVerordnung importieren" };

export default async function EverordnungImportPage() {
  const auth = await requireAuth("medical.write");
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="eVerordnung importieren" subtitle="Heilmittel-Verordnung als FHIR-Datei (JSON) übernehmen" />
      <p className="mb-4 rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">
        Die Heilmittel-eVerordnung ist laut gematik geplant, aber noch nicht überall verfügbar – Stand prüfen. Der Import liest FHIR-Bundles in
        KBV-ähnlicher Struktur; die finalen Profile können abweichen. Bitte jede Vorschau mit der Verordnung vergleichen. Der Abruf direkt aus der
        TI (E-Rezept-Fachdienst) ist nicht Teil von PodoCRM – die Datei kommt aus Ihrem TI-Zugang bzw. vom Anbieter.
      </p>
      <EverordnungImport canCreatePatient={auth.can("patients.write")} />
    </div>
  );
}
