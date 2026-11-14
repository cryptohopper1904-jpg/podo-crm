"use client";

import { keepValues } from "@/lib/forms";
import { useActionState, useRef, useState, type FormEvent } from "react";
import { Camera, Check, ChevronDown, Loader2, Mic, ScanLine, Square, Trash2 } from "lucide-react";
import type { FootPoint } from "@/db/schema";
import { FootFindings } from "@/components/foot3d";
import { serializeFootPoints } from "@/lib/foot3d";
import { Badge, Button, Card, Checkbox, Field, FormActions, FormError, Input, Select, Textarea, cx } from "@/components/ui";
import { saveTreatmentAction, type DokuFormState } from "./actions";

type Service = { id: string; code: string; name: string };
type Uploaded = { id: string; preview: string; purpose: string; footSide?: string; toe?: string; view?: string };
type BraceAction = "none" | "set" | "check" | "complication" | "remove";

const PURPOSES: Record<string, string> = {
  finding: "Befund",
  brace_before: "Spange – vorher",
  brace_progress: "Spange – Verlauf",
  brace_complication: "Spange – Verschlechterung",
  brace_after: "Spange – Abschluss",
  wound: "Wunde/Ulkus",
  document: "Dokument",
};

const VIEWS = ["plantar", "dorsal", "medial", "lateral", "Nahaufnahme"];

export function DokuForm({
  patientId,
  appointmentId,
  services,
  activeBrace,
  voiceEnabled,
  prescriptions = [],
  defaultPrescriptionId,
}: {
  patientId: string;
  appointmentId?: string;
  services: Service[];
  activeBrace: { id: string; side: string; toe: number; braceType: string | null; stage: string | null } | null;
  voiceEnabled: boolean;
  /** buchbare Verordnungen (open/active mit Resteinheiten) */
  prescriptions?: { id: string; label: string; remaining: number; warning: string | null }[];
  defaultPrescriptionId?: string | null;
}) {
  const [state, action, pending] = useActionState<DokuFormState, FormData>(saveTreatmentAction, undefined);
  const [points, setPoints] = useState<FootPoint[]>([]);
  const [uploads, setUploads] = useState<Uploaded[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [photoMeta, setPhotoMeta] = useState({ purpose: "finding", footSide: "right", toe: "1", view: "dorsal" });
  const [braceAction, setBraceAction] = useState<BraceAction>(activeBrace ? "check" : "none");
  const [braceOpenAtStart] = useState(!!activeBrace);
  const [fields, setFields] = useState({ findings: "", servicesText: "", material: "", reaction: "", recommendation: "" });
  const [picked, setPicked] = useState<string[]>([]);
  const [batch, setBatch] = useState("");
  const [batchHint, setBatchHint] = useState<{ ok: boolean; message: string } | null>(null);
  async function checkBatch(code: string) {
    setBatchHint(null);
    if (code.trim().length < 3) return;
    try {
      const res = await fetch(`/api/hygiene/batch/${encodeURIComponent(code.trim())}`);
      const json = await res.json();
      if (res.ok) setBatchHint({ ok: !!json.ok, message: json.message ?? (json.ok ? "Charge freigegeben." : "Charge nicht verwendbar.") });
      else setBatchHint({ ok: false, message: json.error ?? "Charge konnte nicht geprüft werden." });
    } catch {
      // offline: kein Hinweis
    }
  }
  const [ai, setAi] = useState(false);
  const [prescriptionId, setPrescriptionId] = useState(defaultPrescriptionId && prescriptions.some((p) => p.id === defaultPrescriptionId) ? defaultPrescriptionId : "");
  const selectedVo = prescriptions.find((p) => p.id === prescriptionId);
  const fileRef = useRef<HTMLInputElement>(null);
  // Pflicht-Bestätigung: eigene Meldung am Feld statt der flüchtigen Browser-Blase (Systemsprache)
  const confirmRef = useRef<HTMLInputElement>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const submit = keepValues(action);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    if (!confirmRef.current?.checked) {
      e.preventDefault();
      setConfirmError("Bitte bestätige, dass du die Angaben geprüft hast.");
      confirmRef.current?.scrollIntoView({ block: "center" });
      confirmRef.current?.focus({ preventScroll: true });
      return;
    }
    setConfirmError(null);
    submit(e);
  }

  // ── Pflichtfotos Nagelspange (versionierte Regel, siehe src/lib/rules/brace.ts) ──
  const requiredPurpose =
    braceAction === "set" ? "brace_before" : braceAction === "remove" ? "brace_after" : braceAction === "complication" ? "brace_complication" : null;
  const requiredDone = requiredPurpose ? uploads.some((u) => u.purpose === requiredPurpose) : true;

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setUploadError(null);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.set("file", file);
        fd.set("patientId", patientId);
        fd.set("purpose", photoMeta.purpose);
        fd.set("footSide", photoMeta.footSide);
        fd.set("toe", photoMeta.toe);
        fd.set("view", photoMeta.view);
        const res = await fetch("/api/media", { method: "POST", body: fd });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Upload fehlgeschlagen");
        setUploads((u) => [...u, { id: json.id, preview: URL.createObjectURL(file), ...photoMeta }]);
      }
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Upload fehlgeschlagen");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <input type="hidden" name="patientId" value={patientId} />
      {appointmentId ? <input type="hidden" name="appointmentId" value={appointmentId} /> : null}
      <input type="hidden" name="footPoints" value={serializeFootPoints(points)} />
      <input type="hidden" name="mediaIds" value={JSON.stringify(uploads.map((u) => u.id))} />
      <input type="hidden" name="serviceIds" value={JSON.stringify(picked)} />
      <input type="hidden" name="aiAssisted" value={ai ? "1" : "0"} />
      <input type="hidden" name="braceAction" value={braceAction} />
      {activeBrace ? <input type="hidden" name="braceEpisodeId" value={activeBrace.id} /> : null}
      <FormError message={state?.error} revealKey={state} />

      {prescriptions.length ? (
        <Card>
          <h2 className="mb-3 font-display text-lg font-semibold">Verordnung</h2>
          <Field label="Behandlung auf Verordnung buchen" hint="Mit dem Speichern wird eine Einheit der Verordnung gezählt.">
            <Select name="prescriptionId" value={prescriptionId} onChange={(e) => setPrescriptionId(e.target.value)}>
              <option value="">– ohne Verordnung (Selbstzahler) –</option>
              {prescriptions.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
          </Field>
          {selectedVo ? (
            <p className={cx("mt-3 rounded-xl p-3 text-sm font-medium", selectedVo.warning ? "bg-warn-soft text-warn-soft-text" : "bg-primary-soft text-primary-soft-text")}>
              Nach dieser Behandlung noch {selectedVo.remaining - 1} Einheit(en) offen.{selectedVo.warning ? ` ${selectedVo.warning}` : ""}
            </p>
          ) : null}
        </Card>
      ) : null}

      {voiceEnabled ? <VoiceReport patientId={patientId} onResult={(r) => { setFields((f) => ({ ...f, ...r })); setAi(true); }} /> : null}

      <Card>
        <h2 className="mb-3 font-display text-lg font-semibold">Leistungen</h2>
        <div className="flex flex-wrap gap-2">
          {services.map((s) => {
            const on = picked.includes(s.id);
            return (
              <button
                key={s.id}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = on ? picked.filter((x) => x !== s.id) : [...picked, s.id];
                  setPicked(next);
                  setFields((f) => ({ ...f, servicesText: services.filter((x) => next.includes(x.id)).map((x) => x.name).join(", ") }));
                }}
                className={cx("h-11 rounded-xl px-3.5 text-sm font-semibold", on ? "bg-primary text-on-primary" : "border border-border bg-surface")}
              >
                {s.code} · {s.name}
              </button>
            );
          })}
        </div>
        <Field label="Durchgeführte Behandlung" className="mt-4">
          <Textarea name="servicesText" value={fields.servicesText} onChange={(e) => setFields({ ...fields, servicesText: e.target.value })} rows={2} />
        </Field>
      </Card>

      <Card className="p-0">
        {/* Ohne laufende Spange eingeklappt (selten gebraucht) – das Formular wird auf dem Handy deutlich kürzer */}
        {/* open nur als Startwert (konstant) – danach bestimmt das Auf-/Zuklappen der Nutzer:in, React setzt nichts zurück */}
        <details open={braceOpenAtStart} className="group">
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 rounded-[var(--radius-card)] px-5 py-3 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0">
              <span className="block font-display text-lg font-semibold">Nagelkorrekturspange</span>
              <span className="block text-[13px] leading-5 text-muted">
                {braceAction === "none" ? (activeBrace ? "Laufende Spange – heute kein Spangen-Schritt" : "Keine Spange – zum Setzen aufklappen") : "Spangen-Schritt gewählt"}
              </span>
            </span>
            <ChevronDown size={20} aria-hidden className="shrink-0 text-muted transition-transform group-open:rotate-180" />
          </summary>
          <div className="px-5 pb-5">
        {activeBrace ? (
          <p className="mb-3 text-sm">
            Laufende Spange: <strong>{activeBrace.side === "left" ? "links" : "rechts"} D{activeBrace.toe}</strong>
            {activeBrace.braceType ? ` · ${activeBrace.braceType}` : ""}{activeBrace.stage ? ` · Stadium ${activeBrace.stage}` : ""}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["none", "Keine Spange"],
              ...(activeBrace ? [] : [["set", "Spange setzen"]]),
              ...(activeBrace ? [["check", "Kontrolle/Nachregulierung"], ["complication", "Verschlechterung"], ["remove", "Abschluss/Abnahme"]] : []),
            ] as [BraceAction, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={braceAction === k}
              onClick={() => {
                setBraceAction(k);
                const p = k === "set" ? "brace_before" : k === "remove" ? "brace_after" : k === "complication" ? "brace_complication" : k === "check" ? "brace_progress" : "finding";
                setPhotoMeta((m) => ({ ...m, purpose: p, ...(activeBrace ? { footSide: activeBrace.side, toe: String(activeBrace.toe) } : {}) }));
              }}
              className={cx("h-11 rounded-xl px-3.5 text-sm font-semibold", braceAction === k ? "bg-primary text-on-primary" : "border border-border bg-surface")}
            >
              {label}
            </button>
          ))}
        </div>
        {braceAction === "set" ? (
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label="Seite">
              <Select name="braceSide" defaultValue="right"><option value="right">rechts</option><option value="left">links</option></Select>
            </Field>
            <Field label="Zehe">
              <Select name="braceToe" defaultValue="1">{[1, 2, 3, 4, 5].map((t) => <option key={t} value={t}>D{t}</option>)}</Select>
            </Field>
            <Field label="Stadium"><Select name="braceStage" defaultValue="2"><option value="1">1</option><option value="2">2</option><option value="3">3</option></Select></Field>
            <Field label="Spangentyp/Produkt" className="col-span-2 sm:col-span-1"><Input name="braceType" placeholder="z. B. 3-teilige Drahtspange" aria-required="true" /></Field>
          </div>
        ) : null}
        {braceAction === "check" ? (
          <Field label="Spangenwechsel? Neuer Typ + Begründung (Pflicht bei Wechsel)" className="mt-4">
            <Input name="braceChange" placeholder="leer lassen, wenn kein Wechsel" />
          </Field>
        ) : null}
        {requiredPurpose ? (
          <p className={cx("mt-4 rounded-xl p-3 text-sm font-medium", requiredDone ? "bg-primary-soft text-primary-soft-text" : "bg-warn-soft text-warn-soft-text")}>
            {requiredDone ? "✓ Pflichtfoto vorhanden." : `Pflichtfoto „${PURPOSES[requiredPurpose]}“ fehlt. Bitte unten aufnehmen oder begründen, warum es fehlt.`}
          </p>
        ) : null}
        {requiredPurpose && !requiredDone ? (
          <Field label="Begründung, falls kein Foto möglich" className="mt-3">
            <Input name="missingPhotoReason" placeholder="z. B. Kamera defekt, Foto wird nachgereicht" />
          </Field>
        ) : null}
          </div>
        </details>
      </Card>

      <Card>
        <h2 className="mb-3 font-display text-lg font-semibold">Fotos</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Anlass" className="col-span-2 sm:col-span-1">
            <Select value={photoMeta.purpose} onChange={(e) => setPhotoMeta({ ...photoMeta, purpose: e.target.value })}>
              {Object.entries(PURPOSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="Seite">
            <Select value={photoMeta.footSide} onChange={(e) => setPhotoMeta({ ...photoMeta, footSide: e.target.value })}>
              <option value="right">rechts</option><option value="left">links</option>
            </Select>
          </Field>
          <Field label="Zehe">
            <Select value={photoMeta.toe} onChange={(e) => setPhotoMeta({ ...photoMeta, toe: e.target.value })}>
              {[1, 2, 3, 4, 5].map((t) => <option key={t} value={t}>D{t}</option>)}
            </Select>
          </Field>
          <Field label="Ansicht">
            <Select value={photoMeta.view} onChange={(e) => setPhotoMeta({ ...photoMeta, view: e.target.value })}>
              {VIEWS.map((v) => <option key={v}>{v}</option>)}
            </Select>
          </Field>
        </div>
        {/* capture="environment" öffnet auf iPhone/iPad direkt die Kamera; Fotos landen NICHT in der Mediathek */}
        <input ref={fileRef} type="file" accept="image/*" capture="environment" className="sr-only" id="photo-input" onChange={(e) => upload(e.target.files)} />
        <label
          htmlFor="photo-input"
          className="mt-4 flex h-14 cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border-strong text-[15px] font-semibold hover:bg-surface-2"
        >
          {uploading ? <Loader2 className="animate-spin" size={20} aria-hidden /> : <Camera size={20} aria-hidden />}
          {uploading ? "Wird verschlüsselt hochgeladen …" : "Foto aufnehmen"}
        </label>
        <p className="mt-2 text-[13px] leading-5 text-muted">Tipp: gleicher Abstand und gleiches Licht wie beim letzten Foto, damit der Verlauf vergleichbar ist.</p>
        <FormError message={uploadError} />
        {uploads.length ? (
          <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-5">
            {uploads.map((u) => (
              <figure key={u.id} className="relative overflow-hidden rounded-xl bg-surface-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u.preview} alt={PURPOSES[u.purpose]} className="aspect-square w-full object-cover" />
                <figcaption className="px-2 py-1 text-xs">
                  {PURPOSES[u.purpose]} · {u.footSide === "left" ? "li" : "re"} D{u.toe}
                </figcaption>
                <button
                  type="button"
                  aria-label="Foto aus diesem Eintrag entfernen"
                  className="absolute right-1 top-1 inline-flex size-11 items-center justify-center rounded-lg bg-surface/90"
                  onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}
                >
                  <Trash2 size={16} aria-hidden />
                </button>
              </figure>
            ))}
          </div>
        ) : null}
      </Card>

      <Card>
        <h2 className="mb-3 font-display text-lg font-semibold">Befund am Fuß</h2>
        <FootFindings value={points} onChange={setPoints} />
      </Card>

      <Card>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Befund">
            <Textarea name="findings" value={fields.findings} onChange={(e) => setFields({ ...fields, findings: e.target.value })} rows={4} />
          </Field>
          <Field label="Reaktion / Besonderheiten">
            <Textarea name="reaction" value={fields.reaction} onChange={(e) => setFields({ ...fields, reaction: e.target.value })} rows={4} />
          </Field>
          <Field label="Material">
            <Input name="material" value={fields.material} onChange={(e) => setFields({ ...fields, material: e.target.value })} />
          </Field>
          <Field label="Sterilgut-Charge">
            <div className="flex gap-2">
              <Input name="sterileBatchCode" value={batch} onChange={(e) => setBatch(e.target.value)} onBlur={(e) => checkBatch(e.target.value)} placeholder="Etikett scannen oder eintippen" />
              <BatchScanner onCode={(c) => { setBatch(c); void checkBatch(c); }} />
            </div>
          {batchHint ? (
              <p className={cx("mt-1 rounded-lg px-2 py-1 text-xs font-semibold", batchHint.ok ? "bg-primary-soft text-primary-soft-text" : "bg-accent-soft text-accent-soft-text")}>{batchHint.message}</p>
            ) : null}
          </Field>
          <Field label="Empfehlung / nächster Termin" className="md:col-span-2">
            <Textarea name="recommendation" value={fields.recommendation} onChange={(e) => setFields({ ...fields, recommendation: e.target.value })} rows={2} />
          </Field>
        </div>
        {ai ? <p className="mt-3"><Badge tone="info">KI-unterstützt – bitte alle Felder prüfen</Badge></p> : null}
        <div className="mt-4">
          <Checkbox
            ref={confirmRef}
            name="confirm"
            aria-required="true"
            aria-invalid={confirmError ? true : undefined}
            aria-describedby={confirmError ? "doku-confirm-fehler" : undefined}
            onChange={(e) => e.target.checked && setConfirmError(null)}
            label="Ich habe die Angaben geprüft. Nach dem Speichern ist der Eintrag unveränderbar (nur Nachträge, § 630f BGB)."
          />
          {confirmError ? (
            <p id="doku-confirm-fehler" className="ml-8 text-[13px] leading-5 font-medium text-danger">{confirmError}</p>
          ) : null}
        </div>
      </Card>

      {/* Klebende Aktionsleiste (ui.tsx FormActions): über Bottom-Navigation und Home-Leiste, Primärfarbe */}
      <FormActions error={state?.error}>
        <Button type="submit" disabled={pending || uploading} className="h-12 flex-[1_1_16rem] text-base">
          {pending ? "Wird gespeichert …" : uploading ? "Foto wird hochgeladen …" : <><Check size={20} aria-hidden /> Prüfen und abschließen</>}
        </Button>
      </FormActions>
    </form>
  );
}

/** Sprachbericht: aufnehmen → transkribieren → KI ordnet in Felder. Audio wird danach nicht gespeichert. */
function VoiceReport({ patientId, onResult }: { patientId: string; onResult: (r: Partial<Record<"findings" | "servicesText" | "material" | "reaction" | "recommendation", string>>) => void }) {
  const [status, setStatus] = useState<"idle" | "rec" | "busy" | "done" | "error">("idle");
  const [mock, setMock] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      const r = new MediaRecorder(stream, { mimeType: mime });
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setStatus("busy");
        try {
          const blob = new Blob(chunks.current, { type: mime });
          const fd = new FormData();
          fd.set("audio", blob, `bericht.${mime === "audio/webm" ? "webm" : "m4a"}`);
          fd.set("patientId", patientId);
          const res = await fetch("/api/ai/voice-report", { method: "POST", body: fd });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error ?? "Verarbeitung fehlgeschlagen");
          setTranscript(json.transcript);
          setMock(json.mock === true);
          // Testmodus: nur Beispieltext anzeigen, KEINE Felder befüllen (keine erfundenen Befunde in der Akte)
          if (json.mock !== true) onResult(json.fields ?? {});
          setStatus("done");
        } catch (e) {
          setError(e instanceof Error ? e.message : "Fehler");
          setStatus("error");
        }
      };
      r.start(1000);
      rec.current = r;
      setSeconds(0);
      timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
      setStatus("rec");
    } catch {
      setError("Kein Mikrofonzugriff. Bitte in den Einstellungen erlauben.");
      setStatus("error");
    }
  }
  function stop() {
    if (timer.current) clearInterval(timer.current);
    rec.current?.stop();
  }

  return (
    <Card>
      <h2 className="mb-3 font-display text-lg font-semibold">Besuchsbericht einsprechen</h2>
      {status === "rec" ? (
        <Button type="button" onClick={stop} className="h-14 w-full bg-danger text-white hover:bg-danger">
          <Square size={18} aria-hidden /> Aufnahme läuft {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} · Stopp
        </Button>
      ) : (
        <Button type="button" onClick={start} disabled={status === "busy"} className="h-14 w-full">
          {status === "busy" ? <Loader2 className="animate-spin" size={20} aria-hidden /> : <Mic size={20} aria-hidden />}
          {status === "busy" ? "Wird transkribiert und sortiert …" : status === "done" ? "Neu einsprechen" : "Bericht einsprechen"}
        </Button>
      )}
      <FormError message={error} />
      {mock ? (
        <p role="status" className="mt-3 flex items-center gap-2 rounded-xl bg-warn-soft p-3 text-sm font-medium text-warn-soft-text">
          <Badge tone="warn">Testmodus</Badge> Kein echter KI-Dienst angebunden – das Transkript ist ein Beispieltext und wurde nicht in die Felder übernommen.
        </p>
      ) : null}
      {transcript ? (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-semibold text-primary">Transkript anzeigen</summary>
          <p className="mt-2 whitespace-pre-wrap rounded-xl bg-surface-2 p-3">{transcript}</p>
        </details>
      ) : (
        <p className="mt-2 text-xs text-muted">Freihändig sprechen, z. B. „Rechts D1 Unguis incarnatus Stadium 2, Spange gesetzt, Kontrolle in vier Wochen“. Die KI füllt die Felder, du prüfst.</p>
      )}
    </Card>
  );
}

/** Barcode/QR des Sterilguts mit der Kamera lesen (BarcodeDetector, falls vom Browser unterstützt). */
function BatchScanner({ onCode }: { onCode: (c: string) => void }) {
  const [busy, setBusy] = useState(false);
  const supported = typeof window !== "undefined" && "BarcodeDetector" in window;
  if (!supported) return null;
  async function scan(file: File) {
    setBusy(true);
    try {
      // @ts-expect-error BarcodeDetector ist noch nicht in den TS-DOM-Typen
      const detector = new window.BarcodeDetector();
      const bmp = await createImageBitmap(file);
      const codes = await detector.detect(bmp);
      if (codes[0]?.rawValue) onCode(codes[0].rawValue);
    } finally {
      setBusy(false);
    }
  }
  return (
    <label className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-border bg-surface" title="Etikett scannen">
      <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => e.target.files?.[0] && scan(e.target.files[0])} />
      {busy ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <ScanLine size={18} aria-hidden />}
      <span className="sr-only">Etikett scannen</span>
    </label>
  );
}
