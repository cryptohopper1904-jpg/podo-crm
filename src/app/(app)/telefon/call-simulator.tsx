"use client";

import { useActionState, useState } from "react";
import { keepValues } from "@/lib/forms";
import { Button, Field, FormError, FormSuccess, Input, Select, Textarea } from "@/components/ui";
import { simulateCallAction } from "./actions";

const EXAMPLES: Record<string, (d: { tomorrow: string; service: string }) => unknown> = {
  freie_termine: ({ tomorrow, service }) => ({ von: tomorrow, leistung: service }),
  termin_buchen: ({ service }) => ({ vorname: "Erika", nachname: "Musterfrau", telefon: "+49 151 00000000", leistung: service, termin: "<termin aus freie_termine>" }),
  termin_absagen: ({ tomorrow }) => ({ datum: tomorrow, telefon: "+49 151 00000000", name: "Erika Musterfrau" }),
  rueckruf: () => ({ name: "Erika Musterfrau", telefon: "+49 151 00000000", anliegen: "Frage zur Terminverschiebung", dringend: false }),
  praxis_info: () => ({}),
};

/** Testanruf: gleiche Verarbeitung wie /api/voice/{vendor}, nur ohne Signaturprüfung (nur Entwicklung/Testmodus). */
export function CallSimulator({ initialCallId, tomorrow, service, vendor = "vapi" }: { initialCallId: string; tomorrow: string; service: string; vendor?: "vapi" | "retell" }) {
  const [state, run, pending] = useActionState(simulateCallAction, undefined);
  const [tool, setTool] = useState("freie_termine");
  const [args, setArgs] = useState(() => JSON.stringify(EXAMPLES.freie_termine({ tomorrow, service }), null, 2));
  const callId = state?.callId ?? initialCallId;
  return (
    <div className="flex flex-col gap-4">
      <FormError message={state?.error} />
      <FormSuccess message={state?.ok} />
      {state?.result ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-surface-2 p-3 text-xs">{state.result}</pre> : null}
      <form onSubmit={keepValues(run)} className="flex flex-col gap-3">
        <input type="hidden" name="kind" value="tool" />
        <input type="hidden" name="vendor" value={vendor} />
        <input type="hidden" name="callId" value={callId} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Anrufende Nummer (Testdaten)"><Input name="caller" defaultValue="+49 151 00000000" /></Field>
          <Field label="Werkzeug">
            <Select
              name="tool"
              value={tool}
              onChange={(e) => {
                setTool(e.target.value);
                setArgs(JSON.stringify(EXAMPLES[e.target.value]?.({ tomorrow, service }) ?? {}, null, 2));
              }}
            >
              {Object.keys(EXAMPLES).map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Argumente (JSON)" hint="Wie vom Sprachmodell an das Werkzeug übergeben.">
          <Textarea name="args" rows={6} value={args} onChange={(e) => setArgs(e.target.value)} className="font-mono text-xs" />
        </Field>
        <div><Button type="submit" disabled={pending}>{pending ? "…" : "Werkzeug aufrufen"}</Button></div>
      </form>
      <form onSubmit={keepValues(run)} className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
        <input type="hidden" name="kind" value="end" />
        <input type="hidden" name="vendor" value={vendor} />
        <input type="hidden" name="callId" value={callId} />
        <input type="hidden" name="caller" value="+49 151 00000000" />
        <Field label="Zusammenfassung (Ende-Bericht)" className="min-w-64 flex-1"><Input name="summary" defaultValue="Testanruf: Terminwunsch aufgenommen." /></Field>
        <Button type="submit" variant="secondary" disabled={pending}>Gespräch beenden</Button>
      </form>
      <p className="text-xs text-muted">Simulations-ID: <code>{callId}</code></p>
    </div>
  );
}
