import { Card } from "@/components/ui";
import { art14Text } from "@/lib/vertrieb/dsgvo";
import { requirePlatformAdmin } from "@/server/platform";
import { Art14Editor } from "./art14-editor";

export const metadata = { title: "Datenschutzhinweis · Vertrieb" };

export default async function Art14Page() {
  await requirePlatformAdmin();
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <Card className="text-sm">
        <h2 className="font-display text-xl font-semibold">Datenschutzhinweis nach Art. 14 DSGVO</h2>
        <p className="mt-3">
          Vorlage für den ersten Kontakt per Brief an eine Praxis, deren Daten aus öffentlichen Quellen stammen (OpenStreetMap, Impressum).
          Der Brief muss spätestens einen Monat nach dem Abruf der Daten bei der Praxis sein (Art. 14 Abs. 3 DSGVO). In der Detailansicht
          einer Praxis sind Quelle, Abrufdatum und Löschdatum bereits eingesetzt.
        </p>
      </Card>
      <Card>
        <Art14Editor template={art14Text()} filename="datenschutzhinweis-art14-vorlage.txt" />
      </Card>
    </div>
  );
}
