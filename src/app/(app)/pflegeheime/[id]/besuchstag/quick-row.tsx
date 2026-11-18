"use client";

import { keepValues } from "@/lib/forms";
import { useActionState, useState } from "react";
import { deviationHint } from "@/lib/deviation-hint";
import { Check, PenLine } from "lucide-react";
import { SignatureField } from "@/components/signature-field";
import { Button, Input, Select, cx } from "@/components/ui";
import { quickRecordAction, type QuickRecordState } from "../../actions";

type Service = { id: string; code: string; name: string };
type Vo = { id: string; label: string; remaining: number; warning: string | null; deviationText?: string | null };

/** Eine Zeile der Listen-Doku: Leistungs-Chips + kurzer Befund + Speichern. */
export function QuickRow({ careHomeId, patientId, patientName, services, prescriptions }: { careHomeId: string; patientId: string; patientName: string; services: Service[]; prescriptions: Vo[] }) {
  const [state, action, pending] = useActionState<QuickRecordState, FormData>(quickRecordAction, undefined);
  const [picked, setPicked] = useState<string[]>([]);
  const [prescriptionId, setPrescriptionId] = useState(prescriptions.length === 1 ? prescriptions[0].id : "");
  const done = !!state?.ok;
  // Unterschrift (Leistungsnachweis) nur bei Behandlung auf Verordnung; aufklappbar, damit die Liste kompakt bleibt
  const [signing, setSigning] = useState(false);
  // Server-Hinweis gehört zur beim Speichern gewählten VO: nach einem Wechsel der Auswahl verwerfen (bis zum nächsten Speichern)
  const [staleState, setStaleState] = useState<QuickRecordState>(undefined);
  // Abweichung laut Seitenstand oder – falls erst beim Speichern erkannt – laut Server (PR #111 C5)
  const deviation = deviationHint({ selected: !!prescriptionId, pageText: prescriptions.find((p) => p.id === prescriptionId)?.deviationText, serverText: state?.deviationText, serverStale: state === staleState });
  const servicesText = services.filter((s) => picked.includes(s.id)).map((s) => s.name).join(", ");
  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-2">
      <input type="hidden" name="careHomeId" value={careHomeId} />
      <input type="hidden" name="patientId" value={patientId} />
      <input type="hidden" name="servicesText" value={servicesText} />
      <fieldset disabled={done || pending} className="flex flex-col gap-2">
        <legend className="sr-only">Leistungen</legend>
        <div className="flex flex-wrap gap-1.5">
          {services.map((s) => {
            const on = picked.includes(s.id);
            return (
              <button
                key={s.id}
                type="button"
                aria-pressed={on}
                title={s.name}
                onClick={() => setPicked(on ? picked.filter((x) => x !== s.id) : [...picked, s.id])}
                className={cx("h-10 rounded-lg px-3 text-sm font-semibold", on ? "bg-primary text-on-primary" : "border border-border bg-surface")}
              >
                {s.code}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input name="findings" placeholder="Kurzbefund (z. B. o. B., Hyperkeratose re. Ferse)" className="min-w-56 flex-1" maxLength={2000} aria-label="Kurzbefund" />
          {prescriptions.length ? (
            <Select name="prescriptionId" value={prescriptionId} onChange={(e) => {
                setPrescriptionId(e.target.value);
                setStaleState(state);
              }}
              className="w-auto max-w-72" aria-label="Verordnung">
              <option value="">ohne Verordnung</option>
              {prescriptions.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
          ) : null}
          {deviation ? (
            <Input name="frequencyDeviationNote" required minLength={5} maxLength={500} placeholder="Begründung Frequenzabweichung (Absprache Arzt)" className="min-w-56 flex-1" aria-label="Begründung Frequenzabweichung" title={deviation} />
          ) : null}
          {prescriptionId ? (
            <Button type="button" variant="ghost" className="h-11 text-sm" aria-expanded={signing} onClick={() => setSigning(!signing)}>
              <PenLine size={16} aria-hidden /> Unterschrift
            </Button>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="confirm" required className="size-5 accent-[var(--primary)]" /> geprüft
          </label>
          <Button type="submit" variant={done ? "secondary" : "accent"} className="h-11">
            {done ? <><Check size={18} aria-hidden /> Gespeichert</> : pending ? "…" : "Speichern"}
          </Button>
        </div>
        {prescriptionId && signing ? <SignatureField key={prescriptionId} patientName={patientName} compact /> : null}
      </fieldset>
      {deviation ? (
        <p className="text-xs text-warn-soft-text">
          {deviation} Abweichung nur nach Absprache mit der verordnenden Ärztin/dem Arzt – Absprache im Feld „Begründung“ dokumentieren. Zwei Einträge am selben Tag (z. B. Befundung und Behandlung) gelten nicht als Abweichung.
        </p>
      ) : null}
      {state?.error ? <p role="alert" className="text-sm font-medium text-danger">{state.error}</p> : null}
    </form>
  );
}
