"use client";

import { useActionState, useState } from "react";
import { Button, Checkbox, Field, FormError, FormSuccess, Input } from "@/components/ui";
import { keepValues } from "@/lib/forms";
import { saveVoiceSetupAction, setVoiceLiveAction } from "./actions";

type Vendor = "vapi" | "retell";

const VENDOR_HINT: Record<Vendor, { label: string; secret: string; hint: string }> = {
  vapi: {
    label: "Vapi",
    secret: "Server-URL-Secret (optional)",
    hint: "Leer lassen: PodoCRM erzeugt ein sicheres Secret, das in der Vorlage steht. Vapi sendet es als Header x-vapi-secret.",
  },
  retell: {
    label: "Retell AI",
    secret: "API-Schlüssel des Retell-Kontos",
    hint: "Retell signiert jeden Aufruf mit diesem Schlüssel (x-retell-signature). Er wird verschlüsselt gespeichert und nie wieder angezeigt.",
  },
};

/** Schritt 1+2: Anbieter wählen, Geheimnis eingeben. */
export function VendorSetupForm({ vendor: initial, hasSecret }: { vendor: Vendor; hasSecret: boolean }) {
  const [state, run, pending] = useActionState(saveVoiceSetupAction, undefined);
  const [vendor, setVendor] = useState<Vendor>(initial);
  const h = VENDOR_HINT[vendor];
  return (
    <form onSubmit={keepValues(run)} className="flex flex-col gap-3">
      <FormError message={state?.error} />
      <FormSuccess message={state?.ok} />
      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-1 text-sm font-semibold">Anbieter</legend>
        {(Object.keys(VENDOR_HINT) as Vendor[]).map((v) => (
          <label key={v} className="flex items-center gap-2 text-sm">
            <input type="radio" name="vendor" value={v} checked={vendor === v} onChange={() => setVendor(v)} />
            {VENDOR_HINT[v].label}
          </label>
        ))}
      </fieldset>
      <Field label={h.secret} hint={<>{h.hint}{hasSecret && vendor === initial ? " Bereits hinterlegt – leer lassen, um es beizubehalten." : ""}</>}>
        <Input name="secret" type="password" autoComplete="off" placeholder={hasSecret && vendor === initial ? "••••••••" : ""} />
      </Field>
      <div><Button type="submit" disabled={pending}>{pending ? "…" : "Speichern"}</Button></div>
    </form>
  );
}

export function CopyField({ value, label = "Kopieren" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="block min-w-0 flex-1 break-all rounded-xl bg-surface-2 p-3 text-xs">{value}</code>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 2000);
          });
        }}
      >
        {done ? "Kopiert" : label}
      </Button>
    </div>
  );
}

/** Lädt die ausgefüllte Vorlage als Datei herunter (im Browser erzeugt, kein weiterer Endpunkt). */
export function DownloadButton({ filename, content, label }: { filename: string; content: string; label: string }) {
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={() => {
        const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}
    >
      {label}
    </Button>
  );
}

/** Schritt 5: Go-live-Schalter */
export function LiveToggle({ live, disabled }: { live: boolean; disabled?: boolean }) {
  const [state, run, pending] = useActionState(setVoiceLiveAction, undefined);
  return (
    <form onSubmit={keepValues(run)} className="flex flex-col gap-3">
      <FormError message={state?.error} />
      <FormSuccess message={state?.ok} />
      <Checkbox name="live" defaultChecked={live} disabled={disabled} label="Live: echte Anrufe annehmen (sonst Testmodus)" />
      <div><Button type="submit" disabled={pending || disabled}>{pending ? "…" : "Übernehmen"}</Button></div>
    </form>
  );
}
