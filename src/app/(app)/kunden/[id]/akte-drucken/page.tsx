import { notFound } from "next/navigation";
import { PrintButton } from "@/components/print-button";
import { requireAuth } from "@/lib/auth/session";
import { dateDe, dateTimeDe, fullName } from "@/lib/format";
import { getPatient } from "@/server/patients";

export const metadata = { title: "Akte drucken" };

/** Druckansicht der Patientenakte (Kopie nach § 630g BGB). */
export default async function PrintRecordPage(props: PageProps<"/kunden/[id]/akte-drucken">) {
  const { id } = await props.params;
  const auth = await requireAuth("medical.read");
  const data = await getPatient(auth, id);
  if (!data) notFound();
  const p = data.patient;
  return (
    <article className="mx-auto max-w-3xl bg-surface p-8 print:p-0">
      <div className="mb-6 flex justify-end"><PrintButton /></div>
      <h1 className="font-display text-2xl font-semibold">Behandlungsdokumentation</h1>
      <p className="text-sm text-muted">{auth.organization.name} · erstellt am {dateTimeDe(new Date())}</p>
      <section className="mt-6 text-[15px]">
        <p><strong>{fullName(p)}</strong> · geb. {dateDe(p.birthDate)} · Kunden-Nr. {p.number}</p>
        <p>{[p.street, p.zip, p.city].filter(Boolean).join(", ")}</p>
      </section>
      <section className="mt-6 flex flex-col gap-4">
        {[...data.records].reverse().map((r) => (
          <div key={r.id} className="break-inside-avoid border-t border-border pt-3">
            <p className="font-semibold">{dateTimeDe(r.treatedAt)}</p>
            {r.servicesText ? <p><strong>Behandlung:</strong> {r.servicesText}</p> : null}
            {r.findings ? <p><strong>Befund:</strong> {r.findings}</p> : null}
            {r.footPoints.length ? <p><strong>Stellen:</strong> {r.footPoints.map((f) => `${f.side === "left" ? "li" : "re"} ${f.label ?? f.point}${f.note ? ` (${f.note})` : ""}`).join("; ")}</p> : null}
            {r.material ? <p><strong>Material:</strong> {r.material}</p> : null}
            {r.sterileBatchCode ? <p><strong>Charge:</strong> {r.sterileBatchCode}</p> : null}
            {r.reaction ? <p><strong>Reaktion:</strong> {r.reaction}</p> : null}
            {r.recommendation ? <p><strong>Empfehlung:</strong> {r.recommendation}</p> : null}
            <p className="text-xs text-muted">Prüfsumme {r.hash.slice(0, 16)}</p>
          </div>
        ))}
      </section>
    </article>
  );
}
