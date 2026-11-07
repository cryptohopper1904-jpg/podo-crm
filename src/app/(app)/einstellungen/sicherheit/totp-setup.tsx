"use client";

import { useActionState, useState, useTransition } from "react";
import { Button, Field, FormError, FormSuccess, Input } from "@/components/ui";
import { otpauthUrl } from "@/lib/auth/totp-url";
import { confirmTotpAction, startTotpAction } from "../actions";

export function TotpSetup({ email }: { email: string }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [state, confirm, confirming] = useActionState(confirmTotpAction, undefined);
  if (state?.ok) return <FormSuccess message={state.ok} />;
  if (!secret) {
    return (
      <Button type="button" disabled={pending} onClick={() => start(async () => setSecret((await startTotpAction())?.secret ?? null))}>
        Jetzt einrichten
      </Button>
    );
  }
  return (
    <form action={confirm} className="flex flex-col gap-4">
      <FormError message={state?.error} />
      <ol className="list-decimal pl-5 text-sm">
        <li>In der Authenticator-App „Konto hinzufügen“ wählen.</li>
        <li>
          Auf dem iPhone diesen Link öffnen: <a className="break-all font-semibold text-primary" href={otpauthUrl(secret, email)}>Konto hinzufügen</a>, oder den Schlüssel manuell eingeben:
          <code className="mt-1 block break-all rounded-lg bg-surface-2 p-2 font-mono text-sm">{secret.match(/.{1,4}/g)?.join(" ")}</code>
        </li>
        <li>Den angezeigten 6-stelligen Code hier eintragen.</li>
      </ol>
      <Field label="Code"><Input name="code" inputMode="numeric" autoComplete="one-time-code" required /></Field>
      <div><Button type="submit" disabled={confirming}>Bestätigen</Button></div>
    </form>
  );
}
