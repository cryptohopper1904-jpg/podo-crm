"use client";

import { keepValues } from "@/lib/forms";
import { useActionState, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button, Card, Checkbox, Field, FieldSlot, FormActions, FormError, Input, LinkButton, Select, Textarea } from "@/components/ui";
import type { PickerPatient } from "@/lib/calendar-patient-search";
import { createAppointmentAction, createAppointmentInDialogAction, type DialogApptState } from "../actions";
import { FreeSlotFinder, type PickedSlot } from "../free-slot-finder";
import { SlotWarning, slotQueryFromForm, type SlotQuery } from "../slot-warning";
import { PatientPicker } from "./patient-picker";

type S = { id: string; code: string; name: string; durationMin: number };
type T = { id: string; name: string };

/**
 * Neuer Termin. Prüfung auf dem Server (noValidate: deutsche Meldungen oben im Formular, werden angesprungen; die
 * Kurzfassung steht neben dem klebenden „Termin eintragen“). Selten Gebrauchtes (Titel, Wiederholung, Hausbesuch,
 * Notiz) unter „Weitere Optionen“ – die Felder bleiben im Formular, auch eingeklappt.
 */
export function AppointmentForm({
  patients,
  services,
  team,
  defaults,
  cancelHref,
  blocksTab,
  canCreatePatients = false,
  variant = "page",
  onCreated,
  onCancel,
  apply,
}: {
  patients: PickerPatient[];
  services: S[];
  team: T[];
  defaults: { patientId: string; date: string; time: string; therapistId: string; durationMin: number; serviceIds: string[]; todayIso: string };
  cancelHref: string;
  /** Reiter „Sperrzeit“ vorhanden (Hinweis für Einträge ohne Patient:in) */
  blocksTab: boolean;
  /** neue Patient:in direkt aus der Suche anlegen (patients.write) */
  canCreatePatients?: boolean;
  /** „dialog“: im Fenster über dem Kalender – kein Seitenwechsel nach dem Speichern, ohne „Freien Termin finden“ */
  variant?: "page" | "dialog";
  onCreated?: (c: { id: string; date: string; n: number }) => void;
  onCancel?: () => void;
  /** Datum/Uhrzeit/Behandler:in übernehmen (z. B. Klick auf einen anderen freien Platz im Kalender); `n` ändert sich je Klick */
  apply?: { date?: string; time?: string; therapistId?: string; n: number } | null;
}) {
  const dialog = variant === "dialog";
  const [state, action, pending] = useActionState((dialog ? createAppointmentInDialogAction : createAppointmentAction) as (s: DialogApptState, f: FormData) => Promise<DialogApptState>, undefined);
  const [picked, setPicked] = useState<string[]>(defaults.serviceIds);
  const formRef = useRef<HTMLFormElement>(null);
  const duration = useMemo(() => services.filter((s) => picked.includes(s.id)).reduce((a, s) => a + s.durationMin, 0) || defaults.durationMin, [picked, services, defaults.durationMin]);
  const [slot, setSlot] = useState<SlotQuery>({ therapistId: defaults.therapistId, date: defaults.date, time: defaults.time, durationMin: defaults.durationMin });
  // Dauer: aus den Leistungen, bis sie von Hand geändert wird (das Feld wird bei neuer Leistungsdauer neu belegt)
  const [durOverride, setDurOverride] = useState<{ forDuration: number; value: number } | null>(null);
  const slotDuration = durOverride?.forDuration === duration ? durOverride.value : duration;
  const error = pending ? null : state?.error;
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
  const applySlot = useEffectEvent((a: NonNullable<typeof apply>) => {
    const f = formRef.current;
    const cur = (n: string) => (f?.elements.namedItem(n) as HTMLInputElement | null)?.value ?? "";
    pick({ date: a.date ?? cur("date"), time: a.time ?? cur("time"), therapistId: a.therapistId ?? cur("therapistId") });
  });
  useEffect(() => {
    if (apply) applySlot(apply);
  }, [apply]);
  const reported = useRef<unknown>(null);
  useEffect(() => {
    if (state?.created && reported.current !== state) {
      reported.current = state;
      onCreated?.(state.created);
    }
  }, [state, onCreated]);
  return (
    <div className="flex flex-col gap-6">
      {dialog ? null : <FreeSlotFinder todayIso={defaults.todayIso} team={team} defaultTherapistId={defaults.therapistId} duration={slotDuration} onPick={pick} />}
      <form
        ref={formRef}
        noValidate
        onSubmit={keepValues(action)}
        onChange={(e) => {
          const q = slotQueryFromForm(e.currentTarget, duration);
          if ((e.target as unknown as { name?: string }).name === "durationMin") setDurOverride({ forDuration: duration, value: q.durationMin });
          setSlot(q);
        }}
        className="flex flex-col gap-6"
        aria-busy={pending || undefined}
      >
        <FormError message={state?.error} revealKey={state} />
        {state?.conflict ? <Checkbox name="allowConflict" value="1" label="Trotzdem eintragen (Doppelbelegung, Abwesenheit bzw. Sperrzeit)" /> : null}
        <Card>
          <div className="grid grid-cols-1 gap-4">
            <PatientPicker
              patients={patients}
              defaultId={defaults.patientId}
              name="patientId"
              canCreate={canCreatePatients}
              hint={blocksTab ? "Pause, Schulung o. Ä. ohne Patient:in: Reiter „Sperrzeit“ oben." : "Ohne Patient:in: unter „Weitere Optionen“ einen Titel angeben."}
            />
          </div>
        </Card>
        <Card>
          <p className="mb-2 text-sm font-medium" id="leistungen">Leistungen (bestimmen die Dauer)</p>
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby="leistungen">
            {services.map((s) => (
              <label
                key={s.id}
                className={`flex h-11 cursor-pointer items-center gap-2 rounded-xl px-3.5 text-sm font-semibold has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary ${picked.includes(s.id) ? "bg-primary text-on-primary" : "border border-border bg-surface"}`}
              >
                <input type="checkbox" name="serviceId" value={s.id} className="sr-only" defaultChecked={defaults.serviceIds.includes(s.id)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, s.id] : x.filter((y) => y !== s.id)))} />
                {s.code} · {s.durationMin} Min
              </label>
            ))}
          </div>
          <div className={`mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 ${dialog ? "" : "lg:grid-cols-4"}`}>
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
          </div>
          <div className="mt-4"><SlotWarning query={{ ...slot, durationMin: slotDuration }} /></div>
        </Card>
        <details className="group rounded-[var(--radius-card)] border border-border bg-surface">
          <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-5 font-semibold [&::-webkit-details-marker]:hidden">
            Weitere Optionen
            <span className="text-sm font-normal text-muted">Titel, Wiederholung, Hausbesuch, Notiz</span>
            <ChevronDown size={18} aria-hidden className="ml-auto shrink-0 transition-transform group-open:rotate-180" />
          </summary>
          <div className="grid grid-cols-1 gap-4 border-t border-border p-5 sm:grid-cols-2">
            <Field label="Titel (optional)" className="sm:col-span-2"><Input name="title" placeholder="wird sonst aus den Leistungen gebildet" maxLength={200} /></Field>
            <Field label="Wiederholen alle" hint="0 = einmaliger Termin"><Input suffix="Wochen" type="number" stepper name="repeatWeeks" min={0} max={26} defaultValue={0} /></Field>
            <Field label="Anzahl Termine"><Input type="number" stepper name="repeatCount" min={1} max={12} defaultValue={1} /></Field>
            <FieldSlot spacer="hidden"><Checkbox name="homeVisit" label="Hausbesuch" /></FieldSlot>
            <Field label="Notiz" className="sm:col-span-2"><Textarea name="notes" rows={2} maxLength={2000} /></Field>
          </div>
        </details>
        <FormActions error={error} sticky={!dialog} className={dialog ? "sticky bottom-0 z-20 -mx-4 border-t border-border bg-surface px-4 py-3 sm:-mx-5 sm:px-5" : undefined}>
          <Button type="submit" disabled={pending}>{pending ? "Wird eingetragen …" : "Termin eintragen"}</Button>
          {dialog ? (
            <Button type="button" variant="ghost" onClick={onCancel}>Abbrechen</Button>
          ) : (
            <LinkButton variant="ghost" href={cancelHref}>Abbrechen</LinkButton>
          )}
        </FormActions>
      </form>
    </div>
  );
}
