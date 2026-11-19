import { Card } from "@/components/ui";
import { art14Text, ART14_DRAFT_MARK } from "@/lib/vertrieb/dsgvo";
import { requirePlatformAdmin } from "@/server/platform";
import { CopyButton } from "../aktionscodes/copy-button";
import { Art14Download } from "./art14-download";

export const metadata = { title: "Datenschutzhinweis · Vertrieb" };

export default async function Art14Page() {
  await requirePlatformAdmin();
  const text = art14Text();
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <Card className="text-sm">
        <h2 className="font-display text-xl font-semibold">Datenschutzhinweis nach Art. 14 DSGVO</h2>
        <p role="note" className="mt-3 rounded-xl border-2 border-warn-soft-text/40 bg-warn-soft px-4 py-3 font-semibold text-warn-soft-text">{ART14_DRAFT_MARK}</p>
        <p className="mt-3">
          Vorlage für den ersten Kontakt per Brief an eine Praxis, deren Daten aus öffentlichen Quellen stammen (OpenStreetMap, Impressum).
          Platzhalter in {"{{…}}"} vor dem Versand ersetzen. In der Detailansicht einer Praxis sind Quelle, Abrufdatum und Löschdatum bereits eingesetzt.
        </p>
        <div className="mt-3 flex flex-wrap gap-4">
          <CopyButton text={text} label="Text" />
          <Art14Download text={text} filename="datenschutzhinweis-art14-vorlage.txt" />
        </div>
      </Card>
      <Card>
        <pre className="whitespace-pre-wrap font-sans text-[14px] leading-relaxed">{text}</pre>
      </Card>
    </div>
  );
}
