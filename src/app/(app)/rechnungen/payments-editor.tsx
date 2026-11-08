"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button, Field, Input, Select } from "@/components/ui";
import { money, parseMoney } from "@/lib/format";
import { PAYMENT_METHOD_LABEL, PAYMENT_METHODS, type PaymentMethod } from "@/lib/invoice-labels";

export type PaymentRow = { key: string; method: PaymentMethod; amount: string; voucherCode: string };

let seq = 0;
export const newPaymentRow = (amountCents?: number, method: PaymentMethod = "cash"): PaymentRow => ({
  key: `p${++seq}`,
  method,
  amount: amountCents && amountCents > 0 ? (amountCents / 100).toFixed(2).replace(".", ",") : "",
  voucherCode: "",
});

/** Beträge in Cent; `sign` = -1 für Erstattungen (Stornorechnung). */
export function paymentsToJson(rows: PaymentRow[], sign: 1 | -1 = 1) {
  return JSON.stringify(
    rows
      .map((r) => ({ method: r.method, amountCents: (parseMoney(r.amount) ?? 0) * sign, voucherCode: r.voucherCode || null }))
      .filter((r) => r.amountCents !== 0),
  );
}

export const paymentsSum = (rows: PaymentRow[]) => rows.reduce((s, r) => s + (parseMoney(r.amount) ?? 0), 0);

/**
 * Mischzahlung: mehrere Zahlungen mit unterschiedlichen Methoden.
 * `openCents` ist immer positiv (bei Erstattungen der Betrag der Erstattung).
 */
export function PaymentsEditor({
  rows,
  onChange,
  openCents,
  refund = false,
}: {
  rows: PaymentRow[];
  onChange: (rows: PaymentRow[]) => void;
  openCents: number;
  refund?: boolean;
}) {
  const sum = paymentsSum(rows);
  const rest = openCents - sum;
  const update = (key: string, patch: Partial<PaymentRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <div className="flex flex-col gap-3">
      {rows.map((r, i) => (
        <div key={r.key} className="grid items-end gap-3 rounded-xl bg-surface-2 p-3 sm:grid-cols-[1fr_9rem_1fr_auto]">
          <Field label={`${refund ? "Erstattung" : "Zahlung"} ${i + 1}: Methode`}>
            <Select value={r.method} onChange={(e) => update(r.key, { method: e.target.value as PaymentMethod })}>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</option>
              ))}
            </Select>
          </Field>
          <Field label="Betrag (€)">
            <Input
              inputMode="decimal"
              value={r.amount}
              placeholder="0,00"
              onChange={(e) => update(r.key, { amount: e.target.value })}
              aria-invalid={r.amount !== "" && parseMoney(r.amount) === null}
            />
          </Field>
          {r.method === "voucher" ? (
            <Field label="Gutscheincode">
              <Input value={r.voucherCode} placeholder="G2026-0001" onChange={(e) => update(r.key, { voucherCode: e.target.value.toUpperCase() })} autoComplete="off" />
            </Field>
          ) : (
            <div className="hidden sm:block" />
          )}
          <div className="flex gap-2">
            {rest > 0 ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => update(r.key, { amount: (((parseMoney(r.amount) ?? 0) + rest) / 100).toFixed(2).replace(".", ",") })}
                title="Restbetrag übernehmen"
              >
                Rest
              </Button>
            ) : null}
            <Button type="button" variant="ghost" aria-label={`Zahlung ${i + 1} entfernen`} onClick={() => onChange(rows.filter((x) => x.key !== r.key))}>
              <Trash2 size={18} aria-hidden />
            </Button>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" onClick={() => onChange([...rows, newPaymentRow(rest > 0 ? rest : undefined)])}>
          <Plus size={18} aria-hidden /> {refund ? "Erstattung" : "Zahlung"} hinzufügen
        </Button>
        <p className="text-sm text-muted" aria-live="polite">
          {refund ? "Erstattet" : "Erfasst"}: <span className="font-semibold tabular-nums text-text">{money(sum)}</span> · Rest:{" "}
          <span className={rest < 0 ? "font-semibold text-danger" : "font-semibold tabular-nums text-text"}>{money(rest)}</span>
          {rest < 0 ? " – mehr als offen!" : ""}
        </p>
      </div>
    </div>
  );
}
