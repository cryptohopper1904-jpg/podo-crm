"use client";

import { keepValues } from "@/lib/forms";
import { useActionState, useRef, useState } from "react";
import { Camera, Loader2, Plus, Trash2 } from "lucide-react";
import { Button, Card, Checkbox, Field, FormError, Input, Select } from "@/components/ui";
import { DIAGNOSIS_GROUPS, FREQUENCY_OPTIONS, START_DEADLINE_DAYS, START_DEADLINE_URGENT_DAYS, startDeadline, type DiagnosisGroup } from "@/lib/rules/prescription";
import { savePrescriptionAction, type PrescriptionFormState } from "./actions";

type Position = { position?: string; label: string; units: number };
export type PrescriptionInitial = {
  id?: string;
  issuedAt: string;
  doctorName: string;
  doctorLanr: string;
  doctorBsnr: string;
  diagnosisGroup: DiagnosisGroup;
  icd10: string;
  remedy: string;
  units: number;
  frequencyPerWeek: string;
  homeVisit: boolean;
  urgent: boolean;
  copaymentExempt: boolean;
  therapyReportRequested: boolean;
  positions: Position[];
  scanMediaId?: string | null;
};

const deDate = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "–");

export function PrescriptionForm({
  patientId,
  initial,
  catalog,
}: {
  patientId: string;
  initial: PrescriptionInitial;
  /** Leistungen mit GKV-Positionsnummer aus dem Leistungskatalog */
  catalog: { position: string; label: string }[];
}) {
  const [state, action, pending] = useActionState<PrescriptionFormState, FormData>(savePrescriptionAction, undefined);
  const [group, setGroup] = useState<DiagnosisGroup>(initial.diagnosisGroup);
  const [issuedAt, setIssuedAt] = useState(initial.issuedAt);
  const [urgent, setUrgent] = useState(initial.urgent);
  const [units, setUnits] = useState(initial.units);
  const [frequency, setFrequency] = useState(initial.frequencyPerWeek);
  const [positions, setPositions] = useState<Position[]>(initial.positions.length ? initial.positions : [{ label: "", units: initial.units }]);
  const [scanId, setScanId] = useState<string | null>(initial.scanMediaId ?? null);
  const [scanPreview, setScanPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rule = DIAGNOSIS_GROUPS[group];

  async function upload(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("patientId", patientId);
      fd.set("purpose", "prescription");
      fd.set("caption", "Verordnung (Papier)");
      const res = await fetch("/api/media", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload fehlgeschlagen");
      setScanId(json.id);
      setScanPreview(file.type.startsWith("image/") ? URL.createObjectURL(file) : null);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Upload fehlgeschlagen");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const setPos = (i: number, patch: Partial<Position>) => setPositions((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-5">
      <input type="hidden" name="patientId" value={patientId} />
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <input type="hidden" name="positions" value={JSON.stringify(positions)} />
      <input type="hidden" name="scanMediaId" value={scanId ?? ""} />
      <FormError message={state?.error} />

      <Card>
        <h3 className="mb-3 font-display text-lg font-semibold">Verordnung</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Ausstellungsdatum">
            <Input type="date" name="issuedAt" value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} required />
          </Field>
          <Field label="Diagnosegruppe">
            <Select
              name="diagnosisGroup"
              value={group}
              onChange={(e) => {
                const g = e.target.value as DiagnosisGroup;
                setGroup(g);
                if (!frequency || Object.values(DIAGNOSIS_GROUPS).some((x) => x.defaultFrequency === frequency)) setFrequency(DIAGNOSIS_GROUPS[g].defaultFrequency);
              }}
            >
              {Object.values(DIAGNOSIS_GROUPS).map((g) => <option key={g.code} value={g.code}>{g.label}</option>)}
            </Select>
          </Field>
          <Field label="ICD-10" hint={rule.icdHint}>
            <Input name="icd10" defaultValue={initial.icd10} placeholder="E11.74" autoCapitalize="characters" />
          </Field>
          <Field label="Verordnete Einheiten" hint={`Höchstmenge je VO für ${rule.code}: ${rule.maxUnitsPerPrescription}`}>
            <Input type="number" name="units" min={1} max={99} value={units} onChange={(e) => setUnits(Number(e.target.value))} required />
          </Field>
          <Field label="Frequenz">
            <Input name="frequencyPerWeek" list="vo-frequencies" value={frequency} onChange={(e) => setFrequency(e.target.value)} />
            <datalist id="vo-frequencies">{FREQUENCY_OPTIONS.map((f) => <option key={f} value={f} />)}</datalist>
          </Field>
          <Field label="Heilmittel (Freitext von der VO)">
            <Input name="remedy" defaultValue={initial.remedy} placeholder="z. B. Podologische Komplexbehandlung" />
          </Field>
        </div>
        <div className="mt-3 grid gap-x-6 sm:grid-cols-2">
          <Checkbox name="urgent" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} label="Dringlicher Behandlungsbedarf (Beginn innerhalb 14 Tagen)" />
          <Checkbox name="homeVisit" defaultChecked={initial.homeVisit} label="Hausbesuch verordnet" />
          <Checkbox name="copaymentExempt" defaultChecked={initial.copaymentExempt} label="Zuzahlungsbefreit (Befreiungsausweis liegt vor)" />
          <Checkbox name="therapyReportRequested" defaultChecked={initial.therapyReportRequested} label="Therapiebericht angefordert" />
        </div>
        <p className="mt-3 rounded-xl bg-info-soft p-3 text-sm text-info-soft-text">
          Spätester Behandlungsbeginn: <strong>{/^\d{4}-\d{2}-\d{2}$/.test(issuedAt) ? deDate(startDeadline(issuedAt, urgent)) : "–"}</strong>{" "}
          ({urgent ? START_DEADLINE_URGENT_DAYS : START_DEADLINE_DAYS} Tage nach Ausstellung)
        </p>
      </Card>

      <Card>
        <h3 className="mb-3 font-display text-lg font-semibold">Verordnender Arzt</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Name / Praxis"><Input name="doctorName" defaultValue={initial.doctorName} /></Field>
          <Field label="LANR" hint="9 Ziffern"><Input name="doctorLanr" defaultValue={initial.doctorLanr} inputMode="numeric" pattern="\d{9}" maxLength={9} /></Field>
          <Field label="BSNR" hint="9 Ziffern"><Input name="doctorBsnr" defaultValue={initial.doctorBsnr} inputMode="numeric" pattern="\d{9}" maxLength={9} /></Field>
        </div>
      </Card>

      <Card>
        <h3 className="mb-3 font-display text-lg font-semibold">Heilmittelpositionen</h3>
        <div className="flex flex-col gap-3">
          {positions.map((p, i) => (
            <div key={i} className="grid items-end gap-3 sm:grid-cols-[160px_1fr_110px_auto]">
              <Field label="Positionsnr.">
                <Input
                  list="vo-positions"
                  value={p.position ?? ""}
                  onChange={(e) => {
                    const code = e.target.value;
                    const hit = catalog.find((c) => c.position === code);
                    setPos(i, { position: code || undefined, ...(hit && !p.label ? { label: hit.label } : {}) });
                  }}
                />
              </Field>
              <Field label="Bezeichnung"><Input value={p.label} onChange={(e) => setPos(i, { label: e.target.value })} placeholder="z. B. Hornhautabtragung" /></Field>
              <Field label="Einheiten"><Input type="number" min={1} max={99} value={p.units} onChange={(e) => setPos(i, { units: Number(e.target.value) })} /></Field>
              <Button type="button" variant="ghost" aria-label="Position entfernen" disabled={positions.length === 1} onClick={() => setPositions((ps) => ps.filter((_, j) => j !== i))}>
                <Trash2 size={18} aria-hidden />
              </Button>
            </div>
          ))}
          <datalist id="vo-positions">{catalog.map((c) => <option key={c.position} value={c.position}>{c.label}</option>)}</datalist>
          <div>
            <Button type="button" variant="secondary" disabled={positions.length >= 10} onClick={() => setPositions((ps) => [...ps, { label: "", units }])}>
              <Plus size={18} aria-hidden /> Position
            </Button>
          </div>
          <p className="text-xs text-muted">Die Zuzahlung (10 € je Verordnung + 10 % der Kosten) wird aus den Preisen der Leistungen mit passender GKV-Positionsnummer berechnet.</p>
        </div>
      </Card>

      <Card>
        <h3 className="mb-3 font-display text-lg font-semibold">Foto der Papierverordnung (optional)</h3>
        <input ref={fileRef} id="vo-scan" type="file" accept="image/*,application/pdf" capture="environment" className="sr-only" onChange={(e) => upload(e.target.files?.[0])} />
        <label htmlFor="vo-scan" className="flex h-14 cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border-strong text-[15px] font-semibold hover:bg-surface-2">
          {uploading ? <Loader2 className="animate-spin" size={20} aria-hidden /> : <Camera size={20} aria-hidden />}
          {uploading ? "Wird verschlüsselt hochgeladen …" : scanId ? "Neues Foto aufnehmen" : "Verordnung fotografieren"}
        </label>
        <FormError message={uploadError} />
        {scanId ? (
          <div className="mt-3 flex items-center gap-3 text-sm">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {scanPreview ? <img src={scanPreview} alt="Verordnung" className="h-24 rounded-lg object-cover" /> : null}
            <span>✓ Foto gespeichert</span>
            <button type="button" className="font-semibold text-primary" onClick={() => { setScanId(null); setScanPreview(null); }}>entfernen</button>
          </div>
        ) : null}
      </Card>

      <div>
        <Button type="submit" disabled={pending || uploading}>{pending ? "Wird gespeichert …" : initial.id ? "Änderungen speichern" : "Verordnung anlegen"}</Button>
      </div>
    </form>
  );
}
