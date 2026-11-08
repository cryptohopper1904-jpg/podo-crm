import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { Button, Field, Input } from "@/components/ui";
import { PrintButton } from "@/components/print-button";
import { dateDe } from "@/lib/format";
import { getBatchByCode } from "@/server/hygiene";
import { canViewHygiene, requireHygiene } from "../../../access";
import { codeFromParam } from "../../code-param";

export const metadata = { title: "Sterilgut-Etikett" };

/**
 * Druckbare Etiketten: Chargennummer als Text + QR-Code (serverseitig als SVG erzeugt).
 * Der QR-Code enthält nur die Chargennummer – so liest ihn der Scanner im Doku-Formular direkt ein.
 */
export default async function BatchLabelPage(props: PageProps<"/hygiene/charge/[code]/etikett">) {
  const auth = await requireHygiene(canViewHygiene);
  const code = codeFromParam((await props.params).code);
  if (!code) notFound();
  const batch = await getBatchByCode(auth.organization.id, code);
  if (!batch) notFound();
  const sp = await props.searchParams;
  const n = Math.min(60, Math.max(1, Number.parseInt(typeof sp.n === "string" ? sp.n : "1", 10) || 1));
  // qrcode erzeugt reines SVG aus Pfaden (keine Eingabe-Texte im Markup)
  const svg = await QRCode.toString(batch.b.code, { type: "svg", errorCorrectionLevel: "M", margin: 1 });

  return (
    <div>
      <div className="no-print mb-6 flex flex-wrap items-end gap-3">
        <p className="w-full text-sm text-muted">
          <Link href={`/hygiene/charge/${encodeURIComponent(batch.b.code)}`} className="underline">zurück zur Charge</Link>
          {batch.b.result !== "released" ? " · Hinweis: Charge ist noch nicht freigegeben bzw. gesperrt." : ""}
        </p>
        <form method="get" className="flex items-end gap-2">
          <Field label="Anzahl Etiketten">
            <Input type="number" name="n" min={1} max={60} defaultValue={n} className="w-28" />
          </Field>
          <Button type="submit" variant="secondary">Übernehmen</Button>
        </form>
        <PrintButton label="Etiketten drucken" />
      </div>
      <div className="flex flex-wrap gap-[3mm] bg-white text-black">
        {Array.from({ length: n }, (_, i) => (
          <div
            key={i}
            className="flex break-inside-avoid items-center gap-[2mm] overflow-hidden rounded border border-black/40 p-[2mm]"
            style={{ width: "62mm", height: "29mm" }}
          >
            <div className="shrink-0" style={{ width: "24mm", height: "24mm" }} aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />
            <div className="min-w-0 text-[8pt] leading-tight">
              <p className="truncate font-semibold">{auth.organization.name}</p>
              <p className="mt-[1mm] break-all font-mono text-[10pt] font-bold">{batch.b.code}</p>
              <p className="mt-[1mm]">Steril. {dateDe(batch.b.processedAt)}</p>
              {batch.b.expiresAt ? <p>verw. bis {dateDe(batch.b.expiresAt)}</p> : null}
              {batch.b.cycleNo ? <p>Zyklus {batch.b.cycleNo}</p> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
