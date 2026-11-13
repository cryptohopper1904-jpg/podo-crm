"use client";

import { keepValues } from "@/lib/forms";
import { useActionState, useMemo, useRef, useState } from "react";
import { Button, Card, Checkbox, Field, FieldSlot, FormError, Input, Select, Textarea } from "@/components/ui";
import { createAppointmentAction } from "../actions";
import { FreeSlotFinder, type PickedSlot } from "../free-slot-finder";
import { SlotWarning, slotQueryFromForm, type SlotQuery } from "../slot-warning";

type P = { id: string; number: number; firstName: string | null; lastName: string };
type S = { id: string; code: string; name: string; durationMin: number };
type T = { id: string; name: string };

export function AppointmentForm({ patients, services, team, defaults }: { patients: P[]; services: S[]; team: T[]; defaults: { patientId: string; date: string; time: string; therapistId: string; durationMin: number; serviceIds: string[]; todayIso: string } }) {
  const [state, action, pending] = useActionState(createAppointmentAction, undefined);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string[]>(defaults.serviceIds);
  const formRef = useRef<HTMLFormElement>(null);
  const duration = useMemo(() => services.filter((s) => picked.includes(s.id)).reduce((a, s) => a + s.durationMin, 0) || defaults.durationMin, [picked, services, defaults.durationMin]);
  const [slot, setSlot] = useState<SlotQuery>({ therapistId: defaults.therapistId, date: defaults.date, time: defaults.time, durationMin: defaults.durationMin });
  // Dauer: aus den Leistungen, bis sie von Hand geändert wird (das Feld wird bei neuer Leistungsdauer neu belegt)
  const [durOverride, setDurOverride] = useState<{ forDuration: number; value: number } | null>(null);
  const slotDuration = durOverride?.forDuration === duration ? durOverride.value : duration;
  const shown = filter ? patients.filter((p) => `${p.lastName} ${p.firstName ?? ""} ${p.number}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 50) : patients.slice(0, 300);
  /** Vorschlag aus „Freien Termin finden“ ins Formular übernehmen */
  const pick = (p: PickedSlot) => {
    const f = formRef.current;
    if (!f) return;
    const set = (name: string, v: string) => {
      const el = f.elements.namedItem(name);
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.value = v;
    };
    set("date", p.date);
    set("time", p.time);
    set("therapistId", p.therapistId);
    setSlot(slotQueryFromForm(f, duration));
    f.querySelector<HTMLInputElement>("input[name=time]")?.focus();
  };
  return (
    <div className="flex flex-col gap-6">
    <FreeSlotFinder todayIso={defaults.todayIso} team={team} defaultTherapistId={defaults.therapistId} duration={slotDuration} onPick={pick} />
    <form ref={formRef} onSubmit={keepValues(action)} onChange={(e) => {
        const q = slotQueryFromForm(e.currentTarget, duration);
        if ((e.target as unknown as { name?: string }).name === "durationMin") setDurOverride({ forDuration: duration, value: q.durationMin });
        setSlot(q);
      }} className="flex flex-col gap-6">
      <FormError message={state?.error} />
      {state?.conflict ? <Checkbox name="allowConflict" value="1" label="Trotzdem eintragen (Doppelbelegung bzw. trotz Abwesenheit)" /> : null}
      <Card>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Patient suchen">
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name oder Nummer" />
          </Field>
          <Field label="Patient">
            <Select name="patientId" defaultValue={defaults.patientId}>
              <option value="">– kein Patient (Blocker/Pause) –</option>
              {shown.map((p) => <option key={p.id} value={p.id}>{p.lastName}{p.firstName ? `, ${p.firstName}` : ""} (#{p.number})</option>)}
            </Select>
          </Field>
          <Field label="Titel (optional)" className="sm:col-span-2"><Input name="title" placeholder="wird sonst aus den Leistungen gebildet" /></Field>
        </div>
      </Card>
      <Card>
        <p className="mb-2 text-sm font-medium">Leistungen (bestimmen die Dauer)</p>
        <div className="flex flex-wrap gap-2">
          {services.map((s) => (
            <label key={s.id} className={`flex h-11 cursor-pointer items-center gap-2 rounded-xl px-3.5 text-sm font-semibold ${picked.includes(s.id) ? "bg-primary text-on-primary" : "border border-border bg-surface"}`}>
              <input type="checkbox" name="serviceId" value={s.id} className="sr-only" defaultChecked={defaults.serviceIds.includes(s.id)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, s.id] : x.filter((y) => y !== s.id)))} />
              {s.code} · {s.durationMin} Min
            </label>
          ))}
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-4">
          <Field label="Datum"><Input type="date" name="date" defaultValue={defaults.date} required /></Field>
          <Field label="Uhrzeit"><Input type="time" name="time" step={300} defaultValue={defaults.time} required /></Field>
          <Field label="Dauer"><Input suffix="Min" type="number" name="durationMin" key={duration} defaultValue={duration} min={5} max={480} /></Field>
          <Field label="Behandler:in">
            <Select name="therapistId" defaultValue={defaults.therapistId}>{team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
          </Field>
          <Field label="Quelle">
            <Select name="source" defaultValue="phone">
              <option value="phone">Telefon</option><option value="manual">Praxis</option><option value="whatsapp">WhatsApp</option><option value="email">E-Mail</option><option value="doctolib">Doctolib</option><option value="online">Online</option>
            </Select>
          </Field>
          <Field label="Wiederholen alle" hint="0 = einmaliger Termin"><Input suffix="Wochen" type="number" name="repeatWeeks" min={0} max={26} defaultValue={0} /></Field>
          <Field label="Anzahl Termine"><Input type="number" name="repeatCount" min={1} max={12} defaultValue={1} /></Field>
          <FieldSlot spacer="hidden sm:block"><Checkbox name="homeVisit" label="Hausbesuch" /></FieldSlot>
        </div>
        <div className="mt-4"><SlotWarning query={{ ...slot, durationMin: slotDuration }} /></div>
        <Field label="Notiz" className="mt-4"><Textarea name="notes" rows={2} /></Field>
      </Card>
      <Button type="submit" disabled={pending}>{pending ? "Speichern …" : "Termin eintragen"}</Button>
    </form>
    </div>
  );
}
