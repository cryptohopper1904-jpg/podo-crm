"use client";

import { useActionState, useState } from "react";
import { Ban, CreditCard, Send } from "lucide-react";
import { Button, Card, Field, FormError, FormSuccess, Input } from "@/components/ui";
import { cancelInvoiceAction, addPaymentAction, pushToLexofficeAction } from "../actions";
import { newPaymentRow, PaymentsEditor, paymentsToJson, type PaymentRow } from "../payments-editor";

/** Zahlung erfassen – `openCents` negativ bei Stornorechnung mit offener Erstattung. */
export function PaymentPanel({ invoiceId, openCents }: { invoiceId: string; openCents: number }) {
  const refund = openCents < 0;
  const abs = Math.abs(openCents);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<PaymentRow[]>(() => [newPaymentRow(abs)]);
  const [state, action, pending] = useActionState(async (prev: Awaited<ReturnType<typeof addPaymentAction>>, fd: FormData) => {
    const r = await addPaymentAction(prev, fd);
    if (r?.success) {
      setOpen(false);
    }
    return r;
  }, undefined);

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        <FormSuccess message={state?.success} />
        <Button type="button" onClick={() => { setRows([newPaymentRow(abs)]); setOpen(true); }}>
          <CreditCard size={18} aria-hidden /> {refund ? "Erstattung erfassen" : "Zahlung erfassen"}
        </Button>
      </div>
    );
  }
  return (
    <Card className="no-print w-full">
      <form action={action} className="flex flex-col gap-4">
        <h2 className="font-display text-lg font-semibold">{refund ? "Erstattung erfassen" : "Zahlung erfassen"}</h2>
        <input type="hidden" name="invoiceId" value={invoiceId} />
        <input type="hidden" name="payments" value={paymentsToJson(rows, refund ? -1 : 1)} />
        <FormError message={state?.error} />
        <PaymentsEditor rows={rows} onChange={setRows} openCents={abs} refund={refund} />
        <div className="flex gap-3">
          <Button type="submit" disabled={pending}>{pending ? "Speichern …" : "Buchen"}</Button>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Abbrechen</Button>
        </div>
      </form>
    </Card>
  );
}

export function CancelPanel({ invoiceId, number }: { invoiceId: string; number: string }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(cancelInvoiceAction, undefined);
  if (!open) {
    return (
      <Button type="button" variant="danger" onClick={() => setOpen(true)}>
        <Ban size={18} aria-hidden /> Stornieren
      </Button>
    );
  }
  return (
    <Card className="no-print w-full">
      <form
        action={action}
        onSubmit={(e) => {
          if (!window.confirm(`${number} wirklich stornieren? Es wird eine Stornorechnung erzeugt.`)) e.preventDefault();
        }}
        className="flex flex-col gap-4"
      >
        <h2 className="font-display text-lg font-semibold">Rechnung stornieren</h2>
        <p className="text-sm text-muted">
          Es wird eine Stornorechnung mit negativen Beträgen erzeugt. Die Originalrechnung bleibt erhalten und wird als storniert markiert.
          Bereits gezahlte Beträge bleiben als Erstattung offen.
        </p>
        <input type="hidden" name="invoiceId" value={invoiceId} />
        <FormError message={state?.error} />
        <Field label="Grund (optional, keine Diagnosen)">
          <Input name="reason" maxLength={300} placeholder="z. B. falscher Rechnungsempfänger" />
        </Field>
        <div className="flex gap-3">
          <Button type="submit" variant="danger" disabled={pending}>{pending ? "Storniere …" : "Storno ausstellen"}</Button>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Abbrechen</Button>
        </div>
      </form>
    </Card>
  );
}

export function LexofficeButton({ invoiceId }: { invoiceId: string }) {
  const [state, action, pending] = useActionState(pushToLexofficeAction, undefined);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <Button type="submit" variant="secondary" disabled={pending}>
        <Send size={18} aria-hidden /> {pending ? "Sende …" : "An lexoffice senden"}
      </Button>
      <FormSuccess message={state?.success} />
      <FormError message={state?.error} />
    </form>
  );
}
