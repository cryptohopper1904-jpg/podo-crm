"use client";

import { useActionState, useState } from "react";
import { Copy, KeyRound } from "lucide-react";
import { createPortalLinkAction } from "@/server/portal";
import { keepValues } from "@/lib/forms";
import { Button, FormError, Input } from "./ui";

/**
 * Erzeugt einen Patientenportal-Link (30 Tage gültig, ältere Links der Person werden widerrufen).
 * Der Link wird nur einmal angezeigt – danach nur noch als Hash gespeichert.
 */
export function PortalLinkButton({ patientId }: { patientId: string }) {
  const [state, action, pending] = useActionState(createPortalLinkAction, undefined);
  const [copied, setCopied] = useState(false);
  return (
    <div className="no-print flex flex-col gap-2">
      <form
        onSubmit={(e) => {
          if (state?.url && !window.confirm("Neuen Link erzeugen? Der bisherige Portal-Link wird ungültig.")) return e.preventDefault();
          keepValues(action)(e);
        }}
      >
        <input type="hidden" name="patientId" value={patientId} />
        <Button type="submit" variant="secondary" disabled={pending}>
          <KeyRound size={18} aria-hidden /> {pending ? "Erzeuge …" : "Patientenportal-Link"}
        </Button>
      </form>
      <FormError message={state?.error} />
      {state?.url ? (
        <div className="flex max-w-xl flex-col gap-2 rounded-xl bg-surface-2 p-3 text-sm">
          <p>Gültig bis {state.expires}. Nur an die Person selbst weitergeben – der Link wird nicht erneut angezeigt.</p>
          <div className="flex gap-2">
            <Input readOnly value={state.url} className="min-w-0 flex-1" onFocus={(e) => e.currentTarget.select()} />
            <Button
              type="button"
              variant="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(state.url!);
                  setCopied(true);
                } catch {
                  window.prompt("Link kopieren:", state.url);
                }
              }}
            >
              <Copy size={18} aria-hidden /> {copied ? "Kopiert" : "Kopieren"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
