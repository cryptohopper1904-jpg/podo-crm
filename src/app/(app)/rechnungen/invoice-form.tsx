"use client";

import { keepValues } from "@/lib/forms";
import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { Button, Card, Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui";
import { money, parseMoney } from "@/lib/format";
import { computeTotals, lineTotalCents } from "@/lib/invoice-math";
import { CREATABLE_KINDS, INVOICE_KIND_LABEL, NOTE_SMALL_BUSINESS, THERAPEUTIC_LABEL, type CreatableKind } from "@/lib/invoice-labels";
import { createInvoiceAction } from "./actions";
import { newPaymentRow, PaymentsEditor, paymentsSum, paymentsToJson, type PaymentRow } from "./payments-editor";

type Service = { id: string; code: string; name: string; priceCents: number; vatRate: number; requiresTherapeuticPurpose: boolean };
type PatientOpt = { id: string; number: number; firstName: string | null; lastName: string; billingContactId: string | null; careHomeId: string | null };
type ContactOpt = { id: string; name: string; kind: string };

export type InvoicePreset = {
  kind: CreatableKind;
  billingContactId?: string | null;
  notes?: string | null;
  lines: { treatmentRecordId?: string | null; serviceId: string | null; description: string; quantity: number; unitPriceCents: number | null; vatRate: number }[];
};

type Line = { key: string; treatmentRecordId?: string | null; serviceId: string; description: string; quantity: string; factor: string; price: string; vatRate: number };

let seq = 0;
const euro = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");
const num = (s: string) => {
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};
const newLine = (patch: Partial<Line> = {}): Line => ({
  key: `l${++seq}`,
  serviceId: "",
  description: "",
  quantity: "1",
  factor: "1",
  price: "",
  vatRate: 0,
  ...patch,
});

export function InvoiceForm({
  patients,
  services,
  billingContacts,
  smallBusiness,
  today,
  preselectPatientId,
  preset,
}: {
  patients: PatientOpt[];
  services: Service[];
  billingContacts: ContactOpt[];
  smallBusiness: boolean;
  today: string;
  preselectPatientId?: string | null;
  preset?: InvoicePreset;
}) {
  const [state, action, pending] = useActionState(createInvoiceAction, undefined);
  const svcById = useMemo(() => new Map(services.map((s) => [s.id, s])), [services]);
  const initialPatient = patients.find((p) => p.id === preselectPatientId);

  const [kind, setKind] = useState<CreatableKind>(preset?.kind ?? "invoice");
  const [patientId, setPatientId] = useState(preset ? "" : (initialPatient?.id ?? ""));
  const [billingContactId, setBillingContactId] = useState(preset?.billingContactId ?? initialPatient?.billingContactId ?? "");
  const [patientFilter, setPatientFilter] = useState("");
  const [lines, setLines] = useState<Line[]>(() =>
    preset?.lines.length
      ? preset.lines.map((l) =>
          newLine({
            treatmentRecordId: l.treatmentRecordId ?? null,
            // inaktive/unbekannte Leistung → Freitext mit Katalogpreis
            serviceId: l.serviceId && svcById.has(l.serviceId) ? l.serviceId : "",
            description: l.description,
            quantity: String(l.quantity).replace(".", ","),
            price: l.unitPriceCents === null ? "" : euro(l.unitPriceCents),
            vatRate: l.vatRate,
          }),
        )
      : [newLine()],
  );
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [confirmed, setConfirmed] = useState(false);

  const filteredPatients = useMemo(() => {
    const f = patientFilter.trim().toLowerCase();
    if (!f) return patients;
    return patients.filter((p) => `${p.lastName} ${p.firstName ?? ""} ${p.number}`.toLowerCase().includes(f) || p.id === patientId);
  }, [patients, patientFilter, patientId]);

  const computed = lines.map((l) => {
    const s = l.serviceId ? svcById.get(l.serviceId) : undefined;
    const unit = s ? s.priceCents : (parseMoney(l.price) ?? 0);
    const vatRate = smallBusiness ? 0 : l.vatRate;
    return {
      ...l,
      unit,
      vatRate,
      totalCents: lineTotalCents(unit, num(l.quantity), num(l.factor)),
      needsConfirm: !smallBusiness && vatRate === 0 && (s ? s.requiresTherapeuticPurpose : kind !== "no_show_fee"),
    };
  });
  const totals = computeTotals(computed);
  const needsConfirm = computed.some((l) => l.needsConfirm);
  const paid = paymentsSum(payments);

  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  function chooseService(key: string, serviceId: string) {
    const s = svcById.get(serviceId);
    if (!s) return update(key, { serviceId: "", description: "", price: "" });
    update(key, { serviceId, description: s.name, price: euro(s.priceCents), vatRate: s.vatRate });
  }

  function chooseKind(k: CreatableKind) {
    setKind(k);
    if (k === "no_show_fee" && lines.every((l) => !l.serviceId && !l.description)) {
      setLines([newLine({ description: "Ausfallhonorar (§ 615 BGB) für den Termin am …", vatRate: 0 })]);
    }
    if (k === "receipt" && payments.length === 0 && totals.totalCents > 0) setPayments([newPaymentRow(totals.totalCents)]);
  }

  function choosePatient(id: string) {
    setPatientId(id);
    const p = patients.find((x) => x.id === id);
    if (p) setBillingContactId(p.billingContactId ?? (kind === "collective" ? (p.careHomeId ?? "") : ""));
  }

  const vatOptions = (l: Line) => {
    const s = l.serviceId ? svcById.get(l.serviceId) : undefined;
    if (s) return s.vatRate === 19 ? [19] : [s.vatRate, 19];
    return [0, 7, 19];
  };

  const linesJson = JSON.stringify(
    computed.map((l) => ({
      serviceId: l.serviceId || null,
      treatmentRecordId: l.treatmentRecordId || null,
      description: l.description,
      quantity: num(l.quantity),
      factor: num(l.factor),
      unitPriceCents: l.unit,
      vatRate: l.vatRate,
    })),
  );

  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-6">
      <input type="hidden" name="lines" value={linesJson} />
      <input type="hidden" name="payments" value={paymentsToJson(payments)} />
      <input type="hidden" name="kind" value={kind} />
      <FormError message={state?.error} />

      <Card>
        <h2 className="mb-4 font-display text-lg font-semibold">Beleg</h2>
        <div className="mb-4 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Belegart">
          {CREATABLE_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => chooseKind(k)}
              className={`inline-flex h-11 items-center rounded-xl px-3.5 text-sm font-semibold ${kind === k ? "bg-primary text-on-primary" : "border border-border bg-surface hover:bg-surface-2"}`}
            >
              {INVOICE_KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Kunde suchen" className="lg:col-span-1">
            <Input value={patientFilter} onChange={(e) => setPatientFilter(e.target.value)} placeholder="Name oder Nummer" autoComplete="off" />
          </Field>
          <Field label={kind === "collective" ? "Kunde (optional)" : "Kunde *"} className="lg:col-span-1">
            <Select name="patientId" value={patientId} onChange={(e) => choosePatient(e.target.value)} required={kind !== "collective"}>
              <option value="">– bitte wählen –</option>
              {filteredPatients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.lastName}{p.firstName ? `, ${p.firstName}` : ""} (#{p.number})
                </option>
              ))}
            </Select>
          </Field>
          <Field label={kind === "collective" ? "Rechnungsempfänger *" : "Abweichender Rechnungsempfänger"} hint="z. B. Pflegeheim, Betreuer:in, Angehörige">
            <Select name="billingContactId" value={billingContactId} onChange={(e) => setBillingContactId(e.target.value)} required={kind === "collective"}>
              <option value="">– keiner –</option>
              {billingContacts.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Datum">
              <Input type="date" name="issuedAt" defaultValue={today} max={today} required />
            </Field>
            <Field label="Zahlungsziel (Tage)">
              <Input type="number" name="dueDays" min={0} max={120} defaultValue={kind === "receipt" ? 0 : 14} key={kind === "receipt" ? "r" : "o"} disabled={kind === "receipt"} />
            </Field>
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="mb-4 font-display text-lg font-semibold">Positionen</h2>
        <div className="flex flex-col gap-3">
          {computed.map((l, i) => {
            const s = l.serviceId ? svcById.get(l.serviceId) : undefined;
            return (
              <div key={l.key} className="grid gap-3 rounded-xl border border-border p-3 md:grid-cols-[minmax(10rem,1.2fr)_minmax(10rem,2fr)_5rem_5rem_7rem_7rem_auto] md:items-end">
                <Field label={`Pos. ${i + 1}: Leistung`}>
                  <Select value={l.serviceId} onChange={(e) => chooseService(l.key, e.target.value)}>
                    <option value="">Freitext</option>
                    {services.map((sv) => (
                      <option key={sv.id} value={sv.id}>{sv.code} · {sv.name}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Beschreibung">
                  <Input value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} placeholder={s?.name ?? "z. B. Pflegeprodukt"} />
                </Field>
                <Field label="Menge">
                  <Input inputMode="decimal" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                </Field>
                <Field label="Faktor">
                  <Input inputMode="decimal" value={l.factor} onChange={(e) => update(l.key, { factor: e.target.value })} />
                </Field>
                <Field label="Preis (€)" hint={s ? "aus Katalog" : undefined}>
                  <Input inputMode="decimal" value={l.price} disabled={!!s} onChange={(e) => update(l.key, { price: e.target.value })} placeholder="0,00" />
                </Field>
                <Field label="USt">
                  {smallBusiness ? (
                    <Input value="0 % (§ 19)" disabled />
                  ) : (
                    <Select value={l.vatRate} onChange={(e) => update(l.key, { vatRate: Number(e.target.value) })}>
                      {vatOptions(l).map((r) => (
                        <option key={r} value={r}>{r} %</option>
                      ))}
                    </Select>
                  )}
                </Field>
                <div className="flex items-center justify-between gap-2 md:flex-col md:items-end">
                  <span className="font-semibold tabular-nums">{money(l.totalCents)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={`Position ${i + 1} entfernen`}
                    disabled={lines.length === 1}
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  >
                    <Trash2 size={18} aria-hidden />
                  </Button>
                </div>
              </div>
            );
          })}
          <div>
            <Button type="button" variant="secondary" onClick={() => setLines((ls) => [...ls, newLine()])}>
              <Plus size={18} aria-hidden /> Position
            </Button>
          </div>
        </div>

        <dl className="mt-5 ml-auto grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-[15px]">
          {totals.groups.map((g) => (
            <div key={g.rate} className="contents text-muted">
              <dt>{g.rate ? `enthaltene USt ${g.rate} % (auf ${money(g.grossCents)})` : `steuerfrei 0 % (${money(g.grossCents)})`}</dt>
              <dd className="text-right tabular-nums">{money(g.vatCents)}</dd>
            </div>
          ))}
          <dt>Netto</dt>
          <dd className="text-right tabular-nums">{money(totals.netCents)}</dd>
          <dt className="font-semibold">Gesamt (brutto)</dt>
          <dd className="text-right font-display text-xl font-bold tabular-nums">{money(totals.totalCents)}</dd>
        </dl>
        {smallBusiness ? <p className="mt-3 text-sm text-muted">{NOTE_SMALL_BUSINESS}</p> : null}
      </Card>

      {needsConfirm ? (
        <Card className="border-warn-soft-text/40 bg-warn-soft text-warn-soft-text">
          <div className="flex gap-3">
            <AlertTriangle size={22} className="mt-0.5 shrink-0" aria-hidden />
            <div className="flex-1">
              <p className="font-semibold">USt-Wächter (§ 4 Nr. 14 UStG)</p>
              <p className="text-sm">
                0 % USt ist nur bei einer Heilbehandlung mit therapeutischem Ziel zulässig. Bitte bestätigen – sonst die betroffenen Positionen mit 19 % abrechnen.
              </p>
              <Checkbox name="therapeuticConfirmed" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} label={THERAPEUTIC_LABEL} />
              <Button
                type="button"
                variant="secondary"
                onClick={() => setLines((ls) => ls.map((l, i) => (computed[i]?.needsConfirm ? { ...l, vatRate: 19 } : l)))}
              >
                Betroffene Positionen auf 19 % umstellen
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      <Card>
        <h2 className="mb-1 font-display text-lg font-semibold">Zahlung</h2>
        <p className="mb-4 text-sm text-muted">
          {kind === "receipt"
            ? "Quittung: Der Betrag wird sofort vollständig bezahlt."
            : "Optional – sofort bezahlte Beträge erfassen. Mischzahlung (z. B. Gutschein + bar) möglich."}
        </p>
        <PaymentsEditor rows={payments} onChange={setPayments} openCents={totals.totalCents} />
        {kind === "receipt" && paid !== totals.totalCents ? (
          <p className="mt-3 text-sm font-medium text-danger">Für eine Quittung muss die Zahlung genau {money(totals.totalCents)} betragen.</p>
        ) : null}
      </Card>

      <Card>
        <Field label="Hinweis auf der Rechnung (keine Diagnosen)">
          <Textarea name="notes" defaultValue={preset?.notes ?? ""} placeholder="z. B. Behandlungszeitraum, Bezug auf Verordnung" />
        </Field>
      </Card>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending || totals.totalCents <= 0 || (needsConfirm && !confirmed)}>
          {pending ? "Wird ausgestellt …" : `${INVOICE_KIND_LABEL[kind]} ausstellen`}
        </Button>
        <Link href="/rechnungen" className="inline-flex h-11 items-center px-4 font-semibold text-muted">Abbrechen</Link>
        <p className="w-full text-xs text-muted">Nach dem Ausstellen sind Nummer und Beträge unveränderbar (GoBD). Korrekturen nur per Storno.</p>
      </div>
    </form>
  );
}
