"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Field, Table } from "@/components/ui";
import { FormError, FormSuccess } from "@/components/form-error";
import { money } from "@/lib/format";
import { confirmPayoutAction, previewPayoutAction, type PreviewState } from "./actions";

const de = (iso: string | null) => (iso ? iso.split("-").reverse().join(".") : "–");

/**
 * Rückmeldung des Abrechnungszentrums einlesen: Datei wählen → Vorschau (Zuordnung, Summen, Hinweise; ändert nichts) →
 * „Übernehmen“ schickt dieselbe Datei mit ihrer Prüfsumme erneut. Fehler sperren die Übernahme.
 */
export function PayoutImport({ batchId, disabled }: { batchId: string; disabled: boolean }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<PreviewState>(undefined);
  const [done, setDone] = useState<{ error?: string; ok?: string } | undefined>(undefined);
  const [pending, start] = useTransition();
  const p = state?.preview;
  const form = (extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("batchId", batchId);
    if (file) fd.set("file", file);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    return fd;
  };
  return (
    <div className="flex flex-col gap-4">
      <FormError message={state?.error ?? done?.error} revealKey={state ?? done} />
      <FormSuccess message={done?.ok} />
      <Field label="Rückmeldung (CSV oder JSON)" hint="Neutrales Format laut Beschreibung „Rückmeldung“ (docs/GKV-ABRECHNUNGSZENTRUM.md), höchstens 1 MB. Wird geprüft, nie ausgeführt.">
        <input
          type="file"
          accept=".csv,.json,text/csv,application/json"
          disabled={disabled || pending}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setState(undefined);
            setDone(undefined);
          }}
          className="text-sm file:mr-3 file:h-11 file:rounded-xl file:border file:border-border file:bg-surface-2 file:px-4 file:font-semibold"
        />
      </Field>
      <div>
        <Button type="button" variant="secondary" disabled={!file || disabled || pending} onClick={() => start(async () => setState(await previewPayoutAction(form())))}>
          {pending && !p ? "Wird geprüft …" : "Prüfen (Vorschau)"}
        </Button>
      </div>
      {p ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <p className="text-sm">
            Datei {p.dateiname} · Auszahlung am <strong>{de(p.auszahlungsdatum)}</strong>
            {p.sammelrechnungsnummer ? <> · Sammelrechnung <strong>{p.sammelrechnungsnummer}</strong></> : null} · Prüfsumme <code className="text-xs">{p.sha256.slice(0, 16)}…</code>
          </p>
          {p.bereitsEingelesen ? <p className="rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn-soft-text">Diese Datei ist für diesen Abrechnungslauf bereits eingelesen.</p> : null}
          {p.fehler.length ? (
            <div className="rounded-xl bg-accent-soft px-4 py-3 text-sm text-accent-soft-text">
              <p className="font-semibold">Fehler – nichts übernommen. Bitte die Datei korrigieren:</p>
              <ul className="mt-1 list-disc pl-5">{p.fehler.map((f) => <li key={f}>{f}</li>)}</ul>
            </div>
          ) : (
            <>
              {p.andererLauf ? <p className="text-sm text-muted">{p.andererLauf} Zeile(n) gehören zu einem anderen Abrechnungslauf und werden hier übersprungen.</p> : null}
              <Table label="Zuordnung der Rückmeldung" minWidth={820}>
                <thead><tr><th>Zeile</th><th>Person</th><th>VO vom</th><th>Kassenanteil (Soll)</th><th>Ausgezahlt</th><th>Absetzung</th><th>Hinweis</th></tr></thead>
                <tbody>
                  {p.zeilen.map((z) => (
                    <tr key={z.zeile}>
                      <td className="tabular-nums">{z.zeile}</td>
                      <td>{z.person}</td>
                      <td>{de(z.ausstellungsdatum)}</td>
                      <td className="tabular-nums">{z.sollCent === null ? "–" : money(z.sollCent)}</td>
                      <td className="tabular-nums">{money(z.ausgezahltCent)}</td>
                      <td>{z.absetzung ? `${money(z.absetzung.betragCent)}${z.absetzung.code ? ` (${z.absetzung.code})` : ""} – ${z.absetzung.grund}${z.absetzungVorhanden ? " · schon erfasst, wird nicht erneut angelegt" : ""}` : "–"}</td>
                      <td className="text-sm text-warn-soft-text">{z.hinweise.join(" · ") || "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <p className="text-sm">
                Summe ausgezahlt <strong>{money(p.summeAusgezahltCent)}</strong> · Absetzungen <strong>{money(p.summeAbsetzungCent)}</strong>. Übernehmen legt eine Auszahlung und die neuen
                Absetzungen (Status „offen“) an. Die Verordnungen bleiben unverändert.
              </p>
              <div>
                <Button
                  type="button"
                  disabled={disabled || pending || p.bereitsEingelesen}
                  onClick={() =>
                    start(async () => {
                      const r = await confirmPayoutAction(form({ sha256: p.sha256 }));
                      setDone(r);
                      if (r?.ok) {
                        setState(undefined);
                        router.refresh();
                      }
                    })
                  }
                >
                  {pending ? "Wird übernommen …" : "Rückmeldung übernehmen"}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
