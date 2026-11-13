"use client";

import { useActionState, useState, type ReactNode } from "react";
import { keepValues } from "@/lib/forms";
import { Badge, Button, Card, CardTitle, Field, FormError, Input, Select, Textarea } from "@/components/ui";
import { DIAGNOSIS_GROUPS, DIAGNOSIS_GROUP_CODES } from "@/lib/rules/prescription";
import { importEverordnungAction, previewEverordnungAction, type ImportState, type PreviewState } from "./actions";

const deDate = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "–");

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd>{children || "–"}</dd>
    </div>
  );
}

export function EverordnungImport({ canCreatePatient }: { canCreatePatient: boolean }) {
  const [preview, runPreview, previewing] = useActionState<PreviewState, FormData>(previewEverordnungAction, undefined);
  const [result, runImport, importing] = useActionState<ImportState, FormData>(importEverordnungAction, undefined);
  const p = preview?.preview;
  const s = p?.summary;
  const [patient, setPatient] = useState<string>("");

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>1. Datei laden</CardTitle>
        <form onSubmit={keepValues(runPreview)} className="flex flex-col gap-3">
          <FormError message={preview?.error} />
          <Field label="FHIR-Bundle (JSON, höchstens 1 MB)">
            <Input type="file" name="file" accept=".json,application/json,application/fhir+json" />
          </Field>
          <Field label="… oder Inhalt einfügen" hint="Nur JSON. Die Datei wird nicht gespeichert – übernommen wird nur eine Zusammenfassung.">
            <Textarea name="text" rows={4} spellCheck={false} className="font-mono text-xs" />
          </Field>
          <div>
            <Button type="submit" disabled={previewing}>{previewing ? "…" : "Vorschau anzeigen"}</Button>
          </div>
        </form>
      </Card>

      {s && p ? (
        <Card>
          <CardTitle action={p.duplicate ? <Badge tone="accent">bereits importiert</Badge> : <Badge tone="info">Vorschau</Badge>}>2. Prüfen und übernehmen</CardTitle>
          {p.duplicate ? (
            <p className="mb-3 rounded-xl bg-warn-soft p-3 text-sm text-warn-soft-text">
              Diese eVerordnung ({s.externalRef}) wurde bereits importiert.{" "}
              <a className="underline" href={`/kunden/${p.duplicate.patientId}/verordnungen`}>Zur Verordnung</a>
            </p>
          ) : null}
          <div className="grid gap-4 lg:grid-cols-2">
            <dl className="flex flex-col gap-1">
              <Row label="Kennung">{s.externalRef}</Row>
              <Row label="Ausgestellt">{deDate(s.issuedAt)}</Row>
              <Row label="Patient:in">
                {[s.patient.firstName, s.patient.lastName].filter(Boolean).join(" ")}
                {s.patient.birthDate ? `, geb. ${deDate(s.patient.birthDate)}` : ""}
              </Row>
              <Row label="KVNR">{s.patient.kvnr}</Row>
              <Row label="Kostenträger">{[s.coverage.insurerName, s.coverage.ik ? `IK ${s.coverage.ik}` : null].filter(Boolean).join(" · ")}</Row>
              <Row label="Arzt/Ärztin">{[s.practitioner.name, s.practitioner.lanr ? `LANR ${s.practitioner.lanr}` : null].filter(Boolean).join(" · ")}</Row>
              <Row label="Betriebsstätte">{[s.organization.name, s.organization.bsnr ? `BSNR ${s.organization.bsnr}` : null].filter(Boolean).join(" · ")}</Row>
            </dl>
            <dl className="flex flex-col gap-1">
              <Row label="Diagnosegruppe">{s.diagnosisGroup ? `${s.diagnosisGroup}${s.diagnosisGroupInferred ? " (abgeleitet)" : ""}` : null}</Row>
              <Row label="ICD-10">{s.diagnoses.map((d) => `${d.code}${d.display ? ` ${d.display}` : ""}`).join("; ")}</Row>
              <Row label="Leitsymptomatik">{s.leitsymptomatik}</Row>
              <Row label="Heilmittel">{s.remedies.map((r) => `${r.code && /^\d{5}$/.test(r.code) ? `${r.code} ` : ""}${r.display}${r.units ? ` (${r.units})` : ""}`).join("; ")}</Row>
              <Row label="Einheiten">{s.units ? String(s.units) : null}</Row>
              <Row label="Frequenz">{s.frequency}</Row>
              <Row label="Kennzeichen">
                {[s.urgent ? "dringlich" : null, s.homeVisit ? "Hausbesuch" : null, s.therapyReport ? "Therapiebericht" : null, s.coverage.copaymentExempt ? "zuzahlungsbefreit" : null].filter(Boolean).join(", ")}
              </Row>
            </dl>
          </div>
          {s.warnings.length ? (
            <ul className="mt-3 list-disc rounded-xl bg-warn-soft p-3 pl-8 text-sm text-warn-soft-text">
              {s.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          ) : null}

          {!p.duplicate ? (
            <form onSubmit={keepValues(runImport)} className="mt-4 flex flex-col gap-4 border-t border-border pt-4">
              <FormError message={result?.error} />
              <input type="hidden" name="bundle" value={preview?.bundle ?? ""} />
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-semibold">Person zuordnen (es wird nichts automatisch zugeordnet)</legend>
                {p.candidates.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <input type="radio" name="patient" value={c.id} checked={patient === c.id} onChange={() => setPatient(c.id)} />
                    Nr. {c.number} · {[c.firstName, c.lastName].filter(Boolean).join(" ")}{c.birthDate ? `, geb. ${deDate(c.birthDate)}` : ""} <span className="text-muted">({c.reason})</span>
                  </label>
                ))}
                <label className="flex flex-wrap items-center gap-2 text-sm">
                  <input type="radio" name="patient" value="number" checked={patient === "number"} onChange={() => setPatient("number")} />
                  Andere Person, Patientennummer:
                  <Input name="patientNumber" inputMode="numeric" className="w-28" onFocus={() => setPatient("number")} />
                </label>
                {canCreatePatient ? (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="patient" value="new" checked={patient === "new"} onChange={() => setPatient("new")} />
                    Neu anlegen aus den Daten der eVerordnung
                  </label>
                ) : null}
              </fieldset>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Diagnosegruppe">
                  <Select name="diagnosisGroup" defaultValue={s.diagnosisGroup ?? ""}>
                    <option value="">– bitte wählen –</option>
                    {DIAGNOSIS_GROUP_CODES.map((g) => <option key={g} value={g}>{DIAGNOSIS_GROUPS[g].label}</option>)}
                  </Select>
                </Field>
                <Field label="Verordnete Einheiten">
                  <Input name="units" type="number" min={1} max={99} defaultValue={s.units ?? ""} />
                </Field>
                <Field label="Ausstellungsdatum">
                  <Input name="issuedAt" type="date" defaultValue={s.issuedAt ?? ""} />
                </Field>
              </div>
              <p className="text-xs text-muted">Die Verordnung wird als „offen“ angelegt und kann bis zur ersten Behandlung in der Patientenakte geändert werden.</p>
              <div>
                <Button type="submit" disabled={importing || !patient}>{importing ? "…" : "Verordnung übernehmen"}</Button>
              </div>
            </form>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
