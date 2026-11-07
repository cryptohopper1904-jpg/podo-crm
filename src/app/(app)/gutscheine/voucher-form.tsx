"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Button, Card, Field, FormError, Input, Select, Textarea } from "@/components/ui";
import { defaultVoucherValidUntil } from "@/lib/invoice-math";
import { createVoucherAction } from "./actions";

export function VoucherForm({ today }: { today: string }) {
  const [state, action, pending] = useActionState(createVoucherAction, undefined);
  const [issuedAt, setIssuedAt] = useState(today);
  const [validUntil, setValidUntil] = useState(defaultVoucherValidUntil(today));
  return (
    <form action={action} className="flex flex-col gap-6">
      <FormError message={state?.error} />
      <Card>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Betrag (€) *">
            <Input name="amount" inputMode="decimal" placeholder="50,00" required />
          </Field>
          <Field label="Art" hint="Mehrzweck: USt erst bei Einlösung. Einzweck: USt bereits beim Verkauf (§ 3 Abs. 14 UStG).">
            <Select name="purpose" defaultValue="multi">
              <option value="multi">Mehrzweck-Gutschein (Wertgutschein)</option>
              <option value="single">Einzweck-Gutschein (bestimmte Leistung)</option>
            </Select>
          </Field>
          <Field label="Ausgestellt am">
            <Input
              type="date"
              name="issuedAt"
              value={issuedAt}
              max={today}
              onChange={(e) => {
                setIssuedAt(e.target.value);
                if (e.target.value) setValidUntil(defaultVoucherValidUntil(e.target.value));
              }}
              required
            />
          </Field>
          <Field label="Gültig bis" hint="Standard: 31.12. des dritten Folgejahres (Verjährung § 195/§ 199 BGB). Kürzere Fristen rechtlich prüfen.">
            <Input type="date" name="validUntil" value={validUntil} min={issuedAt} onChange={(e) => setValidUntil(e.target.value)} required />
          </Field>
          <Field label="Notiz (z. B. Käufer:in, Anlass)" className="sm:col-span-2">
            <Textarea name="note" maxLength={300} />
          </Field>
        </div>
      </Card>
      <div className="flex gap-3">
        <Button type="submit" disabled={pending}>{pending ? "Speichern …" : "Gutschein ausstellen"}</Button>
        <Link href="/gutscheine" className="inline-flex h-11 items-center px-4 font-semibold text-muted">Abbrechen</Link>
      </div>
    </form>
  );
}
