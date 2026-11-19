import { Card } from "@/components/ui";
import { berlinDateIso } from "@/lib/format";
import { CSV_MAX_ROWS } from "@/lib/vertrieb/csv";
import { requirePlatformAdmin } from "@/server/platform";
import { CsvImport } from "./csv-import";

export const metadata = { title: "CSV-Import · Vertrieb" };

export default async function ImportPage() {
  await requirePlatformAdmin();
  return (
    <div className="flex flex-col gap-5">
      <Card className="text-sm">
        <h2 className="font-display text-xl font-semibold">CSV-Import</h2>
        <p className="mt-2">
          UTF-8, Trennzeichen <code>;</code> oder <code>,</code>, erste Zeile = Spaltennamen. Spalten:{" "}
          <code>name,email,phone,website,street,zip,city,distance_km,source,notes</code> (optional zusätzlich <code>contact_person</code> und <code>retrieved_at</code> = Abrufdatum). Pflicht in der Datei ist nur <code>name</code>; Quelle und Abrufdatum geben Sie unten für den ganzen Import an.
          Höchstens {CSV_MAX_ROWS} Zeilen bzw. 1 MB.
        </p>
        <p className="mt-2 text-muted">
          Dubletten (gleiche E-Mail ohne Groß/Klein, oder gleicher Name + PLZ) und Adressen auf der Sperrliste werden übersprungen. Erst die Vorschau, dann „Importieren“.
        </p>
      </Card>
      <CsvImport today={berlinDateIso()} />
    </div>
  );
}
