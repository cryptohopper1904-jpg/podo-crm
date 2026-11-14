"use client";

import { useActionState, useState } from "react";
import { keepValues } from "@/lib/forms";
import { Button, Card, Checkbox, Field, FieldSlot, FormActions, FormError, Input, LinkButton, Select, Textarea } from "@/components/ui";
import { BLOCK_KINDS, BLOCK_KIND_LABELS, BLOCK_REPEAT_LABELS, BLOCK_REPEATS, type BlockKind, type BlockRepeat } from "@/lib/calendar-blocks";
import { createBlockAction, updateBlockAction } from "./actions";

const WEEKDAYS: [number, string][] = [[1, "Mo"], [2, "Di"], [3, "Mi"], [4, "Do"], [5, "Fr"], [6, "Sa"], [7, "So"]];

export type BlockFormDefaults = {
  /** Person-ID oder „praxis“ (ganze Praxis) */
  userId: string;
  kind: BlockKind;
  title: string;
  startsOn: string;
  endsOn: string;
  allDay: boolean;
  startTime: string;
  endTime: string;
  repeat: BlockRepeat;
  weekdays: number[];
  intervalWeeks: number;
  note: string;
};

/**
 * Sperrzeit anlegen/ändern. `edit`: bestehende Sperrzeit (bei Serien Auswahl „nur dieses Vorkommen“ / „ganze Serie“).
 * Personenauswahl: nur Personen, für die die angemeldete Person Sperrzeiten pflegen darf (Server prüft erneut).
 */
export function BlockForm({
  people,
  allowPraxis,
  defaults,
  edit,
  seriesStart,
}: {
  people: { id: string; name: string }[];
  allowPraxis: boolean;
  defaults: BlockFormDefaults;
  edit?: { id: string; series: boolean; occurrence: string; occurrenceLabel: string };
  /** Beginn der Serie (beim Bearbeiten „ganze Serie“; `defaults.startsOn` ist dann das angeklickte Vorkommen) */
  seriesStart?: string;
}) {
  const [state, action, pending] = useActionState(edit ? updateBlockAction : createBlockAction, undefined);
  const [allDay, setAllDay] = useState(defaults.allDay);
  const [repeat, setRepeat] = useState<BlockRepeat>(defaults.repeat);
  const [scope, setScope] = useState<"occurrence" | "series">(edit?.series ? "occurrence" : "series");
  // „nur dieses Vorkommen“ wird als einzelne Sperrzeit gespeichert – Wiederholung gibt es dann nicht
  const repeatLocked = !!edit?.series && scope === "occurrence";
  const effRepeat = repeatLocked ? "none" : repeat;
  const dateDefault = edit?.series && scope === "series" ? (seriesStart ?? defaults.startsOn) : defaults.startsOn;
  return (
    <form onSubmit={keepValues(action)} noValidate className="flex flex-col gap-6" aria-busy={pending || undefined}>
      {edit ? (
        <>
          <input type="hidden" name="id" value={edit.id} />
          <input type="hidden" name="occurrence" value={edit.occurrence} />
        </>
      ) : null}
      {/* Prüfung auf dem Server (deutsche Meldungen, werden angesprungen) – nicht per Browser-Blase */}
      <FormError message={state?.error} revealKey={state} />
      {edit?.series ? (
        <Card>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Was soll geändert werden?</legend>
            <label className="flex min-h-11 items-center gap-3 text-[15px]">
              <input type="radio" name="scope" value="occurrence" checked={scope === "occurrence"} onChange={() => setScope("occurrence")} className="size-5 accent-[var(--primary)]" />
              <span>Nur dieses Vorkommen ({edit.occurrenceLabel})</span>
            </label>
            <label className="flex min-h-11 items-center gap-3 text-[15px]">
              <input type="radio" name="scope" value="series" checked={scope === "series"} onChange={() => setScope("series")} className="size-5 accent-[var(--primary)]" />
              <span>Ganze Serie <span className="text-sm text-muted">(ändert auch vergangene Vorkommen)</span></span>
            </label>
          </fieldset>
        </Card>
      ) : (
        <input type="hidden" name="scope" value="series" />
      )}
      <Card>
        <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <Field label="Art">
            <Select name="kind" defaultValue={defaults.kind}>
              {BLOCK_KINDS.map((k) => <option key={k} value={k}>{BLOCK_KIND_LABELS[k]}</option>)}
            </Select>
          </Field>
          <Field label="Titel (optional)" hint="sonst wird die Art angezeigt">
            <Input name="title" defaultValue={defaults.title} maxLength={120} placeholder="z. B. Mittagspause, Teamschulung" />
          </Field>
          <Field label="Für" className="sm:col-span-2">
            <Select name="userId" defaultValue={defaults.userId}>
              {allowPraxis ? <option value="praxis">Ganze Praxis (alle Behandler:innen)</option> : null}
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        </div>
      </Card>
      <Card>
        <div className="grid gap-4 sm:grid-cols-4 [&>*]:min-w-0">
          <Field label={effRepeat === "none" ? "Datum" : "Ab"}>
            <Input key={scope} type="date" name="startsOn" defaultValue={dateDefault} required />
          </Field>
          <Field label="Beginn">
            <Input type="time" name="startTime" step={300} defaultValue={defaults.startTime} disabled={allDay} required={!allDay} />
          </Field>
          <Field label="Ende" hint="23:59 = bis Tagesende">
            <Input type="time" name="endTime" step={300} defaultValue={defaults.endTime} disabled={allDay} required={!allDay} />
          </Field>
          <FieldSlot spacer="hidden sm:block">
            <Checkbox name="allDay" value="1" label="ganztägig" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          </FieldSlot>
          <Field label="Wiederholung">
            <Select name="repeat" value={effRepeat} onChange={(e) => setRepeat(e.target.value as BlockRepeat)} disabled={repeatLocked}>
              {BLOCK_REPEATS.map((r) => <option key={r} value={r}>{BLOCK_REPEAT_LABELS[r]}</option>)}
            </Select>
          </Field>
          {repeatLocked ? <input type="hidden" name="repeat" value="none" /> : null}
          {effRepeat === "weekly" ? (
            <Field label="Alle" hint="1 = jede Woche, 2 = jede zweite …">
              <Input type="number" stepper name="intervalWeeks" min={1} max={12} defaultValue={defaults.intervalWeeks} suffix="Wochen" />
            </Field>
          ) : null}
          {effRepeat !== "none" ? (
            <Field label="Bis (optional)" hint="leer = ohne Ende">
              <Input type="date" name="endsOn" defaultValue={defaults.endsOn} min={dateDefault} placeholder="ohne Ende" clearable />
            </Field>
          ) : null}
        </div>
        {effRepeat === "weekly" ? (
          <fieldset className="mt-4">
            <legend className="mb-2 text-sm font-medium">An diesen Wochentagen</legend>
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map(([n, label]) => (
                <label key={n} className="flex h-11 min-w-11 cursor-pointer items-center justify-center rounded-xl border border-border bg-surface px-3 text-sm font-semibold has-[:checked]:border-primary has-[:checked]:bg-primary has-[:checked]:text-on-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary">
                  <input type="checkbox" name="weekday" value={n} defaultChecked={defaults.weekdays.includes(n)} className="sr-only" />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <Field label="Notiz" className="mt-4" hint="Titel und Notiz sind für das ganze Team sichtbar – bitte keine Gesundheits- oder privaten Gründe eintragen.">
          <Textarea name="note" rows={2} defaultValue={defaults.note} maxLength={1000} />
        </Field>
      </Card>
      <p className="text-sm text-muted">In dieser Zeit ist die gewählte Person (bzw. die ganze Praxis) nicht buchbar – weder online, im Portal noch per KI-Telefon. Interne Termine nur nach Rückfrage.</p>
      <FormActions error={pending ? null : state?.error}>
        <Button type="submit" disabled={pending}>{pending ? "Wird gespeichert …" : edit ? "Änderung speichern" : "Sperrzeit eintragen"}</Button>
        <LinkButton variant="ghost" href={`/kalender?datum=${defaults.startsOn}`}>Abbrechen</LinkButton>
      </FormActions>
    </form>
  );
}
