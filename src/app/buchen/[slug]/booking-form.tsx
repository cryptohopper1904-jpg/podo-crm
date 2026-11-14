"use client";

import Link from "next/link";
import { keepValues } from "@/lib/forms";
import { useActionState, useState } from "react";
import { Button, Card, Checkbox, Field, FormError, FormSuccess, Input, Textarea, cx } from "@/components/ui";
import { bookAction } from "./actions";

type S = { id: string; name: string; priceCents: number; durationMin: number };
const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const dayLabel = (iso: string) => new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));

export function BookingForm({ slug, services, days, privacyHref }: { slug: string; services: S[]; days: { date: string; slots: Record<number, string[]> }[]; privacyHref: string }) {
  const [state, action, pending] = useActionState(bookAction, undefined);
  const [svc, setSvc] = useState<S | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  if (state?.ok) return <div className="mt-8"><FormSuccess message={state.ok} /></div>;
  const slots = svc && date ? days.find((d) => d.date === date)?.slots[svc.durationMin] ?? [] : [];
  return (
    <form onSubmit={keepValues(action)} className="mt-8 flex flex-col gap-6">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="serviceId" value={svc?.id ?? ""} />
      <input type="hidden" name="date" value={date ?? ""} />
      <input type="hidden" name="time" value={time ?? ""} />
      <div className="sr-only" aria-hidden><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
      <FormError message={state?.error} />
      <Card>
        <h2 className="mb-3 font-display text-lg font-semibold">1. Leistung</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {services.map((s) => (
            <button key={s.id} type="button" aria-pressed={svc?.id === s.id} onClick={() => { setSvc(s); setTime(null); }}
              className={cx("rounded-xl p-4 text-left", svc?.id === s.id ? "bg-primary text-on-primary" : "border border-border bg-surface hover:bg-surface-2")}>
              <span className="block font-semibold">{s.name}</span>
              <span className="text-sm opacity-80">{s.durationMin} Min · {eur.format(s.priceCents / 100)}</span>
            </button>
          ))}
        </div>
      </Card>
      {svc ? (
        <Card>
          <h2 className="mb-3 font-display text-lg font-semibold">2. Tag und Uhrzeit</h2>
          <div className="flex gap-2 overflow-x-auto pb-2">
            {days.map((d) => (
              <button key={d.date} type="button" disabled={!d.slots[svc.durationMin]?.length} onClick={() => { setDate(d.date); setTime(null); }}
                className={cx("h-14 min-w-20 shrink-0 rounded-xl px-3 text-sm font-semibold disabled:opacity-40", date === d.date ? "bg-primary text-on-primary" : "border border-border bg-surface")}>
                {dayLabel(d.date)}
              </button>
            ))}
          </div>
          {date ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {slots.length ? slots.map((t) => (
                <button key={t} type="button" onClick={() => setTime(t)} className={cx("h-11 rounded-xl px-4 font-semibold tabular-nums", time === t ? "bg-accent text-on-accent" : "border border-border bg-surface")}>{t}</button>
              )) : <p className="text-sm text-muted">An diesem Tag ist leider nichts mehr frei.</p>}
            </div>
          ) : null}
        </Card>
      ) : null}
      {svc && date && time ? (
        <Card>
          <h2 className="mb-3 font-display text-lg font-semibold">3. Ihre Angaben</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Vorname"><Input name="firstName" required autoComplete="given-name" /></Field>
            <Field label="Nachname"><Input name="lastName" required autoComplete="family-name" /></Field>
            <Field label="Mobilnummer"><Input name="phone" type="tel" required autoComplete="tel" /></Field>
            <Field label="E-Mail (optional)"><Input name="email" type="email" autoComplete="email" /></Field>
            <Field label="Nachricht (optional, bitte keine Diagnosen)" className="sm:col-span-2"><Textarea name="note" rows={2} maxLength={500} /></Field>
          </div>
          {/* Information statt Pflicht-Häkchen (Art. 13 DSGVO verlangt Information, keine Bestätigung) */}
          <p className="mt-4 text-sm text-muted">
            Informationen zur Verarbeitung Ihrer Daten finden Sie in den{" "}
            <Link href={privacyHref} className="font-semibold text-primary underline underline-offset-2">Datenschutzhinweisen der Praxis</Link>.
          </p>
          <Checkbox name="noShow" required label="Nicht rechtzeitig (24 h) abgesagte Termine können in Rechnung gestellt werden." />
          <Button type="submit" disabled={pending} className="mt-4 w-full">{pending ? "Wird gesendet …" : `Termin anfragen: ${dayLabel(date)}, ${time} Uhr`}</Button>
        </Card>
      ) : null}
    </form>
  );
}
