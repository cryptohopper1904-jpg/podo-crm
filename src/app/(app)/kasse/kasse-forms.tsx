"use client";

import { useActionState, useMemo, useState } from "react";
import { keepValues } from "@/lib/forms";
import { Button, Card, CardTitle, Checkbox, Field, FormError, FormSuccess, Input, Select, Textarea } from "@/components/ui";
import { DENOMINATIONS, denominationLabel, isNote, MOVEMENT_KINDS, MOVEMENT_LABEL } from "@/lib/kasse/labels";
import { addMovementAction, closeDayAction } from "./actions";

const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const fmt = (c: number) => eur.format(c / 100);

/** Einlage/Entnahme im Kassenbuch erfassen */
export function MovementForm() {
  const [state, action, pending] = useActionState(addMovementAction, undefined);
  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-4">
      <FormError message={state?.error} />
      <FormSuccess message={state?.ok} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Art">
          <Select name="kind" defaultValue="payout">
            {MOVEMENT_KINDS.map((k) => (
              <option key={k} value={k}>{MOVEMENT_LABEL[k]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Betrag (€)" hint="immer positiv – Einlage/Entnahme ergibt sich aus der Art">
          <Input name="amount" inputMode="decimal" placeholder="20,00" required />
        </Field>
        <Field label="Grund / Beleg *" hint="steht unveränderbar im Z-Bon – keine Namen oder Gesundheitsdaten">
          <Input name="reason" maxLength={300} placeholder="z. B. Briefmarken, Beleg Nr. 12" required />
        </Field>
      </div>
      <div>
        <Button type="submit" variant="secondary" disabled={pending}>{pending ? "…" : "Im Kassenbuch erfassen"}</Button>
      </div>
    </form>
  );
}

/** Zählprotokoll + Tagesabschluss (Z-Bon) */
export function CloseDayForm({
  today,
  minDate,
  expectedWithoutOpeningCents,
  openingCents,
  needsOpening,
}: {
  today: string;
  minDate: string | null;
  /** Soll-Bestand ohne Anfangsbestand (Bareinnahmen + Bewegungen) */
  expectedWithoutOpeningCents: number;
  openingCents: number;
  needsOpening: boolean;
}) {
  const [state, action, pending] = useActionState(closeDayAction, undefined);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [opening, setOpening] = useState("");
  const counted = useMemo(() => DENOMINATIONS.reduce((s, d) => s + d * (Number.parseInt(counts[d] ?? "", 10) || 0), 0), [counts]);
  const openingValue = needsOpening ? Math.round((Number(opening.replace(/\./g, "").replace(",", ".")) || 0) * 100) : openingCents;
  const expected = openingValue + expectedWithoutOpeningCents;
  const diff = counted - expected;
  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-4">
      <FormError message={state?.error} />
      <Card>
        <CardTitle>Zählprotokoll</CardTitle>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {DENOMINATIONS.map((d) => (
            <Field key={d} label={`${isNote(d) ? "Schein" : "Münze"} ${denominationLabel(d)}`}>
              <Input
                name={`d_${d}`}
                type="number"
                min={0}
                max={100000}
                step={1}
                inputMode="numeric"
                value={counts[d] ?? ""}
                onChange={(e) => setCounts((c) => ({ ...c, [d]: e.target.value }))}
                aria-describedby={`sum_${d}`}
              />
              <span id={`sum_${d}`} className="text-xs tabular-nums text-muted">{fmt(d * (Number.parseInt(counts[d] ?? "", 10) || 0))}</span>
            </Field>
          ))}
        </div>
        <dl className="mt-5 grid gap-3 text-[15px] sm:grid-cols-3">
          <div className="rounded-xl bg-surface-2 p-3"><dt className="text-sm text-muted">Soll-Bestand</dt><dd className="font-display text-2xl font-semibold tabular-nums">{fmt(expected)}</dd></div>
          <div className="rounded-xl bg-surface-2 p-3"><dt className="text-sm text-muted">Gezählt (Ist)</dt><dd className="font-display text-2xl font-semibold tabular-nums">{fmt(counted)}</dd></div>
          <div className={`rounded-xl p-3 ${diff === 0 ? "bg-primary-soft text-primary-soft-text" : "bg-accent-soft text-accent-soft-text"}`}>
            <dt className="text-sm">Differenz</dt>
            <dd className="font-display text-2xl font-semibold tabular-nums" aria-live="polite">{diff > 0 ? "+" : ""}{fmt(diff)}</dd>
          </div>
        </dl>
      </Card>
      <Card>
        <CardTitle>Tagesabschluss (Z-Bon)</CardTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Buchungstag" hint="Alle bis dahin nicht abgeschlossenen Zahlungen und Kassenbuch-Einträge gehören in diesen Abschluss.">
            <Input type="date" name="businessDate" defaultValue={today} max={today} min={minDate ?? undefined} required />
          </Field>
          {needsOpening ? (
            <Field label="Anfangsbestand (€)" hint="Nur beim ersten Abschluss: Wechselgeld, das zu Beginn in der Kasse lag. Danach wird der gezählte Bestand übernommen.">
              <Input name="opening" inputMode="decimal" placeholder="100,00" value={opening} onChange={(e) => setOpening(e.target.value)} />
            </Field>
          ) : (
            <Field label="Anfangsbestand" hint="gezählter Bestand des letzten Abschlusses">
              <Input value={fmt(openingCents)} readOnly aria-readonly />
            </Field>
          )}
          <Field label={`Begründung der Differenz${diff !== 0 ? " *" : ""}`} className="sm:col-span-2">
            <Input name="differenceReason" maxLength={300} required={diff !== 0} placeholder={diff !== 0 ? "z. B. Wechselgeld falsch herausgegeben" : "nur bei Differenz nötig"} />
          </Field>
          <Field label="Notiz (optional)" className="sm:col-span-2">
            <Textarea name="note" maxLength={500} />
          </Field>
        </div>
        <div className="mt-4">
          <Checkbox name="confirm" label="Bestand gezählt. Mir ist klar: Der Abschluss ist endgültig, Zahlungen dieses Tages sind danach gesperrt." required />
        </div>
        <div className="mt-4">
          <Button type="submit" disabled={pending}>{pending ? "Abschluss läuft …" : "Tagesabschluss erstellen (Z-Bon)"}</Button>
        </div>
      </Card>
    </form>
  );
}
