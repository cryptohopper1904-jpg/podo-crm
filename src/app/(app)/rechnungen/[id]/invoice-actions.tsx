"use client";

import { keepValues } from "@/lib/forms";
import { useActionState, useState } from "react";
import { Ban, Copy, CreditCard, FlaskConical, Link2, Mail, Send, Smartphone } from "lucide-react";
import { Button, Card, Checkbox, Field, FormError, FormSuccess, Input, Select } from "@/components/ui";
import {
  addPaymentAction,
  cancelInvoiceAction,
  createPaymentLinkAction,
  pushToLexofficeAction,
  sendInvoiceEmailAction,
  sendPaymentLinkAction,
  simulatePaymentAction,
  startTerminalAction,
} from "../actions";
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
      <form onSubmit={keepValues(action)} className="flex flex-col gap-4">
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

export type CancelProductLine = { id: string; description: string; quantity: string; inTreatment: boolean };

export function CancelPanel({ invoiceId, number, productLines = [] }: { invoiceId: string; number: string; /** Produktpositionen des Belegs (Rückbuchung ins Lager) */ productLines?: CancelProductLine[] }) {
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
        onSubmit={(e) => {
          if (!window.confirm(`${number} wirklich stornieren? Es wird eine Stornorechnung erzeugt.`)) return e.preventDefault();
          keepValues(action)(e);
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
        {productLines.length ? (
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium">Verkaufte Produkte: Ware zurück ins Lager?</legend>
            <input type="hidden" name="restockChoice" value="1" />
            {productLines.map((l) =>
              l.inTreatment ? (
                <p key={l.id} className="text-sm text-muted">{l.quantity} × {l.description} – in der Behandlung verbraucht, keine Rückbuchung</p>
              ) : (
                <Checkbox key={l.id} name="restockLine" value={l.id} defaultChecked label={`${l.quantity} × ${l.description}`} />
              ),
            )}
            <span className="text-xs text-muted">Abwählen, wenn die Ware beim Kunden bleibt, angebrochen oder beschädigt ist.</span>
          </fieldset>
        ) : null}
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
    <form onSubmit={keepValues(action)} className="flex flex-col gap-2">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <Button type="submit" variant="secondary" disabled={pending}>
        <Send size={18} aria-hidden /> {pending ? "Sende …" : "An lexoffice senden"}
      </Button>
      <FormSuccess message={state?.success} />
      <FormError message={state?.error} />
    </form>
  );
}

export function EmailInvoiceButton({ invoiceId, sentTo, sentAt, recipientEmail }: { invoiceId: string; sentTo: string | null; sentAt: string | null; recipientEmail: string | null }) {
  const [state, action, pending] = useActionState(sendInvoiceEmailAction, undefined);
  return (
    <form
      onSubmit={(e) => {
        if (!recipientEmail) return e.preventDefault();
        if (!window.confirm(`Rechnung als PDF an ${recipientEmail} senden?`)) return e.preventDefault();
        keepValues(action)(e);
      }}
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <Button type="submit" variant="secondary" disabled={pending || !recipientEmail} title={recipientEmail ? undefined : "Keine E-Mail-Adresse hinterlegt"}>
        <Mail size={18} aria-hidden /> {pending ? "Sende …" : sentAt ? "Erneut per E-Mail senden" : "Per E-Mail senden"}
      </Button>
      {sentAt && !state ? <p className="text-xs text-muted">Zuletzt gesendet an {sentTo} am {sentAt}</p> : null}
      {!recipientEmail ? <p className="text-xs text-muted">Keine E-Mail-Adresse hinterlegt</p> : null}
      <FormSuccess message={state?.success} />
      <FormError message={state?.error} />
    </form>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          window.prompt("Link kopieren:", value);
        }
      }}
    >
      <Copy size={18} aria-hidden /> {copied ? "Kopiert" : "Kopieren"}
    </Button>
  );
}

/** SumUp: Kartenzahlung am Terminal, Zahlungslink (anzeigen, kopieren, senden) und im Testmodus „Testzahlung simulieren“. */
export function SumupPanel({
  invoiceId,
  paymentLinkUrl,
  mock,
  channels,
}: {
  invoiceId: string;
  paymentLinkUrl: string | null;
  mock: boolean;
  channels: { value: "email" | "sms" | "whatsapp"; label: string }[];
}) {
  const [terminal, startTerminal, terminalPending] = useActionState(startTerminalAction, undefined);
  const [link, createLink, linkPending] = useActionState(createPaymentLinkAction, undefined);
  const [sent, sendLink, sendPending] = useActionState(sendPaymentLinkAction, undefined);
  const [sim, simulate, simPending] = useActionState(simulatePaymentAction, undefined);
  const url = link?.url ?? paymentLinkUrl;
  return (
    <Card className="no-print w-full">
      <h2 className="mb-1 font-display text-lg font-semibold">Kartenzahlung (SumUp){mock ? " – Testmodus" : ""}</h2>
      <p className="mb-4 text-sm text-muted">Die Zahlung wird nach Bestätigung durch SumUp automatisch gebucht. An SumUp geht nur die Rechnungsnummer.</p>
      <div className="flex flex-wrap items-start gap-3">
        <form onSubmit={keepValues(startTerminal)} className="flex flex-col gap-2">
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <Button type="submit" disabled={terminalPending}>
            <CreditCard size={18} aria-hidden /> {terminalPending ? "Sende an Terminal …" : "Kartenzahlung am Terminal"}
          </Button>
        </form>
        <form onSubmit={keepValues(createLink)} className="flex flex-col gap-2">
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <Button type="submit" variant="secondary" disabled={linkPending}>
            <Link2 size={18} aria-hidden /> {linkPending ? "Erzeuge …" : url ? "Neuen Zahlungslink erzeugen" : "Zahlungslink erzeugen"}
          </Button>
        </form>
        {mock ? (
          <form onSubmit={keepValues(simulate)} className="flex flex-col gap-2">
            <input type="hidden" name="invoiceId" value={invoiceId} />
            <Button type="submit" variant="ghost" disabled={simPending}>
              <FlaskConical size={18} aria-hidden /> {simPending ? "Buche …" : "Testzahlung simulieren"}
            </Button>
          </form>
        ) : null}
      </div>
      <div className="mt-3 flex flex-col gap-2">
        <FormSuccess message={terminal?.success ?? sim?.success} />
        <FormError message={terminal?.error ?? link?.error ?? sim?.error} />
      </div>
      {url ? (
        <div className="mt-4 flex flex-col gap-3 rounded-xl bg-surface-2 p-3">
          <Field label="Zahlungslink">
            <div className="flex flex-wrap gap-2">
              <Input readOnly value={url} className="min-w-0 flex-1" onFocus={(e) => e.currentTarget.select()} />
              <CopyButton value={url} />
            </div>
          </Field>
          {link?.success ? <FormSuccess message={link.success} /> : null}
          {channels.length ? (
            <form onSubmit={keepValues(sendLink)} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="invoiceId" value={invoiceId} />
              <Field label="Link senden per">
                <Select name="channel" defaultValue={channels[0].value}>
                  {channels.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </Select>
              </Field>
              <Button type="submit" variant="secondary" disabled={sendPending}>
                <Smartphone size={18} aria-hidden /> {sendPending ? "Sende …" : "Senden"}
              </Button>
            </form>
          ) : (
            <p className="text-sm text-muted">Keine E-Mail-Adresse/Mobilnummer hinterlegt – Link bitte kopieren.</p>
          )}
          <FormSuccess message={sent?.success} />
          <FormError message={sent?.error} />
        </div>
      ) : null}
    </Card>
  );
}
