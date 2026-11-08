"use client";

import { keepValues } from "@/lib/forms";
import { useActionState, useRef, useState, type ReactNode } from "react";
import { Camera, Loader2, Plus, ScanText, Trash2, X } from "lucide-react";
import { Badge, Button, Card, Checkbox, Field, FormError, Input, Select, cx } from "@/components/ui";
import { LOW_CONFIDENCE, OCR_FIELD_LABELS, type OcrFieldKey, type OcrFields, type OcrSuggestion } from "@/integrations/ocr/schema";
import { DIAGNOSIS_GROUPS, FREQUENCY_OPTIONS, START_DEADLINE_DAYS, START_DEADLINE_URGENT_DAYS, startDeadline, type DiagnosisGroup } from "@/lib/rules/prescription";
import { readPrescriptionPhotoAction, savePrescriptionAction, type PrescriptionFormState } from "./actions";

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

/** Daten der Akte zum Abgleich mit den ausgelesenen Versichertendaten */
export type PatientCompare = { name: string; birthDate: string | null; insuranceNumber: string | null; insurerName: string | null };
export type OcrAvailability = { available: boolean; mock: boolean; reason: string | null };

type OcrState = { suggestion: OcrSuggestion; mock: boolean; at: string };
/** Felder ohne eigene Spalte an der Verordnung – werden nur in importData (bestätigt) abgelegt */
const ASIDE_KEYS = ["patientName", "patientBirthDate", "insurerIk", "insuranceNumber", "leitsymptomatik"] as const;
type AsideKey = (typeof ASIDE_KEYS)[number];

const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase().replace(/\s+/g, " ") : JSON.stringify(v ?? null));

export function PrescriptionForm({
  patientId,
  initial: initialProp,
  catalog,
  ocrInfo = { available: false, mock: false, reason: null },
  patient,
}: {
  patientId: string;
  initial: PrescriptionInitial;
  /** Leistungen mit GKV-Positionsnummer aus dem Leistungskatalog */
  catalog: { position: string; label: string }[];
  ocrInfo?: OcrAvailability;
  patient?: PatientCompare;
}) {
  const [state, action, pending] = useActionState<PrescriptionFormState, FormData>(savePrescriptionAction, undefined);
  // initial als State: eine Auslesung setzt die (unkontrollierten) Felder neu (key = version)
  const [initial, setInitial] = useState(initialProp);
  const [version, setVersion] = useState(0);
  const [ocr, setOcr] = useState<OcrState | null>(null);
  const [aside, setAside] = useState<Partial<Record<AsideKey, string>>>({});
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
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
  const f: OcrFields = ocr?.suggestion.fields ?? {};

  async function runOcr() {
    if (!scanId) return;
    setOcrBusy(true);
    setOcrError(null);
    try {
      const res = await readPrescriptionPhotoAction({ patientId, mediaId: scanId });
      if (!res.ok) return setOcrError(res.error);
      applySuggestion(res);
    } catch {
      setOcrError("Auslesen fehlgeschlagen. Bitte erneut versuchen oder manuell erfassen.");
    } finally {
      setOcrBusy(false);
    }
  }

  /** Vorschlag in die Felder übernehmen (nur im Formular – gespeichert wird erst mit „Übernehmen“) */
  function applySuggestion(res: OcrState) {
    const v = res.suggestion.fields;
    setOcr({ suggestion: res.suggestion, mock: res.mock, at: res.at });
    if (v.diagnosisGroup) setGroup(v.diagnosisGroup.value);
    if (v.issuedAt) setIssuedAt(v.issuedAt.value);
    if (v.urgent) setUrgent(v.urgent.value);
    if (v.units) setUnits(v.units.value);
    if (v.frequencyPerWeek) setFrequency(v.frequencyPerWeek.value);
    if (v.positions) setPositions(v.positions.value.map((p) => ({ ...p })));
    setInitial((i) => ({
      ...i,
      doctorName: v.doctorName?.value ?? i.doctorName,
      doctorLanr: v.doctorLanr?.value ?? i.doctorLanr,
      doctorBsnr: v.doctorBsnr?.value ?? i.doctorBsnr,
      icd10: v.icd10?.value ?? i.icd10,
      remedy: v.remedy?.value ?? i.remedy,
      homeVisit: v.homeVisit?.value ?? i.homeVisit,
    }));
    setAside(Object.fromEntries(ASIDE_KEYS.filter((k) => v[k]).map((k) => [k, String(v[k]!.value)])));
    setVersion((n) => n + 1);
  }

  /** Vorschlag verwerfen: Formular auf den Stand vor der Auslesung zurücksetzen */
  function discardSuggestion() {
    setOcrError(null);
    if (!ocr) return;
    setOcr(null);
    setAside({});
    setInitial(initialProp);
    setGroup(initialProp.diagnosisGroup);
    setIssuedAt(initialProp.issuedAt);
    setUrgent(initialProp.urgent);
    setUnits(initialProp.units);
    setFrequency(initialProp.frequencyPerWeek);
    setPositions(initialProp.positions.length ? initialProp.positions : [{ label: "", units: initialProp.units }]);
    setVersion((n) => n + 1);
  }

  /** importData = Vorschlag + Sicherheit (kein Bild); Felder ohne Spalte in der bestätigten Fassung */
  function withImportData(fd: FormData) {
    if (!ocr) return fd;
    const fields: Record<string, unknown> = { ...ocr.suggestion.fields };
    const edited: OcrFieldKey[] = [];
    for (const k of ASIDE_KEYS) {
      const val = (aside[k] ?? "").trim();
      const orig = f[k]?.value;
      if (norm(val) !== norm(orig ?? "")) {
        edited.push(k);
        if (val) fields[k] = { value: val, confidence: 1 };
        else delete fields[k];
      }
    }
    const compare: [OcrFieldKey, unknown][] = [
      ["issuedAt", fd.get("issuedAt")],
      ["diagnosisGroup", fd.get("diagnosisGroup")],
      ["icd10", String(fd.get("icd10") ?? "").toUpperCase()],
      ["units", Number(fd.get("units"))],
      ["frequencyPerWeek", fd.get("frequencyPerWeek")],
      ["remedy", fd.get("remedy")],
      ["doctorName", fd.get("doctorName")],
      ["doctorLanr", fd.get("doctorLanr")],
      ["doctorBsnr", fd.get("doctorBsnr")],
      ["urgent", fd.get("urgent") === "on"],
      ["homeVisit", fd.get("homeVisit") === "on"],
    ];
    for (const [k, val] of compare) if (f[k] && norm(f[k]!.value) !== norm(val)) edited.push(k);
    if (f.positions && norm(f.positions.value) !== norm(positions.filter((p) => p.label || p.position))) edited.push("positions");
    fd.set("source", "ocr");
    fd.set("importData", JSON.stringify({ kind: "ocr", mock: ocr.mock, at: ocr.at, fields, edited }));
    return fd;
  }

  /** kleine Sicherheitsanzeige je Feld */
  const conf = (k: OcrFieldKey) => {
    const c = f[k]?.confidence;
    if (c === undefined) return null;
    const low = c < LOW_CONFIDENCE;
    return (
      <Badge tone={low ? "warn" : "info"} className="ml-1 align-middle">
        {low ? "unsicher" : "ausgelesen"} {Math.round(c * 100)} %
      </Badge>
    );
  };
  const hint = (k: OcrFieldKey, base?: ReactNode) => {
    const c = conf(k);
    return c || base ? <>{base}{c}</> : undefined;
  };

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

  const photoSrc = scanPreview ?? (scanId ? `/api/media/${scanId}` : null);

  const photoCard = (
    <Card>
      <h3 className="mb-3 font-display text-lg font-semibold">Foto der Papierverordnung (optional)</h3>
      <input ref={fileRef} id="vo-scan" type="file" accept="image/*,application/pdf" capture="environment" className="sr-only" onChange={(e) => { discardSuggestion(); void upload(e.target.files?.[0]); }} />
      <label htmlFor="vo-scan" className="flex h-14 cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border-strong text-[15px] font-semibold hover:bg-surface-2">
        {uploading ? <Loader2 className="animate-spin" size={20} aria-hidden /> : <Camera size={20} aria-hidden />}
        {uploading ? "Wird verschlüsselt hochgeladen …" : scanId ? "Neues Foto aufnehmen" : "Verordnung fotografieren"}
      </label>
      <FormError message={uploadError} />
      {scanId ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {scanPreview && !ocr ? <img src={scanPreview} alt="Verordnung" className="h-24 rounded-lg object-cover" /> : null}
          <span>✓ Foto gespeichert</span>
          <button type="button" className="font-semibold text-primary" onClick={() => { setScanId(null); setScanPreview(null); discardSuggestion(); }}>entfernen</button>
          {ocrInfo.available && !ocr ? (
            <Button type="button" variant="secondary" onClick={runOcr} disabled={ocrBusy || uploading} className="ml-auto">
              {ocrBusy ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <ScanText size={18} aria-hidden />}
              {ocrBusy ? "Wird ausgelesen …" : "Daten aus Foto auslesen"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {ocrInfo.available ? (
        <p className="mt-2 text-xs text-muted">
          {ocrInfo.mock
            ? "Auslesen im Testmodus: liefert erfundene Beispieldaten, das Foto verlässt die Praxis nicht."
            : "Beim Auslesen wird das Foto an den in den Einstellungen freigegebenen KI-Dienst (AVV) gesendet. Alle Felder bitte prüfen."}
        </p>
      ) : ocrInfo.reason && !initial.id ? (
        <p className="mt-2 text-xs text-muted">Automatisches Auslesen: {ocrInfo.reason}</p>
      ) : null}
      <FormError message={ocrError} />
    </Card>
  );

  const fields = (
    <>
      <Card>
        <h3 className="mb-3 font-display text-lg font-semibold">Verordnung</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Ausstellungsdatum" hint={hint("issuedAt")}>
            <Input type="date" name="issuedAt" value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} required />
          </Field>
          <Field label="Diagnosegruppe" hint={hint("diagnosisGroup")}>
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
          <Field label="ICD-10" hint={hint("icd10", rule.icdHint)}>
            <Input name="icd10" defaultValue={initial.icd10} placeholder="E11.74" autoCapitalize="characters" />
          </Field>
          <Field label="Verordnete Einheiten" hint={hint("units", `Höchstmenge je VO für ${rule.code}: ${rule.maxUnitsPerPrescription}`)}>
            <Input type="number" name="units" min={1} max={99} value={units} onChange={(e) => setUnits(Number(e.target.value))} required />
          </Field>
          <Field label="Frequenz" hint={hint("frequencyPerWeek")}>
            <Input name="frequencyPerWeek" list="vo-frequencies" value={frequency} onChange={(e) => setFrequency(e.target.value)} />
            <datalist id="vo-frequencies">{FREQUENCY_OPTIONS.map((fr) => <option key={fr} value={fr} />)}</datalist>
          </Field>
          <Field label="Heilmittel (Freitext von der VO)" hint={hint("remedy")}>
            <Input name="remedy" defaultValue={initial.remedy} placeholder="z. B. Podologische Komplexbehandlung" />
          </Field>
        </div>
        <div className="mt-3 grid gap-x-6 sm:grid-cols-2">
          <Checkbox name="urgent" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} label={<>Dringlicher Behandlungsbedarf (Beginn innerhalb 14 Tagen){conf("urgent")}</>} />
          <Checkbox name="homeVisit" defaultChecked={initial.homeVisit} label={<>Hausbesuch verordnet{conf("homeVisit")}</>} />
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
          <Field label="Name / Praxis" hint={hint("doctorName")}><Input name="doctorName" defaultValue={initial.doctorName} /></Field>
          <Field label="LANR" hint={hint("doctorLanr", "9 Ziffern")}><Input name="doctorLanr" defaultValue={initial.doctorLanr} inputMode="numeric" pattern="\d{9}" maxLength={9} /></Field>
          <Field label="BSNR" hint={hint("doctorBsnr", "9 Ziffern")}><Input name="doctorBsnr" defaultValue={initial.doctorBsnr} inputMode="numeric" pattern="\d{9}" maxLength={9} /></Field>
        </div>
      </Card>

      <Card>
        <h3 className="mb-3 font-display text-lg font-semibold">Heilmittelpositionen {conf("positions")}</h3>
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
    </>
  );

  return (
    <form onSubmit={keepValues((fd) => action(withImportData(fd)))} className="flex flex-col gap-5">
      <input type="hidden" name="patientId" value={patientId} />
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <input type="hidden" name="positions" value={JSON.stringify(positions)} />
      <input type="hidden" name="scanMediaId" value={scanId ?? ""} />
      <FormError message={state?.error} />

      {ocr ? (
        <>
          <p role="status" className={cx("flex flex-wrap items-center gap-2 rounded-xl p-3 text-sm font-medium", ocr.mock ? "bg-warn-soft text-warn-soft-text" : "bg-info-soft text-info-soft-text")}>
            {ocr.mock ? <Badge tone="warn">Testmodus</Badge> : <Badge tone="info">KI-Vorschlag</Badge>}
            {ocr.mock
              ? "Erfundene Beispieldaten – nicht für echte Verordnungen verwenden."
              : "Bitte jedes Feld mit dem Foto vergleichen und korrigieren. Gespeichert wird erst mit „Übernehmen“."}
            {ocr.suggestion.rejected.length ? <span className="w-full text-xs">Nicht lesbar oder unplausibel (bitte selbst eintragen): {ocr.suggestion.rejected.map((k) => OCR_FIELD_LABELS[k]).join(", ")}</span> : null}
          </p>
          <div key={version} className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,400px)]">
            <div className="flex flex-col gap-5">{fields}</div>
            <aside className="flex flex-col gap-4 lg:sticky lg:top-4" aria-label="Foto und Versichertendaten">
              {photoSrc ? (
                <a href={photoSrc} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-border bg-surface-2" title="Foto in voller Größe öffnen">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photoSrc} alt="Foto der Papierverordnung" className="max-h-[70vh] w-full object-contain" />
                </a>
              ) : null}
              <Card>
                <h3 className="mb-3 font-display text-base font-semibold">Versicherte:r laut Foto</h3>
                <div className="flex flex-col gap-3">
                  {ASIDE_KEYS.map((k) => (
                    <Field key={k} label={OCR_FIELD_LABELS[k]} hint={<>{conf(k)}<Mismatch k={k} value={aside[k]} patient={patient} /></>}>
                      <Input value={aside[k] ?? ""} onChange={(e) => setAside((a) => ({ ...a, [k]: e.target.value }))} maxLength={k === "leitsymptomatik" ? 300 : 120} />
                    </Field>
                  ))}
                </div>
                <p className="mt-3 text-xs text-muted">Diese Angaben werden nur zur Nachvollziehbarkeit an der Verordnung gespeichert; die Akte wird nicht geändert.</p>
              </Card>
              <Button type="button" variant="ghost" onClick={discardSuggestion}><X size={16} aria-hidden /> Vorschlag verwerfen</Button>
            </aside>
          </div>
        </>
      ) : (
        <>
          {ocrInfo.available && !initial.id ? photoCard : null}
          <div key={version} className="flex flex-col gap-5">{fields}</div>
          {ocrInfo.available && !initial.id ? null : photoCard}
        </>
      )}

      <div>
        <Button type="submit" disabled={pending || uploading || ocrBusy}>
          {pending ? "Wird gespeichert …" : ocr ? "Übernehmen" : initial.id ? "Änderungen speichern" : "Verordnung anlegen"}
        </Button>
      </div>
    </form>
  );
}

/** Abgleich mit der Akte: Hinweis bei Abweichung (z. B. falsche Person fotografiert) */
function Mismatch({ k, value, patient }: { k: AsideKey; value?: string; patient?: PatientCompare }) {
  if (!patient || !value) return null;
  const v = value.trim().toLowerCase();
  let differs = false;
  let known: string | null = null;
  if (k === "patientName") {
    known = patient.name;
    const parts = patient.name.toLowerCase().split(/[\s,]+/).filter((x) => x.length > 1);
    differs = parts.length > 0 && !parts.every((x) => v.includes(x));
  } else if (k === "patientBirthDate") {
    known = patient.birthDate;
    differs = !!known && known !== value.trim();
  } else if (k === "insuranceNumber") {
    known = patient.insuranceNumber;
    differs = !!known && known.replace(/\s/g, "").toUpperCase() !== value.replace(/\s/g, "").toUpperCase();
  }
  if (!differs) return null;
  return <span className="mt-1 block font-semibold text-danger">Weicht von der Akte ab{known ? ` (Akte: ${known})` : ""} – richtige Person?</span>;
}
