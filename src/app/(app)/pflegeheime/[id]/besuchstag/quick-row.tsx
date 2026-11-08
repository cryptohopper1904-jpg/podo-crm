"use client";

import { keepValues } from "@/lib/forms";
import { useActionState, useState } from "react";
import { Check } from "lucide-react";
import { Button, Input, Select, cx } from "@/components/ui";
import { quickRecordAction, type QuickRecordState } from "../../actions";

type Service = { id: string; code: string; name: string };
type Vo = { id: string; label: string; remaining: number; warning: string | null };

/** Eine Zeile der Listen-Doku: Leistungs-Chips + kurzer Befund + Speichern. */
export function QuickRow({ careHomeId, patientId, services, prescriptions }: { careHomeId: string; patientId: string; services: Service[]; prescriptions: Vo[] }) {
  const [state, action, pending] = useActionState<QuickRecordState, FormData>(quickRecordAction, undefined);
  const [picked, setPicked] = useState<string[]>([]);
  const [prescriptionId, setPrescriptionId] = useState(prescriptions.length === 1 ? prescriptions[0].id : "");
  const done = !!state?.ok;
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
            <Select name="prescriptionId" value={prescriptionId} onChange={(e) => setPrescriptionId(e.target.value)} className="w-auto max-w-72" aria-label="Verordnung">
              <option value="">ohne Verordnung</option>
              {prescriptions.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="confirm" required className="size-5 accent-[var(--primary)]" /> geprüft
          </label>
          <Button type="submit" variant={done ? "secondary" : "accent"} className="h-11">
            {done ? <><Check size={18} aria-hidden /> Gespeichert</> : pending ? "…" : "Speichern"}
          </Button>
        </div>
      </fieldset>
      {state?.error ? <p role="alert" className="text-sm font-medium text-danger">{state.error}</p> : null}
    </form>
  );
}
