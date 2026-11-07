"use client";

import { useActionState, useMemo, useState } from "react";
import { Button, Card, Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui";
import { createAppointmentAction } from "../actions";

type P = { id: string; number: number; firstName: string | null; lastName: string };
type S = { id: string; code: string; name: string; durationMin: number };
type T = { id: string; name: string };

export function AppointmentForm({ patients, services, team, defaults }: { patients: P[]; services: S[]; team: T[]; defaults: { patientId: string; date: string; therapistId: string } }) {
  const [state, action, pending] = useActionState(createAppointmentAction, undefined);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const duration = useMemo(() => services.filter((s) => picked.includes(s.id)).reduce((a, s) => a + s.durationMin, 0) || 30, [picked, services]);
  const shown = filter ? patients.filter((p) => `${p.lastName} ${p.firstName ?? ""} ${p.number}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 50) : patients.slice(0, 300);
  return (
    <form action={action} className="flex flex-col gap-6">
      <FormError message={state?.error} />
      {state?.conflict ? <Checkbox name="allowConflict" value="1" label="Trotzdem eintragen (Doppelbelegung)" /> : null}
      <Card>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Kunde suchen">
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name oder Nummer" />
          </Field>
          <Field label="Kunde">
            <Select name="patientId" defaultValue={defaults.patientId}>
              <option value="">– kein Kunde (Blocker/Pause) –</option>
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
              <input type="checkbox" name="serviceId" value={s.id} className="sr-only" onChange={(e) => setPicked((x) => (e.target.checked ? [...x, s.id] : x.filter((y) => y !== s.id)))} />
              {s.code} · {s.durationMin} Min
            </label>
          ))}
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-4">
          <Field label="Datum"><Input type="date" name="date" defaultValue={defaults.date} required /></Field>
          <Field label="Uhrzeit"><Input type="time" name="time" step={300} defaultValue="09:00" required /></Field>
          <Field label="Dauer (Min)"><Input type="number" name="durationMin" key={duration} defaultValue={duration} min={5} max={480} /></Field>
          <Field label="Behandler:in">
            <Select name="therapistId" defaultValue={defaults.therapistId}>{team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
          </Field>
          <Field label="Quelle">
            <Select name="source" defaultValue="phone">
              <option value="phone">Telefon</option><option value="manual">Praxis</option><option value="whatsapp">WhatsApp</option><option value="email">E-Mail</option><option value="doctolib">Doctolib</option><option value="online">Online</option>
            </Select>
          </Field>
          <Field label="Wiederholen alle … Wochen"><Input type="number" name="repeatWeeks" min={0} max={26} defaultValue={0} /></Field>
          <Field label="Anzahl Termine"><Input type="number" name="repeatCount" min={1} max={12} defaultValue={1} /></Field>
          <div className="flex items-end"><Checkbox name="homeVisit" label="Hausbesuch" /></div>
        </div>
        <Field label="Notiz" className="mt-4"><Textarea name="notes" rows={2} /></Field>
      </Card>
      <Button type="submit" disabled={pending}>{pending ? "Speichern …" : "Termin eintragen"}</Button>
    </form>
  );
}
