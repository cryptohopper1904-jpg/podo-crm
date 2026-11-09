"use client";

import { useActionState, useState, startTransition, type FormEvent } from "react";
import { Crosshair, History, Home } from "lucide-react";
import { Button, FormError, FormSuccess, Input } from "@/components/ui";
import { startTripAction } from "../actions";

type Option = { value: string; label: string; sub?: string; icon: "here" | "loc" | "last"; disabled?: boolean };

/**
 * „Ich fahre los“: große Schaltflächen (Handy). Der Standort wird NUR nach Klick auf „Ich fahre los“ mit
 * gewählter Option „Aktueller Standort“ abgefragt, auf 3 Nachkommastellen (~100 m) gerundet und einmalig gesendet.
 */
export function DepartureForm({ appointmentId, options, initial }: { appointmentId: string; options: Option[]; initial: string }) {
  const [state, run, pending] = useActionState(startTripAction, undefined);
  const [choice, setChoice] = useState(initial);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setGeoError(null);
    if (choice !== "here") {
      startTransition(() => run(fd));
      return;
    }
    if (!("geolocation" in navigator)) {
      setGeoError("Standortabfrage wird von diesem Gerät nicht unterstützt – bitte einen Startort wählen.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        fd.set("lat", (Math.round(pos.coords.latitude * 1000) / 1000).toFixed(3));
        fd.set("lon", (Math.round(pos.coords.longitude * 1000) / 1000).toFixed(3));
        startTransition(() => run(fd));
      },
      () => {
        setLocating(false);
        setGeoError("Standort nicht verfügbar oder nicht freigegeben – bitte einen Startort wählen.");
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  }

  const Icon = { here: Crosshair, loc: Home, last: History };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <FormError message={geoError ?? state?.error} />
      <FormSuccess message={state?.ok} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-semibold">Wo startest du?</legend>
        {options.map((o) => {
          const I = Icon[o.icon];
          const active = choice === o.value;
          return (
            <label
              key={o.value}
              className={`flex min-h-16 cursor-pointer items-center gap-3 rounded-xl border-2 px-4 py-3 ${active ? "border-primary bg-primary-soft text-primary-soft-text" : "border-border bg-surface"} ${o.disabled ? "cursor-not-allowed opacity-50" : ""}`}
            >
              <input type="radio" name="start" value={o.value} checked={active} disabled={o.disabled} onChange={() => setChoice(o.value)} className="sr-only" />
              <I size={22} aria-hidden />
              <span className="flex flex-col">
                <span className="text-base font-semibold">{o.label}</span>
                {o.sub ? <span className="text-sm opacity-80">{o.sub}</span> : null}
              </span>
            </label>
          );
        })}
      </fieldset>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Kilometerstand bei Abfahrt (optional)</span>
        <Input name="odometerStart" inputMode="numeric" pattern="[0-9]*" placeholder="z. B. 48210" />
      </label>
      <Button type="submit" disabled={pending || locating || !choice} className="h-16 text-lg">
        {locating ? "Standort wird ermittelt …" : pending ? "Strecke wird berechnet …" : "Ich fahre los"}
      </Button>
      <p className="text-xs text-muted">„Aktueller Standort“ wird nur für diese Berechnung verwendet (auf ca. 100 m gerundet) und nicht gespeichert.</p>
    </form>
  );
}
