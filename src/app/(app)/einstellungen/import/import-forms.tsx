"use client";

import { keepValues } from "@/lib/forms";
import { useActionState } from "react";
import { Badge, Button, FormError, FormSuccess, Table } from "@/components/ui";
import { money } from "@/lib/format";
import type { DoctolibImportState, ExcelImportState } from "./actions";

const SHEET_LABEL: Record<string, string> = {
  Patienten: "Patienten",
  Leistungen: "Leistungen",
  Gutscheine: "Gutscheine",
  Rechnungen: "Rechnungen",
  Kalkulation: "Fixkosten",
};
const DUP_REASON: Record<string, string> = { name_birthdate: "Name + Geburtsdatum", email: "E-Mail", phone: "Telefon" };

export function ExcelImportForm({ action }: { action: (s: ExcelImportState, f: FormData) => Promise<ExcelImportState> }) {
  const [state, run, pending] = useActionState(action, undefined);
  const p = state?.preview;
  return (
    <form onSubmit={keepValues(run)} className="flex flex-col gap-4">
      <FormError message={state?.error} />
      <FormSuccess message={state?.ok} />
      <input
        type="file"
        name="file"
        required
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="text-sm file:mr-3 file:h-11 file:rounded-xl file:border file:border-border file:bg-surface file:px-4 file:font-semibold"
      />
      {state?.hash ? <input type="hidden" name="hash" value={state.hash} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="intent" value="preview" variant="secondary" disabled={pending}>{pending ? "…" : "Prüfen (Vorschau)"}</Button>
        {p ? <Button type="submit" name="intent" value="run" disabled={pending}>Import ausführen</Button> : null}
      </div>

      {p ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">Vorschau für <strong>{state?.fileName}</strong> – noch nichts gespeichert. Summe aller Rechnungen: {money(p.invoicesTotalCents)}.</p>
          <Table>
            <thead><tr><th>Blatt</th><th>Zeilen</th><th>Übernommen</th><th>Leer</th><th>Fehlerhaft</th></tr></thead>
            <tbody>
              {Object.entries(p.counts).map(([sheet, c]) => (
                <tr key={sheet}>
                  <td>{SHEET_LABEL[sheet] ?? sheet}</td>
                  <td className="tabular-nums">{c.rows}</td>
                  <td className="tabular-nums font-semibold">{c.imported}</td>
                  <td className="tabular-nums text-muted">{c.skippedEmpty}</td>
                  <td className="tabular-nums">{c.skippedInvalid ? <Badge tone="warn">{c.skippedInvalid}</Badge> : 0}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {p.collectiveParts ? <p className="text-sm">{p.collectiveParts} Einzelzeilen werden in ihre Sammelrechnungen übernommen.</p> : null}
          {p.duplicates.length ? (
            <div>
              <h3 className="mb-2 font-semibold">Mögliche Dubletten ({p.duplicates.length})</h3>
              <ul className="list-disc pl-5 text-sm">
                {p.duplicates.map((d, i) => (
                  <li key={i}>{DUP_REASON[d.reason]}: Zeilen {d.rows.join(", ")} (IDs {d.legacyIds.map((x) => x ?? "–").join(", ")}) – werden trotzdem angelegt, bitte danach zusammenführen.</li>
                ))}
              </ul>
            </div>
          ) : null}
          {p.warnings.length ? (
            <div>
              <h3 className="mb-2 font-semibold">Hinweise ({p.warningsTotal}{p.warningsTotal > p.warnings.length ? `, die ersten ${p.warnings.length}` : ""})</h3>
              <ul className="max-h-80 list-disc overflow-y-auto pl-5 text-sm">
                {p.warnings.map((w, i) => (
                  <li key={i}><span className="text-muted">{w.sheet}{w.row ? ` · Zeile ${w.row}` : ""}:</span> {w.message}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {state?.result ? (
        <div className="text-sm">
          <p>
            Angelegt: {state.result.patients} Patient:innen, {state.result.services} Leistungen, {state.result.vouchers} Gutscheine, {state.result.invoices} Rechnungen,{" "}
            {state.result.payments} Zahlungen, {state.result.fixedCosts} Fixkosten.
            {state.result.renumbered ? ` ${state.result.renumbered} Patient:innen erhielten eine neue Nummer.` : ""}
          </p>
          {state.result.sequences.length ? <p className="mt-1 text-muted">Nummernkreise: {state.result.sequences.join("; ")}</p> : null}
          {state.result.warnings.length ? (
            <ul className="mt-2 list-disc pl-5">{state.result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

export function DoctolibImportForm({ action }: { action: (s: DoctolibImportState, f: FormData) => Promise<DoctolibImportState> }) {
  const [state, run, pending] = useActionState(action, undefined);
  const p = state?.preview;
  return (
    <form onSubmit={keepValues(run)} className="flex flex-col gap-4">
      <FormError message={state?.error} />
      <FormSuccess message={state?.ok} />
      <input type="file" name="file" required accept=".csv,text/csv" className="text-sm file:mr-3 file:h-11 file:rounded-xl file:border file:border-border file:bg-surface file:px-4 file:font-semibold" />
      {state?.hash ? <input type="hidden" name="hash" value={state.hash} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="intent" value="preview" variant="secondary" disabled={pending}>{pending ? "…" : "Prüfen (Vorschau)"}</Button>
        {p && p.total > p.existing ? <Button type="submit" name="intent" value="run" disabled={pending}>Import ausführen</Button> : null}
      </div>
      {p ? (
        <div className="text-sm">
          <p>{p.total} Einträge gefunden, davon {p.existing} bereits vorhanden (gleiche Doctolib-ID). Neu: {p.total - p.existing}.</p>
          {p.sample.length ? <p className="mt-1 text-muted">z. B. {p.sample.join(", ")}</p> : null}
          {p.issues.length ? <ul className="mt-2 list-disc pl-5">{p.issues.map((i, k) => <li key={k}>Zeile {i.row}: {i.message}</li>)}</ul> : null}
        </div>
      ) : null}
    </form>
  );
}
