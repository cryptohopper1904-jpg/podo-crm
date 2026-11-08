"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Button, Card, FormError, FormSuccess, cx } from "@/components/ui";
import { keepValues } from "@/lib/forms";
import { bookPortalAppointmentAction } from "@/server/portal";

type S = { id: string; name: string; priceCents: number; durationMin: number };
type Day = { date: string; slots: Record<number, string[]> };
const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const dayLabel = (iso: string) => new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
const timeLabel = (iso: string) => new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" }).format(new Date(iso));

export function PortalBookingForm({ services, days, reschedule, phone }: { services: S[]; days: Day[]; reschedule: { id: string; durationMin: number } | null; phone: string | null }) {
  const [state, action, pending] = useActionState(bookPortalAppointmentAction, undefined);
  const [svc, setSvc] = useState<S | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  if (state?.ok)
    return (
      <div className="flex flex-col gap-4">
        <FormSuccess message={state.ok} />
        <Link href="/portal" className="font-semibold text-primary hover:underline">Zur Übersicht</Link>
      </div>
    );
  const duration = reschedule?.durationMin ?? svc?.durationMin ?? null;
  const slots = duration && date ? days.find((d) => d.date === date)?.slots[duration] ?? [] : [];
  const anyFree = duration ? days.some((d) => d.slots[duration]?.length) : true;
  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-6">
      <input type="hidden" name="serviceId" value={svc?.id ?? ""} />
      <input type="hidden" name="appointmentId" value={reschedule?.id ?? ""} />
      <input type="hidden" name="startsAt" value={slot ?? ""} />
      <FormError message={state?.error ? `${state.error}${state.phone ? ` Telefon: ${state.phone}` : ""}` : null} />
      {!reschedule ? (
        <Card>
          <h2 className="mb-3 font-display text-lg font-semibold">1. Leistung</h2>
          {services.length === 0 ? (
            <p className="text-sm text-muted">Derzeit sind keine Leistungen online buchbar.{phone ? ` Telefon: ${phone}` : ""}</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {services.map((s) => (
                <button key={s.id} type="button" aria-pressed={svc?.id === s.id} onClick={() => { setSvc(s); setSlot(null); }}
                  className={cx("rounded-xl p-4 text-left", svc?.id === s.id ? "bg-primary text-on-primary" : "border border-border bg-surface hover:bg-surface-2")}>
                  <span className="block font-semibold">{s.name}</span>
                  <span className="text-sm opacity-80">{s.durationMin} Min · {eur.format(s.priceCents / 100)}</span>
                </button>
              ))}
            </div>
          )}
        </Card>
      ) : null}
      {duration ? (
        <Card>
          <h2 className="mb-3 font-display text-lg font-semibold">{reschedule ? "1." : "2."} Tag und Uhrzeit</h2>
          {!anyFree ? (
            <p className="text-sm text-muted">In den nächsten 6 Wochen ist online leider nichts frei.{phone ? ` Bitte rufen Sie uns an: ${phone}` : ""}</p>
          ) : (
            <>
              <div className="flex gap-2 overflow-x-auto pb-2" role="group" aria-label="Tag wählen">
                {days.map((d) => (
                  <button key={d.date} type="button" disabled={!d.slots[duration]?.length} aria-pressed={date === d.date} onClick={() => { setDate(d.date); setSlot(null); }}
                    className={cx("h-14 min-w-20 shrink-0 rounded-xl px-3 text-sm font-semibold disabled:opacity-40", date === d.date ? "bg-primary text-on-primary" : "border border-border bg-surface")}>
                    {dayLabel(d.date)}
                  </button>
                ))}
              </div>
              {date ? (
                <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Uhrzeit wählen">
                  {slots.length ? slots.map((t) => (
                    <button key={t} type="button" aria-pressed={slot === t} onClick={() => setSlot(t)} className={cx("h-11 rounded-xl px-4 font-semibold tabular-nums", slot === t ? "bg-accent text-on-accent" : "border border-border bg-surface")}>{timeLabel(t)}</button>
                  )) : <p className="text-sm text-muted">An diesem Tag ist leider nichts mehr frei.</p>}
                </div>
              ) : null}
            </>
          )}
        </Card>
      ) : null}
      {duration && date && slot ? (
        <Card>
          <p className="text-sm text-muted">Nicht rechtzeitig (24 h vorher) abgesagte Termine können in Rechnung gestellt werden.</p>
          <Button type="submit" disabled={pending} className="mt-4 w-full">
            {pending ? "Wird gebucht …" : `${reschedule ? "Verschieben auf" : "Verbindlich buchen"}: ${dayLabel(date)}, ${timeLabel(slot)} Uhr`}
          </Button>
        </Card>
      ) : null}
    </form>
  );
}
