"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button, Field, Input, Select } from "@/components/ui";
import { money, parseMoney } from "@/lib/format";
import { PAYMENT_METHOD_LABEL, PAYMENT_METHODS, type PaymentMethod } from "@/lib/invoice-labels";
import { isRegisterMethod, PRAXISKASSE_BON_PATTERN } from "@/lib/kasse/labels";

export type PaymentRow = { key: string; method: PaymentMethod; amount: string; voucherCode: string; /** Bon-Nr. der eigenen Praxiskasse */ registerReceiptNo?: string };

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
      .map((r) => ({
        method: r.method,
        amountCents: (parseMoney(r.amount) ?? 0) * sign,
        voucherCode: r.voucherCode || null,
        // Präfix „praxiskasse:“ setzt der Server; ohne eigene Praxiskasse lehnt der Server eine Bon-Nr. ab
        registerReceiptNo: isRegisterMethod(r.method) && r.registerReceiptNo?.trim() ? r.registerReceiptNo.trim() : null,
      }))
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
  externalRegister = false,
}: {
  rows: PaymentRow[];
  onChange: (rows: PaymentRow[]) => void;
  openCents: number;
  refund?: boolean;
  /** Praxis nutzt die eigene Praxiskasse: Bar/Karte/Gutschein nur vermerken, Feld „Bon-Nr. Praxiskasse“ */
  externalRegister?: boolean;
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
          {r.method === "voucher" || (externalRegister && isRegisterMethod(r.method)) ? (
            <div className="flex flex-col gap-3">
              {r.method === "voucher" ? (
                <Field label="Gutscheincode">
                  <Input value={r.voucherCode} placeholder="G2026-0001" onChange={(e) => update(r.key, { voucherCode: e.target.value.toUpperCase() })} autoComplete="off" />
                </Field>
              ) : null}
              {externalRegister && isRegisterMethod(r.method) ? (
                <Field label="Bon-Nr. Praxiskasse (optional)">
                  <Input
                    value={r.registerReceiptNo ?? ""}
                    maxLength={40}
                    pattern={PRAXISKASSE_BON_PATTERN}
                    title="Nur Buchstaben, Ziffern, - und /; am Anfang ein Buchstabe oder eine Ziffer"
                    placeholder="z. B. 4711"
                    onChange={(e) => update(r.key, { registerReceiptNo: e.target.value })}
                    autoComplete="off"
                  />
                </Field>
              ) : null}
            </div>
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
      {externalRegister && rows.some((r) => isRegisterMethod(r.method)) ? (
        <p className="rounded-xl bg-info-soft px-3 py-2 text-xs text-info-soft-text">
          Eigene Praxiskasse: Bar-, Karten- und Gutscheinzahlungen bitte zuerst in der Praxiskasse erfassen – PodoHero vermerkt sie hier nur
          (ohne TSE-Signatur und ohne PodoHero-Kassenbeleg).
        </p>
      ) : rows.some((r) => r.method === "cash") ? (
        <p className="rounded-xl bg-warn-soft px-3 py-2 text-xs text-warn-soft-text">
          Barzahlung wird über die TSE signiert (ohne angebundene zertifizierte TSE nur Test-Signatur). Für echten Bargeldeinsatz ist ein TSE-Vertrag, z. B. fiskaly SIGN DE, Pflicht (KassenSichV).
        </p>
      ) : null}
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
