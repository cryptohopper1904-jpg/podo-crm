"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { Badge, Button, Empty, FormError, FormSuccess, Table } from "@/components/ui";
import { MAX_PER_CLICK, STATUS_LABEL, STOP_STATUSES, isLeadStatus } from "@/lib/vertrieb/constants";
import { BULK_STATUSES, type Stage } from "@/lib/vertrieb/pipeline";
import type { SendPreview } from "@/server/vertrieb";
import { bulkAction, previewSendAction, sendAction } from "./actions";

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
  stage?: Stage;
  stageLabel?: string;
  campaignName?: string | null;
  /** registrierte Praxis (zugeordnet über Code/E-Mail/Domain) */
  orgName?: string | null;
  /** dokumentierte Einwilligung (§ 7 Abs. 2 Nr. 2 UWG) – ohne sie wird nicht gesendet */
  consent?: boolean;
};

const stageTone = (s?: Stage) => (s === "kunde" ? "primary" : s === "test" ? "info" : s === "geantwortet" ? "warn" : s === "aus" ? "accent" : "neutral");

const tone = (s: string) =>
  s === "kunde" || s === "interessiert" ? "primary" : s === "in_sequenz" ? "info" : s === "geantwortet" ? "warn" : s === "abgemeldet" || s === "kein_interesse" ? "accent" : "neutral";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" }) : "–");

export function LeadTable({ leads, campaigns = [] }: { leads: LeadRow[]; campaigns?: { id: string; name: string }[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState("");
  // Vorschau gilt genau für die Auswahl zum Zeitpunkt der Vorschau
  const [preview, setPreview] = useState<(SendPreview & { ids: string[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Auswahl „alle“ nur für Einträge, die grundsätzlich noch eine Mail bekommen können
  const selectable = useMemo(
    () => leads.filter((l) => l.email && l.consent && !l.suppressed && l.step < 3 && !(isLeadStatus(l.status) && STOP_STATUSES.includes(l.status))).map((l) => l.id),
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
  const allIds = leads.map((l) => l.id);

  const runBulk = () =>
    start(async () => {
      setError(null);
      setOk(null);
      const [op, value = ""] = bulk.split(":");
      if (op === "abmelden" && !window.confirm(`${ids.length} Einträge abmelden? Die Adressen kommen dauerhaft auf die Sperrliste, die Einträge werden samt Verlauf gelöscht.`)) return;
      let note = "";
      if (op === "einwilligung") {
        note = window.prompt(`Einwilligung für ${ids.length} Einträge dokumentieren.\nWortlaut, Kanal und Datum der ausdrücklichen Einwilligung in Infos per E-Mail (Pflicht, z. B. „Messe XY 10.11.2026, Formular: Ja, Infos per E-Mail“)`)?.trim() ?? "";
        if (!note) return;
      }
      const input = op === "status" ? { op, status: value } : op === "kampagne" ? { op, campaignId: value } : op === "einwilligung" ? { op, note } : { op };
      const r = await bulkAction(ids, input);
      if ("error" in r) setError(r.error);
      else {
        setOk(r.ok);
        setSelected(new Set());
        setBulk("");
      }
    });

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
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" className="text-sm font-semibold text-primary" onClick={() => setSelected(new Set(allIds))} disabled={!!preview}>Alle {allIds.length} auswählen</button>
          <label className="sr-only" htmlFor="bulk">Sammelaktion</label>
          <select id="bulk" value={bulk} onChange={(e) => setBulk(e.target.value)} className="h-10 rounded-xl border border-border bg-surface px-3 text-sm" disabled={!!preview}>
            <option value="">Sammelaktion …</option>
            <optgroup label="Status setzen">
              {BULK_STATUSES.map((st) => <option key={st} value={`status:${st}`}>{STATUS_LABEL[st]}</option>)}
            </optgroup>
            <optgroup label="Kampagne">
              {campaigns.map((c) => <option key={c.id} value={`kampagne:${c.id}`}>zu „{c.name}“ hinzufügen</option>)}
              <option value="kampagne:">aus Kampagne entfernen</option>
            </optgroup>
            <optgroup label="Einwilligung">
              <option value="einwilligung">Einwilligung dokumentieren …</option>
              <option value="einwilligung_entfernen">Einwilligung entfernen</option>
            </optgroup>
            <option value="abmelden">Abmelden (Sperrliste, Einträge löschen)</option>
          </select>
          <Button variant="secondary" className="h-10" onClick={runBulk} disabled={pending || !bulk || ids.length === 0 || !!preview}>Ausführen</Button>
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
                aria-label="Alle sendbaren auswählen (mit Einwilligung)"
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
            <th>Stufe</th>
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
                {l.campaignName ? <p className="text-xs text-muted">Kampagne: {l.campaignName}</p> : null}
                {l.orgName ? <p className="text-xs text-muted">registriert als „{l.orgName}“</p> : null}
              </td>
              <td className="break-all text-sm">{l.email ?? <span className="text-muted">–</span>}{l.suppressed ? <> <Badge tone="accent">gesperrt</Badge></> : null}{l.named && l.email ? <> <Badge tone="warn">mit Namensbezug</Badge></> : null}{l.email && l.consent === false ? <> <Badge tone="neutral">ohne Einwilligung</Badge></> : null}{l.consent ? <> <Badge tone="primary">Einwilligung</Badge></> : null}</td>
              <td className="text-sm">{l.city ?? "–"}</td>
              <td className="tabular-nums text-sm">{l.distanceKm ?? "–"}</td>
              <td>{l.stage ? <Badge tone={stageTone(l.stage)}>{l.stageLabel}</Badge> : "–"}</td>
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
