"use client";

import { keepValues } from "@/lib/forms";
import { useActionState, useEffect, useState, useTransition } from "react";
import QRCode from "qrcode";
import { Button, Field, FormError, FormSuccess, Input } from "@/components/ui";
import { otpauthUrl } from "@/lib/auth/totp-url";
import { confirmTotpAction, startTotpAction } from "../actions";

type State = { error?: string; ok?: string } | undefined;

/** Standard: Aktionen der Einstellungen (Praxis-Sitzung); /login/2fa-einrichten übergibt eigene (ohne Praxis). */
export function TotpSetup({
  email,
  startAction = startTotpAction,
  confirmAction = confirmTotpAction,
}: {
  email: string;
  startAction?: () => Promise<{ secret?: string; error?: string } | undefined>;
  confirmAction?: (s: State, f: FormData) => Promise<State>;
}) {
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [state, confirm, confirming] = useActionState(confirmAction, undefined);
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    if (!secret) return;
    // qrcode erzeugt reines SVG aus Pfaden (keine Eingabe-Texte im Markup) – lokal im Browser, das Geheimnis verlässt das Gerät nicht
    QRCode.toString(otpauthUrl(secret, email), { type: "svg", errorCorrectionLevel: "M", margin: 1, color: { dark: "#0b2b26", light: "#ffffff" } })
      .then(setQr, () => setQr(null));
  }, [secret, email]);
  if (state?.ok) return <FormSuccess message={state.ok} />;
  if (!secret) {
    return (
      <div className="flex justify-center">
        <Button type="button" disabled={pending} onClick={() => start(async () => setSecret((await startAction())?.secret ?? null))}>
          Jetzt einrichten
        </Button>
      </div>
    );
  }
  return (
    <form onSubmit={keepValues(confirm)} className="flex flex-col gap-4">
      <FormError message={state?.error} />
      <ol className="list-decimal pl-5 text-sm">
        <li>In der Authenticator-App „Konto hinzufügen“ wählen und diesen QR-Code scannen:</li>
      </ol>
      {qr ? (
        <div
          className="mx-auto w-48 max-w-full rounded-xl border border-border bg-white p-2"
          role="img"
          aria-label="QR-Code für die Authenticator-App"
          dangerouslySetInnerHTML={{ __html: qr }}
        />
      ) : null}
      <ol className="list-decimal pl-5 text-sm" start={2}>
        <li>
          Kein Scan möglich? Auf dem Handy diesen Link öffnen: <a className="break-all font-semibold text-primary" href={otpauthUrl(secret, email)}>Konto hinzufügen</a>, oder den Schlüssel manuell eingeben:
          <code className="mt-1 block break-all rounded-lg bg-surface-2 p-2 font-mono text-sm">{secret.match(/.{1,4}/g)?.join(" ")}</code>
        </li>
        <li>Den angezeigten 6-stelligen Code hier eintragen.</li>
      </ol>
      <Field label="Code"><Input name="code" inputMode="numeric" autoComplete="one-time-code" required /></Field>
      <div className="flex justify-center"><Button type="submit" disabled={confirming}>Bestätigen</Button></div>
    </form>
  );
}
