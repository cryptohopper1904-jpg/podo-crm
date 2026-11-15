"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Badge, Button, FormError, FormSuccess } from "@/components/ui";
import { keepValues } from "@/lib/forms";
import { money } from "@/lib/format";
import type { UebernahmePreview, UebernahmeState } from "./uebernahme-actions";

const STATUS: Record<string, { label: string; tone: "primary" | "info" | "warn" | "neutral" }> = {
  import: { label: "wird übernommen", tone: "primary" },
  info: { label: "nur Info", tone: "info" },
  rejected: { label: "nicht übernommen", tone: "warn" },
  duplicate: { label: "doppelt", tone: "neutral" },
};

function Steps({ step }: { step: 1 | 2 | 3 }) {
  const items = ["Dateien wählen", "Vorschau prüfen", "Übernehmen"];
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Schritte">
      {items.map((t, i) => (
        <li key={t} aria-current={step === i + 1 ? "step" : undefined} className={step === i + 1 ? "font-semibold text-primary" : "text-muted"}>
          {i + 1}. {t}
        </li>
      ))}
    </ol>
  );
}

function Line({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 border-b border-border py-1.5 last:border-0 ${muted ? "text-muted" : ""}`}>
      <dt>{label}</dt>
      <dd className="text-right font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Preview({ p }: { p: UebernahmePreview }) {
  const t = p.totals;
  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="ueb-files">
        <h3 id="ueb-files" className="mb-2 font-semibold">Erkannte Dateien</h3>
        <ul className="flex flex-col gap-2">
          {p.files.map((f, i) => (
            <li key={i} className="rounded-xl border border-border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{f.name}</span>
                <Badge tone={STATUS[f.status].tone}>{STATUS[f.status].label}</Badge>
              </div>
              <p className="mt-1 text-muted">
                {f.label}
                {f.status !== "rejected" && f.records ? ` · ${f.records} Datensätze` : ""}
                {f.status === "import" || f.status === "info" ? ` → ${f.target}` : ""}
              </p>
              {f.note ? <p className="mt-1">{f.note}</p> : null}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="ueb-sum" className="grid gap-4 md:grid-cols-2">
        <h3 id="ueb-sum" className="sr-only">Zusammenfassung</h3>
        <dl className="rounded-xl bg-surface-2 p-4 text-sm">
          <Line label="Patient:innen neu" value={t.patientsNew} />
          <Line label="mit vorhandenen verknüpft" value={t.patientsLinked} />
          <Line label="schon übernommen" value={t.patientsExisting} muted />
          <Line label="Termine neu" value={t.appointmentsNew} />
          <Line label="Termine schon übernommen / nicht zuordenbar" value={`${t.appointmentsExisting} / ${t.appointmentsUnassigned}`} muted />
        </dl>
        <dl className="rounded-xl bg-surface-2 p-4 text-sm">
          <Line label="Verordnungen neu" value={t.prescriptionsNew} />
          <Line label="Verordnungen schon übernommen / nicht zuordenbar" value={`${t.prescriptionsExisting} / ${t.prescriptionsUnassigned}`} muted />
          <Line label="Rechnungs-PDFs als Dokument" value={t.documentsNew} />
          <Line label="PDFs schon da / nicht zuordenbar" value={`${t.documentsExisting} / ${t.documentsUnassigned}`} muted />
          <Line label="Fremd-Rechnungen (nur Info)" value={t.invoicesInfo} muted />
        </dl>
        {t.excel ? (
          <dl className="rounded-xl bg-surface-2 p-4 text-sm md:col-span-2">
            <Line label="Excel: Patient:innen neu / schon übernommen" value={`${t.excel.patientsNew} / ${t.excel.patientsExisting}`} />
            <Line label="Excel: Leistungen, Gutscheine, Rechnungen, Fixkosten" value={`${t.excel.services}, ${t.excel.vouchers}, ${t.excel.invoices}, ${t.excel.fixedCosts}`} />
          </dl>
        ) : null}
      </section>

      {p.cashbook ? (
        <p className="rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">
          Kassenbuch erkannt ({p.cashbook.rows} Buchungen{p.cashbook.lastDate ? `, bis ${p.cashbook.lastDate.split("-").reverse().join(".")}` : ""}). Es wird nicht nachgebucht.
          {p.cashbook.lastBalanceCents !== null ? ` Letzter Kassenbestand: ${money(p.cashbook.lastBalanceCents)} – trage ihn unter Kasse als Anfangsbestand ein.` : ""}
        </p>
      ) : null}

      {[...p.samples.patients, ...p.samples.appointments, ...p.samples.prescriptions, ...p.samples.documents].length ? (
        <section aria-labelledby="ueb-samples" className="text-sm">
          <h3 id="ueb-samples" className="mb-1 font-semibold">Beispiele (pseudonymisiert)</h3>
          <ul className="list-disc pl-5">
            {p.samples.patients.map((s, i) => <li key={`p${i}`}>Patient:in {s}</li>)}
            {p.samples.appointments.map((s, i) => <li key={`a${i}`}>Termin {s}</li>)}
            {p.samples.prescriptions.map((s, i) => <li key={`v${i}`}>Verordnung {s}</li>)}
            {p.samples.documents.map((s, i) => <li key={`d${i}`}>Dokument {s}</li>)}
          </ul>
        </section>
      ) : null}

      {p.warnings.length ? (
        <section aria-labelledby="ueb-warn" className="text-sm">
          <h3 id="ueb-warn" className="mb-1 font-semibold">
            Hinweise ({p.warningsTotal}{p.warningsTotal > p.warnings.length ? `, die ersten ${p.warnings.length}` : ""})
          </h3>
          <ul className="max-h-80 list-disc overflow-y-auto pl-5">
            {p.warnings.map((w, i) => (
              <li key={i}>
                {w.file || w.row ? <span className="text-muted">{[w.file?.split("/").pop(), w.row ? `Zeile ${w.row}` : null].filter(Boolean).join(" · ")}: </span> : null}
                {w.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function UebernahmeForm({ action }: { action: (s: UebernahmeState, f: FormData) => Promise<UebernahmeState> }) {
  const [state, run, pending] = useActionState(action, undefined);
  const p = state?.preview;
  const r = state?.result;
  const step = r ? 3 : p ? 2 : 1;
  return (
    <form onSubmit={keepValues(run)} className="flex flex-col gap-4">
      <Steps step={step} />
      <FormError message={state?.error} revealKey={state} />
      <FormSuccess message={state?.ok} focus />
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Exportdateien deiner bisherigen Software (mehrere möglich, auch ZIP)
        <input
          type="file"
          name="files"
          multiple
          required
          accept=".csv,.txt,.xlsx,.zip,.pdf,text/csv,application/zip,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="text-sm font-normal file:mr-3 file:h-11 file:rounded-xl file:border file:border-border file:bg-surface file:px-4 file:font-semibold"
        />
      </label>
      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="mb-1 font-medium">Übernommene Verordnungen</legend>
        <label className="flex items-start gap-2">
          <input type="radio" name="prescriptionMode" value="billed" defaultChecked className="mt-1 size-4" />
          <span>als <strong>abgerechnet</strong> markieren (empfohlen, wenn deine bisherige Software bzw. dein Abrechnungszentrum sie schon abgerechnet hat – keine doppelte Abrechnung)</span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name="prescriptionMode" value="active" className="mt-1 size-4" />
          <span>als <strong>laufend</strong> übernehmen (noch nicht abgerechnet, du rechnest sie in PodoHero ab)</span>
        </label>
      </fieldset>
      {state?.previewToken ? <input type="hidden" name="previewToken" value={state.previewToken} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="intent" value="preview" variant="secondary" disabled={pending}>
          {pending ? "Wird geprüft …" : p ? "Erneut prüfen" : "Dateien prüfen"}
        </Button>
        {p?.hasWork && state?.previewToken ? (
          <Button type="submit" name="intent" value="run" disabled={pending}>
            Import ausführen
          </Button>
        ) : null}
      </div>
      {p && !r ? (
        <>
          <p className="text-sm text-muted">Vorschau – noch nichts gespeichert. Der Import ergänzt nur: Er löscht und überschreibt nichts und legt beim erneuten Hochladen nichts doppelt an.</p>
          {!p.hasWork ? <p className="text-sm font-medium">Nichts Neues zu übernehmen.</p> : null}
          <Preview p={p} />
        </>
      ) : null}
      {r ? (
        <div className="flex flex-col gap-2 text-sm">
          <p>
            Angelegt: {r.patientsCreated} Patient:innen, {r.appointments} Termine, {r.prescriptions} Verordnungen, {r.documents} Dokumente
            {r.patientsLinked ? `; ${r.patientsLinked} vorhandene Patient:innen verknüpft` : ""}.
            {r.excel ? ` Excel: ${r.excel.patients} Patient:innen, ${r.excel.services} Leistungen, ${r.excel.vouchers} Gutscheine, ${r.excel.invoices} Rechnungen, ${r.excel.fixedCosts} Fixkosten.` : ""}
          </p>
          <p className="flex flex-wrap gap-x-4 gap-y-1">
            <Link href="/kunden" className="font-semibold text-primary">Zu den Patient:innen</Link>
            <Link href="/kalender" className="font-semibold text-primary">Zum Kalender</Link>
          </p>
        </div>
      ) : null}
    </form>
  );
}
