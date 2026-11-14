"use client";

import { useState, useTransition } from "react";
import { Button, Card, FormError, FormSuccess, Table } from "@/components/ui";
import type { ImportPreview } from "@/server/vertrieb";
import { importAction, previewImportAction } from "../actions";

const MAX_BYTES = 1_000_000;

export function CsvImport() {
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [source, setSource] = useState("");

  const onFile = async (file: File | undefined) => {
    setError(null);
    setOk(null);
    setPreview(null);
    setCsv(null);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError("Datei zu groß (max. 1 MB).");
      return;
    }
    const text = await file.text();
    setCsv(text);
    start(async () => {
      const p = await previewImportAction(text);
      if (p.error) setError(p.error);
      else setPreview(p);
    });
  };

  const doImport = () =>
    start(async () => {
      if (!csv) return;
      const r = await importAction(csv, source);
      if (r.error) setError(r.error);
      else {
        setOk(`${r.imported} Praxis/Praxen importiert, ${r.skipped} übersprungen.`);
        setPreview(null);
        setCsv(null);
      }
    });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <label className="flex flex-col gap-2 text-sm font-medium">
          CSV-Datei wählen
          <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => onFile(e.target.files?.[0])} className="text-sm" />
        </label>
        <label className="mt-4 flex flex-col gap-2 text-sm font-medium">
          Quelle der Daten *
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            required
            minLength={3}
            maxLength={120}
            placeholder="z. B. Messe XY 2026 (Kontaktformulare), eigene Recherche Praxis-Websites"
            className="h-10 rounded-xl border border-border bg-surface px-3 text-sm"
          />
          <span className="text-xs font-normal text-muted">Pflicht (Art. 14 DSGVO): wird an jedem importierten Eintrag gespeichert. Einwilligungen in E-Mails werden nicht importiert, sondern je Eintrag dokumentiert.</span>
        </label>
      </Card>
      <FormError message={error} />
      <FormSuccess message={ok} />
      {preview ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={doImport} disabled={pending || preview.newCount === 0 || source.trim().length < 3}>{pending ? "…" : `${preview.newCount} importieren`}</Button>
            <span className="text-sm text-muted">{preview.skippedCount} werden übersprungen.</span>
          </div>
          <Table>
            <thead>
              <tr><th>Zeile</th><th>Praxis</th><th>E-Mail</th><th>Ort</th><th>Ergebnis</th></tr>
            </thead>
            <tbody>
              {preview.decisions.map((d) => (
                <tr key={d.line}>
                  <td className="tabular-nums">{d.line}</td>
                  <td>{d.lead?.name ?? "–"}</td>
                  <td className="break-all text-sm">{d.lead?.email ?? "–"}</td>
                  <td className="text-sm">{[d.lead?.zip, d.lead?.city].filter(Boolean).join(" ") || "–"}</td>
                  <td className={d.action === "neu" ? "font-semibold text-primary" : "text-muted"}>{d.action === "neu" ? "neu" : `übersprungen: ${d.reason}`}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      ) : null}
    </div>
  );
}
