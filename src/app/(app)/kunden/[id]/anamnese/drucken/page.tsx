import Link from "next/link";
import { notFound } from "next/navigation";
import { PrintButton } from "@/components/print-button";
import { SheetHeader } from "@/components/sheet-header";
import { requireAuth } from "@/lib/auth/session";
import { ANAMNESIS_PAPER, anamnesisSummary } from "@/lib/anamnesis";
import { dateDe, dateTimeDe, fullName, timeDe } from "@/lib/format";
import { anamnesisSheet } from "@/server/anamnesis";
import { BackLink } from "@/components/ui";

export const metadata = { title: "Anamnesebogen drucken" };

const PRINT_CSS = `
@page { size: A4; margin: 14mm 16mm; }
@media print {
  main { padding: 0 !important; }
  .sheet { border: 0 !important; padding: 0 !important; max-width: none !important; }
  .sheet, .sheet * { color: #000 !important; background: transparent !important; border-color: #999 !important; }
}`;

/**
 * Druckfassung/PDF des Anamnesebogens mit demselben Kopf wie am iPad (Datum, Patient, Nummer, Logo):
 * ausgefüllt mit der aktuellen Version oder – mit ?leer=1 bzw. ohne Anamnese – als leerer Papierbogen.
 */
export default async function AnamnesisPrintPage(props: PageProps<"/kunden/[id]/anamnese/drucken">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const auth = await requireAuth("medical.read");
  const data = await anamnesisSheet(auth, id, { mode: "print", appointmentId: typeof sp.termin === "string" ? sp.termin : null });
  if (!data) notFound();
  const { patient: p, appointment, latest } = data;
  const blank = sp.leer === "1" || !latest;
  const day = blank ? (appointment?.startsAt ?? new Date()) : latest!.createdAt;
  return (
    <div className="mx-auto max-w-4xl">
      <style>{PRINT_CSS}</style>
      <div className="no-print mb-4 flex flex-wrap items-center gap-3">
        <BackLink href={`/kunden/${id}/anamnese`} label="Anamnese" />
        <PrintButton />
        {latest ? (
          blank ? (
            <Link href={`/kunden/${id}/anamnese/drucken`} className="text-sm font-semibold text-primary">Aktuelle Anamnese drucken</Link>
          ) : (
            <Link href={`/kunden/${id}/anamnese/drucken?leer=1`} className="text-sm font-semibold text-primary">Leeren Bogen drucken</Link>
          )
        ) : null}
      </div>
      <article className="sheet rounded-[var(--radius-card)] border border-border bg-surface p-6 text-[14px] leading-relaxed sm:p-10">
        <SheetHeader
          organizationId={auth.organization.id}
          practiceName={auth.organization.name}
          title="Anamnesebogen"
          fields={[
            ["Datum", dateDe(day) + (blank && appointment ? ` · ${timeDe(appointment.startsAt)} Uhr` : "")],
            ["Patient:in", fullName(p)],
            ["Patientennummer", String(p.number)],
            ["Geburtsdatum", p.birthDate ? dateDe(p.birthDate) : null],
          ]}
        />
        {blank ? (
          <div className="flex flex-col gap-5">
            {ANAMNESIS_PAPER.map((s) => (
              <section key={s.section} className="break-inside-avoid">
                <h2 className="mb-2 font-display text-lg font-semibold">{s.section}</h2>
                <ul className="flex flex-col">
                  {s.yesNo.map((q) => (
                    <li key={q} className="flex items-center gap-4 border-b border-border py-1.5">
                      <span className="flex-1">{q}</span>
                      <span className="whitespace-nowrap">☐ ja&nbsp;&nbsp;☐ nein</span>
                    </li>
                  ))}
                  {s.text.map((q) => (
                    <li key={q} className="border-b border-border pb-1 pt-3">
                      <span className="text-sm text-muted">{q}</span>
                      <div className="h-6" />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted">
              Stand {dateTimeDe(latest!.createdAt)} · {latest!.source === "online" ? "online vom Patienten angegeben (ungeprüft)" : `erfasst von ${latest!.author ?? "Praxis"}`}
            </p>
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {anamnesisSummary(latest!.data).map(([k, v]) => (
                <div key={k} className={`break-inside-avoid border-b border-border pb-1 ${k === "Medikamente" || k === "Notizen" ? "sm:col-span-2" : ""}`}>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{k}</dt>
                  <dd className="whitespace-pre-wrap">{v}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
        <p className="mt-6 text-sm">Ich habe die Angaben nach bestem Wissen gemacht und informiere die Praxis über Änderungen.</p>
        <div className="mt-10 grid grid-cols-2 gap-10 text-sm">
          <div className="border-t border-border-strong pt-1">Ort, Datum / Unterschrift Patient:in</div>
          <div className="border-t border-border-strong pt-1">Unterschrift Podolog:in</div>
        </div>
      </article>
    </div>
  );
}
