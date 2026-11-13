"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { FileDown, Mail, MailCheck, Send } from "lucide-react";
import { Badge, Button, FormError, FormSuccess, Table } from "@/components/ui";
import { keepValues } from "@/lib/forms";
import { createDunningsAction, markDunningPostedAction, sendDunningEmailAction } from "../actions";

export type OverviewItem = {
  invoiceId: string;
  number: string | null;
  name: string;
  dueAt: string;
  daysOverdue: number;
  openLabel: string;
  /** „Zahlungserinnerung ab sofort“ / „1. Mahnung ab 12.12.2026“ / „alle Stufen erstellt“ */
  nextLabel: string;
  due: boolean;
  /** vorige Stufe noch nicht versendet */
  warn: boolean;
  last: { id: string; label: string; date: string; sentLabel: string | null } | null;
  hasEmail: boolean;
};

/** Überfällige Rechnungen auswählen und die fällige Stufe erstellen. */
export function DunningOverviewTable({ items, canWrite }: { items: OverviewItem[]; canWrite: boolean }) {
  const dueIds = items.filter((i) => i.due).map((i) => i.invoiceId);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [state, action, pending] = useActionState(createDunningsAction, undefined);
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allDue = dueIds.length > 0 && dueIds.every((id) => selected.has(id));
  return (
    <form
      onSubmit={(e) => {
        if (!selected.size) return e.preventDefault();
        if (!window.confirm(`Für ${selected.size} ${selected.size === 1 ? "Rechnung" : "Rechnungen"} die fällige Mahnstufe erstellen? Erstellte Schreiben sind unveränderbar.`)) return e.preventDefault();
        keepValues(action)(e);
        setSelected(new Set());
      }}
      className="flex flex-col gap-4"
    >
      {[...selected].map((id) => (
        <input key={id} type="hidden" name="invoiceId" value={id} />
      ))}
      <FormSuccess message={state?.success} />
      <FormError message={state?.error} />
      {state?.skipped?.length ? (
        <ul className="rounded-xl bg-surface-2 px-4 py-3 text-sm text-muted">
          {state.skipped.map((s) => (
            <li key={s}>Übersprungen – {s}</li>
          ))}
        </ul>
      ) : null}
      {canWrite ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending || !selected.size}>
            <Send size={18} aria-hidden /> {pending ? "Erstelle …" : `Mahnstufe erstellen (${selected.size})`}
          </Button>
          <Button type="button" variant="secondary" disabled={!dueIds.length} onClick={() => setSelected(allDue ? new Set() : new Set(dueIds))}>
            {allDue ? "Auswahl aufheben" : `Alle fälligen auswählen (${dueIds.length})`}
          </Button>
        </div>
      ) : null}
      <Table>
        <thead>
          <tr>
            {canWrite ? <th className="w-10"><span className="sr-only">Auswahl</span></th> : null}
            <th>Rechnung</th>
            <th>Empfänger</th>
            <th>Zahlbar bis</th>
            <th className="text-right">Tage überfällig</th>
            <th className="text-right">Offen</th>
            <th>Nächste Stufe</th>
            <th>Letztes Schreiben</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.invoiceId} className="hover:bg-surface-2">
              {canWrite ? (
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${i.number} auswählen`}
                    className="size-5 accent-[var(--primary)]"
                    checked={selected.has(i.invoiceId)}
                    disabled={!i.due}
                    onChange={() => toggle(i.invoiceId)}
                  />
                </td>
              ) : null}
              <td>
                <Link href={`/rechnungen/${i.invoiceId}`} className="font-semibold tabular-nums hover:text-primary">{i.number}</Link>
              </td>
              <td>{i.name}</td>
              <td className="text-sm tabular-nums">{i.dueAt}</td>
              <td className="text-right tabular-nums">{i.daysOverdue}</td>
              <td className="text-right font-semibold tabular-nums text-danger">{i.openLabel}</td>
              <td className="text-sm">
                {i.due ? <Badge tone="accent">{i.nextLabel}</Badge> : i.warn ? <Badge tone="warn">{i.nextLabel}</Badge> : <span className="text-muted">{i.nextLabel}</span>}
              </td>
              <td className="text-sm">
                {i.last ? (
                  <span className="flex flex-col">
                    <a href={`/api/mahnungen/${i.last.id}/pdf`} target="_blank" rel="noreferrer" className="font-semibold text-primary underline">
                      {i.last.label} vom {i.last.date}
                    </a>
                    {i.last.sentLabel ? <span className="text-xs text-muted">{i.last.sentLabel}</span> : <span className="text-xs font-semibold text-danger">noch nicht versendet</span>}
                  </span>
                ) : (
                  <span className="text-muted">–</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </form>
  );
}

/** PDF öffnen (Drucken), per E-Mail senden oder „per Post versendet“ vermerken – der Versandvermerk ist einmalig. */
export function DunningLetterActions({ dunningId, recipientEmail, canWrite, sent }: { dunningId: string; recipientEmail: string | null; canWrite: boolean; sent: boolean }) {
  const [mail, sendMail, mailPending] = useActionState(sendDunningEmailAction, undefined);
  const [post, markPost, postPending] = useActionState(markDunningPostedAction, undefined);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={`/api/mahnungen/${dunningId}/pdf`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 text-[15px] font-semibold hover:bg-surface-2"
        >
          <FileDown size={18} aria-hidden /> PDF / Drucken
        </a>
        {canWrite && !sent ? (
          <>
            <form
              onSubmit={(e) => {
                if (!recipientEmail || !window.confirm(`Schreiben als PDF an ${recipientEmail} senden? Der Versandvermerk lässt sich danach nicht mehr ändern.`)) return e.preventDefault();
                keepValues(sendMail)(e);
              }}
            >
              <input type="hidden" name="dunningId" value={dunningId} />
              <Button type="submit" variant="secondary" disabled={mailPending || !recipientEmail} title={recipientEmail ? undefined : "Keine E-Mail-Adresse hinterlegt"}>
                <Mail size={18} aria-hidden /> {mailPending ? "Sende …" : "Per E-Mail senden"}
              </Button>
            </form>
            <form
              onSubmit={(e) => {
                if (!window.confirm("Vermerken, dass das Schreiben per Post versendet wurde? Der Versandvermerk lässt sich danach nicht mehr ändern.")) return e.preventDefault();
                keepValues(markPost)(e);
              }}
            >
              <input type="hidden" name="dunningId" value={dunningId} />
              <Button type="submit" variant="ghost" disabled={postPending}>
                <MailCheck size={18} aria-hidden /> Per Post versendet
              </Button>
            </form>
          </>
        ) : null}
      </div>
      <FormSuccess message={mail?.success ?? post?.success} />
      <FormError message={mail?.error ?? post?.error} />
    </div>
  );
}
