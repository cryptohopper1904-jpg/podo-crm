"use client";

import { keepValues } from "@/lib/forms";
import { useActionState, useRef, useState, type FormEvent } from "react";
import { Lock } from "lucide-react";
import { AnamnesisFields } from "@/components/anamnesis-fields";
import { Button, Card, Checkbox, FormActions, FormError } from "@/components/ui";
import { submitOnlineAnamnesisAction, type OnlineAnamnesisState } from "./actions";

const PRIVACY_MISSING = "Bitte bestätigen Sie, dass Sie die Datenschutzhinweise erhalten und gelesen haben.";

/** Ausgang für das Praxisteam im Übergabe-Modus: dezent, aber als 44-px-Knopf treffbar (Schloss = Gerät entsperren). */
export function PracticeExitLink({ label = "Praxis: Übergabe beenden" }: { label?: string }) {
  return (
    <a
      href="/entsperren"
      className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-surface px-4 text-sm font-semibold text-muted hover:bg-surface-2 hover:text-text"
    >
      <Lock size={16} aria-hidden /> {label}
    </a>
  );
}

export function OnlineAnamnesisForm({ token, onSite = false }: { token: string; /** Übergabe-Modus am Praxis-Gerät */ onSite?: boolean }) {
  const [state, action, pending] = useActionState<OnlineAnamnesisState, FormData>(submitOnlineAnamnesisAction, undefined);
  // Pflicht-Einwilligung: Meldung direkt am Feld (statt der flüchtigen Browser-Blase in Systemsprache), Fokus dorthin
  const privacyRef = useRef<HTMLInputElement>(null);
  const [privacyError, setPrivacyError] = useState<string | null>(null);
  const submit = keepValues(action);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    if (!privacyRef.current?.checked) {
      e.preventDefault();
      setPrivacyError(PRIVACY_MISSING);
      privacyRef.current?.scrollIntoView({ block: "center" });
      privacyRef.current?.focus({ preventScroll: true });
      return;
    }
    setPrivacyError(null);
    submit(e);
  }
  if (state?.done && onSite) {
    return (
      <Card className="mt-6 text-center">
        <h2 className="font-display text-2xl font-semibold">Vielen Dank!</h2>
        <p className="mt-2 text-lg">Ihre Angaben sind gespeichert. Bitte geben Sie das Gerät jetzt an die Praxis zurück.</p>
        <p className="mt-6">
          <PracticeExitLink label="Praxis: Gerät entsperren" />
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
    <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-5">
      <input type="hidden" name="token" value={token} />
      {/* Honeypot gegen Bots */}
      <div aria-hidden className="hidden">
        <label>Website <input name="website" tabIndex={-1} autoComplete="off" /></label>
      </div>
      <FormError message={state?.error} revealKey={state} />
      <AnamnesisFields mode="online" />
      <Card>
        <h3 className="mb-2 font-display text-lg font-semibold">Einwilligungen</h3>
        <Checkbox
          ref={privacyRef}
          name="privacy"
          aria-required="true"
          aria-invalid={privacyError ? true : undefined}
          aria-describedby={privacyError ? "privacy-fehler" : undefined}
          onChange={(e) => e.target.checked && setPrivacyError(null)}
          label="Ich habe die Datenschutzhinweise der Praxis erhalten und gelesen. (Pflicht)"
        />
        {privacyError ? (
          <p id="privacy-fehler" className="mb-2 ml-8 text-[13px] leading-5 font-medium text-danger">{privacyError}</p>
        ) : null}
        <p className="mb-2 mt-1 text-[13px] leading-5 text-muted">Die Behandlung und ihre Dokumentation benötigen keine Einwilligung (Art. 9 Abs. 2 lit. h DSGVO). Die folgenden Punkte sind freiwillig und jederzeit in der Praxis widerrufbar. Bereits erteilte Einwilligungen bleiben bestehen.</p>
        <Checkbox name="consent_photo_documentation" label="Fotos meiner Füße zur Behandlungsdokumentation (nur intern)" />
        <Checkbox name="consent_email_reminders" label="Terminerinnerungen per E-Mail" />
        <Checkbox name="consent_sms_reminders" label="Terminerinnerungen per SMS" />
        <Checkbox name="consent_whatsapp" label="Terminabsprachen per WhatsApp (nur Organisatorisches, keine Gesundheitsinformationen; WhatsApp ist ein Dienst von Meta)" />
      </Card>
      <FormActions sticky={false} error={state?.error}>
        <Button type="submit" disabled={pending} className="h-14 w-full text-base sm:w-auto">{pending ? "Wird gesendet …" : "Fragebogen absenden"}</Button>
      </FormActions>
    </form>
  );
}
