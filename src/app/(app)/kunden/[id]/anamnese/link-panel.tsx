"use client";

import { keepValues } from "@/lib/forms";
import { useActionState, useState } from "react";
import { Copy, Link2 } from "lucide-react";
import { Button, FormError, Textarea } from "@/components/ui";
import { createLinkAction, type LinkState } from "./actions";

/** Einmal-Link für die Online-Anamnese erzeugen. Der Link wird nur jetzt angezeigt (gespeichert ist nur der Hash). */
export function LinkPanel({ patientId, firstName, practiceName }: { patientId: string; firstName: string | null; practiceName: string }) {
  const [state, action, pending] = useActionState<LinkState, FormData>(createLinkAction, undefined);
  const [copied, setCopied] = useState<string | null>(null);
  const until = state?.expiresAt ? new Date(state.expiresAt).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" }) : "";
  // Nachricht ohne Gesundheitsdaten – geeignet für E-Mail und (mit Einwilligung) WhatsApp
  const message = state?.url
    ? `Hallo${firstName ? ` ${firstName}` : ""},\nbitte füllen Sie vor Ihrem Termin unseren Anamnesebogen aus:\n${state.url}\nDer Link ist nur einmal nutzbar und gültig bis ${until}.\nViele Grüße\n${practiceName}`
    : "";
  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setCopied(null);
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={keepValues(action)}>
        <input type="hidden" name="patientId" value={patientId} />
        <Button type="submit" variant="secondary" disabled={pending}><Link2 size={18} aria-hidden /> {state?.url ? "Neuen Link erzeugen" : "Online-Anamnese-Link erzeugen"}</Button>
      </form>
      <FormError message={state?.error} revealKey={state} />
      {state?.url ? (
        <>
          <p className="break-all rounded-xl bg-surface-2 p-3 font-mono text-sm">{state.url}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" className="text-sm" onClick={() => copy(state.url!, "link")}><Copy size={16} aria-hidden /> {copied === "link" ? "Kopiert" : "Link kopieren"}</Button>
            <Button type="button" variant="secondary" className="h-auto min-h-11 text-sm whitespace-normal" onClick={() => copy(message, "text")}><Copy size={16} aria-hidden /> {copied === "text" ? "Kopiert" : "Text für E-Mail/WhatsApp kopieren"}</Button>
          </div>
          <Textarea readOnly value={message} rows={6} aria-label="Nachrichtentext" />
          <p className="text-[13px] leading-5 text-muted">Der Link wird nur jetzt angezeigt. Ein neuer Link macht ältere, unbenutzte Links ungültig. WhatsApp nur mit Einwilligung.</p>
        </>
      ) : null}
    </div>
  );
}
