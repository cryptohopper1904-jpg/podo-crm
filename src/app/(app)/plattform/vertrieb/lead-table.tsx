"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { Badge, Button, Empty, FormError, FormSuccess, Table } from "@/components/ui";
import { MAX_PER_CLICK, STATUS_LABEL, STOP_STATUSES, isLeadStatus } from "@/lib/vertrieb/constants";
import type { SendPreview } from "@/server/vertrieb";
import { previewSendAction, sendAction } from "./actions";

export type LeadRow = {
  id: string;
  name: string;
  contactPerson: string | null;
  email: string | null;
  city: string | null;
  distanceKm: number | null;
  status: string;
  step: number;
  lastSentAt: string | null;
  suppressed: boolean;
  /** Geschäftsadresse mit Namensbezug (Praxissuche, von der eigenen Praxis-Website) */
  named?: boolean;
};

const tone = (s: string) =>
  s === "kunde" || s === "interessiert" ? "primary" : s === "in_sequenz" ? "info" : s === "geantwortet" ? "warn" : s === "abgemeldet" || s === "kein_interesse" ? "accent" : "neutral";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" }) : "–");

export function LeadTable({ leads }: { leads: LeadRow[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Vorschau gilt genau für die Auswahl zum Zeitpunkt der Vorschau
  const [preview, setPreview] = useState<(SendPreview & { ids: string[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Auswahl „alle“ nur für Einträge, die grundsätzlich noch eine Mail bekommen können
  const selectable = useMemo(
    () => leads.filter((l) => l.email && !l.suppressed && l.step < 3 && !(isLeadStatus(l.status) && STOP_STATUSES.includes(l.status))).map((l) => l.id),
    [leads],
  );
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const ids = [...selected];

  const askPreview = () =>
    start(async () => {
      setError(null);
      setOk(null);
      const forIds = [...ids];
      const r = await previewSendAction(forIds);
      if ("error" in r) {
        setError(r.error);
        setPreview(null);
      } else setPreview({ ...r, ids: forIds });
    });

  const send = () =>
    start(async () => {
      if (!preview) return;
      setError(null);
      const r = await sendAction(preview.ids);
      setPreview(null);
      if ("error" in r) setError(r.error);
      else {
        setSelected(new Set());
        setOk(
          `${r.sent} Mail(s) ${r.mock ? "im Testmodus verarbeitet (nicht wirklich versendet)" : "versendet"}` +
            (r.skipped ? `, ${r.skipped} übersprungen` : "") +
            (r.failed.length ? `. Fehler: ${r.failed.map((f) => `${f.name}: ${f.error}`).join("; ")}` : "."),
        );
      }
    });

  if (!leads.length) return <Empty title="Keine Praxen gefunden">Praxen per CSV-Import oder „Praxis anlegen“ hinzufügen.</Empty>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={askPreview} disabled={pending || ids.length === 0}>Nächste Mail senden …</Button>
        <span className="text-sm text-muted">
          {ids.length} ausgewählt · höchstens {MAX_PER_CLICK} je Klick. Vor dem Versand erscheint eine Vorschau.
        </span>
      </div>
      <FormError message={error} />
      <FormSuccess message={ok} />

      {preview ? (
        <section aria-label="Vorschau" className="rounded-[var(--radius-card)] border-2 border-primary bg-surface p-5">
          <h2 className="font-display text-xl font-semibold">Vorschau: {preview.count} Mail(s) werden gesendet</h2>
          <p className="mt-1 text-sm text-muted">
            {Object.entries(preview.steps).map(([s, n]) => `Mail ${s}: ${n}`).join(" · ") || "keine"} · Restkontingent heute (24 h): {preview.dayLeft}
          </p>
          {preview.problems.length ? (
            <div role="alert" className="mt-3 rounded-xl bg-accent-soft px-4 py-3 text-sm text-accent-soft-text">
              <p className="font-semibold">Versand nicht möglich:</p>
              <ul className="list-disc pl-5">{preview.problems.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          ) : null}
          {preview.first ? (
            <div className="mt-4 rounded-xl border border-border bg-surface-2 p-4 text-sm">
              <p><span className="text-muted">Von:</span> {preview.first.from}</p>
              <p><span className="text-muted">An:</span> {preview.first.to} ({preview.first.leadName}, Mail {preview.first.step})</p>
              <p><span className="text-muted">Betreff:</span> <strong>{preview.first.subject}</strong></p>
              <pre className="mt-3 whitespace-pre-wrap font-sans text-[14px] leading-relaxed">{preview.first.text}</pre>
            </div>
          ) : null}
          {preview.skipped.length ? (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer font-semibold">{preview.skipped.length} übersprungen</summary>
              <ul className="mt-2 list-disc pl-5">{preview.skipped.map((s) => <li key={s.id}>{s.name}: {s.reason}</li>)}</ul>
            </details>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={send} disabled={pending || preview.count === 0 || preview.problems.length > 0}>
              {pending ? "Sende …" : `Jetzt ${preview.count} Mail(s) senden`}
            </Button>
            <Button variant="secondary" onClick={() => setPreview(null)} disabled={pending}>Abbrechen</Button>
          </div>
        </section>
      ) : null}

      <Table>
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label="Alle sendbaren auswählen"
                className="size-5 accent-[var(--primary)]"
                checked={selectable.length > 0 && selectable.every((id) => selected.has(id))}
                onChange={(e) => setSelected(e.target.checked ? new Set(selectable) : new Set())}
                disabled={!!preview}
              />
            </th>
            <th>Praxis</th>
            <th>E-Mail</th>
            <th>Ort</th>
            <th>km</th>
            <th>Status</th>
            <th>Mails</th>
            <th>Zuletzt</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((l) => (
            <tr key={l.id}>
              <td>
                <input type="checkbox" aria-label={`${l.name} auswählen`} className="size-5 accent-[var(--primary)]" checked={selected.has(l.id)} onChange={() => toggle(l.id)} disabled={!!preview} />
              </td>
              <td>
                <Link href={`/plattform/vertrieb/${l.id}`} className="font-semibold text-primary">{l.name}</Link>
                {l.contactPerson ? <p className="text-xs text-muted">{l.contactPerson}</p> : null}
              </td>
              <td className="break-all text-sm">{l.email ?? <span className="text-muted">–</span>}{l.suppressed ? <> <Badge tone="accent">gesperrt</Badge></> : null}{l.named && l.email ? <> <Badge tone="warn">mit Namensbezug</Badge></> : null}</td>
              <td className="text-sm">{l.city ?? "–"}</td>
              <td className="tabular-nums text-sm">{l.distanceKm ?? "–"}</td>
              <td><Badge tone={tone(l.status)}>{isLeadStatus(l.status) ? STATUS_LABEL[l.status] : l.status}</Badge></td>
              <td className="tabular-nums">{l.step} / 3</td>
              <td className="text-sm">{fmt(l.lastSentAt)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
