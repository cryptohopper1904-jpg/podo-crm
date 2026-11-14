"use client";

import { keepValues } from "@/lib/forms";
import { useActionState } from "react";
import { AnamnesisFields } from "@/components/anamnesis-fields";
import { Button, Card, Checkbox, FormActions, FormError } from "@/components/ui";
import { submitOnlineAnamnesisAction, type OnlineAnamnesisState } from "./actions";

export function OnlineAnamnesisForm({ token, onSite = false }: { token: string; /** Übergabe-Modus am Praxis-Gerät */ onSite?: boolean }) {
  const [state, action, pending] = useActionState<OnlineAnamnesisState, FormData>(submitOnlineAnamnesisAction, undefined);
  if (state?.done && onSite) {
    return (
      <Card className="mt-6 text-center">
        <h2 className="font-display text-2xl font-semibold">Vielen Dank!</h2>
        <p className="mt-2 text-lg">Ihre Angaben sind gespeichert. Bitte geben Sie das Gerät jetzt an die Praxis zurück.</p>
        <p className="mt-6">
          <a href="/entsperren" className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-sm font-semibold">Praxis: Gerät entsperren</a>
        </p>
      </Card>
    );
  }
  if (state?.done) {
    return (
      <Card className="mt-6">
        <h2 className="font-display text-2xl font-semibold">Vielen Dank!</h2>
        <p className="mt-2">Ihr Fragebogen ist bei uns angekommen. Wir besprechen Ihre Angaben beim nächsten Termin mit Ihnen.</p>
        <p className="mt-2 text-sm text-muted">Sie können dieses Fenster jetzt schließen. Der Link ist nicht mehr gültig.</p>
      </Card>
    );
  }
  return (
    <form onSubmit={keepValues(action)} className="mt-6 flex flex-col gap-5">
      <input type="hidden" name="token" value={token} />
      {/* Honeypot gegen Bots */}
      <div aria-hidden className="hidden">
        <label>Website <input name="website" tabIndex={-1} autoComplete="off" /></label>
      </div>
      <FormError message={state?.error} revealKey={state} />
      <AnamnesisFields mode="online" />
      <Card>
        <h3 className="mb-2 font-display text-lg font-semibold">Einwilligungen</h3>
        <Checkbox name="privacy" required label="Ich habe die Datenschutzhinweise der Praxis erhalten und gelesen. (Pflicht)" />
        <p className="mb-2 mt-1 text-xs text-muted">Die Behandlung und ihre Dokumentation benötigen keine Einwilligung (Art. 9 Abs. 2 lit. h DSGVO). Die folgenden Punkte sind freiwillig und jederzeit in der Praxis widerrufbar. Bereits erteilte Einwilligungen bleiben bestehen.</p>
        <Checkbox name="consent_photo_documentation" label="Fotos meiner Füße zur Behandlungsdokumentation (nur intern)" />
        <Checkbox name="consent_email_reminders" label="Terminerinnerungen per E-Mail" />
        <Checkbox name="consent_sms_reminders" label="Terminerinnerungen per SMS" />
        <Checkbox name="consent_whatsapp" label="Terminabsprachen per WhatsApp (nur Organisatorisches, keine Gesundheitsinformationen; WhatsApp ist ein Dienst von Meta)" />
      </Card>
      {/* Meldung oben (wird angesprungen und vorgelesen); hier nur die Kurzfassung neben dem Knopf */}
      <FormActions sticky={false} error={pending ? null : state?.error}>
        <Button type="submit" disabled={pending} className="h-14 w-full text-base sm:w-auto">{pending ? "Wird gesendet …" : "Fragebogen absenden"}</Button>
      </FormActions>
    </form>
  );
}
