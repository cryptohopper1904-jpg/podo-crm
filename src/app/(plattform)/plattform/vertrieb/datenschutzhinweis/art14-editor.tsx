"use client";

import { useId, useMemo, useState, useSyncExternalStore } from "react";
import { ART14_DRAFT_MARK, ART14_OPTIONAL_PLACEHOLDER, fillPlaceholders, openPlaceholders } from "@/lib/vertrieb/dsgvo";

const STORE_KEY = "vertrieb-art14-angaben";

const LABEL: Record<string, string> = {
  Firma: "Firma (Verantwortlicher)",
  "E-Mail": "E-Mail für Widerspruch",
  Datenschutzkontakt: "Datenschutzkontakt",
  Aufsichtsbehörde: "Aufsichtsbehörde",
  [ART14_OPTIONAL_PLACEHOLDER]: "Druck- und Versanddienstleister (optional)",
};

/** Merkt sich die allgemeinen Angaben (Firma, E-Mail …) nur in diesem Browser – Praxisdaten werden nicht gespeichert. */
const REMEMBER = new Set(Object.keys(LABEL));

const subscribe = (cb: () => void) => {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
};
const readStore = () => {
  try {
    return localStorage.getItem(STORE_KEY) ?? "{}";
  } catch {
    return "{}";
  }
};

function parseStore(raw: string): { values: Record<string, string>; none: boolean } {
  try {
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const values: Record<string, string> = {};
    for (const k of REMEMBER) if (typeof saved[k] === "string") values[k] = saved[k] as string;
    return { values, none: saved.__keineDienstleister === true };
  } catch {
    return { values: {}, none: false };
  }
}

function writeStore(values: Record<string, string | undefined>, none: boolean) {
  try {
    const keep: Record<string, unknown> = { __keineDienstleister: none };
    for (const r of REMEMBER) if (values[r] !== undefined) keep[r] = values[r];
    localStorage.setItem(STORE_KEY, JSON.stringify(keep));
  } catch {
    /* ohne Speicher weiter */
  }
}

/**
 * Datenschutzhinweis nach Art. 14 DSGVO: offene Platzhalter ausfüllen, Vorschau, Kopieren bzw. Herunterladen.
 * Der Entwurfsvermerk steht nur in der Ansicht, nicht im Brieftext. Kopieren/Download erst, wenn keine {{…}} mehr offen sind.
 */
export function Art14Editor({ template, filename }: { template: string; filename: string }) {
  const id = useId();
  const keys = useMemo(() => openPlaceholders(template), [template]);
  // gespeicherte allgemeine Angaben (nur dieser Browser); Eingaben in dieser Ansicht haben Vorrang
  const raw = useSyncExternalStore(subscribe, readStore, () => "{}");
  const saved = useMemo(() => parseStore(raw), [raw]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [noneEdit, setNoneEdit] = useState<boolean | null>(null);
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const values: Record<string, string | undefined> = { ...saved.values, ...edits };
  const none = noneEdit ?? saved.none;

  const set = (k: string, v: string) => {
    setCopied("idle");
    const n = { ...edits, [k]: v };
    setEdits(n);
    writeStore({ ...saved.values, ...n }, none);
  };
  const setNone = (v: boolean) => {
    setCopied("idle");
    setNoneEdit(v);
    writeStore(values, v);
  };

  const effective = { ...values, [ART14_OPTIONAL_PLACEHOLDER]: none ? "" : values[ART14_OPTIONAL_PLACEHOLDER]?.trim() ? values[ART14_OPTIONAL_PLACEHOLDER] : undefined };
  const text = fillPlaceholders(template, effective);
  const open = openPlaceholders(text);
  const ready = open.length === 0;

  const download = () => {
    const url = URL.createObjectURL(new Blob(["﻿", text.replace(/\n/g, "\r\n")], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p role="note" className="rounded-xl border-2 border-warn-soft-text/40 bg-warn-soft px-4 py-3 font-semibold text-warn-soft-text">
        {ART14_DRAFT_MARK} <span className="font-normal">(dieser Vermerk erscheint nicht im kopierten bzw. heruntergeladenen Text)</span>
      </p>
      {keys.length ? (
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 font-semibold">Platzhalter ausfüllen</legend>
          {keys.map((k) => (
            <div key={k} className="flex flex-col gap-1">
              <label htmlFor={`${id}-${k}`} className="font-medium">{LABEL[k] ?? k}</label>
              <input
                id={`${id}-${k}`}
                className="h-10 rounded-xl border border-border bg-surface px-3"
                value={values[k] ?? ""}
                disabled={k === ART14_OPTIONAL_PLACEHOLDER && none}
                onChange={(e) => set(k, e.target.value)}
                maxLength={300}
              />
              {k === ART14_OPTIONAL_PLACEHOLDER ? (
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="size-5 accent-[var(--primary)]" checked={none} onChange={(e) => setNone(e.target.checked)} />
                  keine weiteren Dienstleister
                </label>
              ) : null}
            </div>
          ))}
        </fieldset>
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          className="text-sm font-semibold text-primary disabled:text-muted"
          disabled={!ready}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied("ok");
            } catch {
              setCopied("fail");
            }
          }}
        >
          {copied === "ok" ? "Text kopiert" : "Text kopieren"}
        </button>
        <button type="button" className="text-sm font-semibold text-primary disabled:text-muted" disabled={!ready} onClick={download}>
          Als Textdatei herunterladen
        </button>
      </div>
      {!ready ? (
        <p role="status" className="rounded-xl bg-accent-soft px-3 py-2 text-accent-soft-text">
          Kopieren und Herunterladen erst, wenn alle Platzhalter ausgefüllt sind. Noch offen: {open.map((k) => LABEL[k] ?? k).join(", ")}.
        </p>
      ) : null}
      {copied === "fail" ? <p className="text-danger">Kopieren nicht möglich – bitte den Text unten markieren.</p> : null}
      <Preview text={text} />
    </div>
  );
}

/** Vorschau: der Widerspruchskasten (zwischen den ====-Zeilen) wird hervorgehoben dargestellt. */
function Preview({ text }: { text: string }) {
  const lines = text.split("\n");
  const boxEnd = /^=+$/.test(lines[0] ?? "") ? lines.indexOf(lines[0], 1) : -1;
  const box = boxEnd > 0 ? lines.slice(1, boxEnd).join("\n") : null;
  const rest = boxEnd > 0 ? lines.slice(boxEnd + 1).join("\n").replace(/^\n+/, "") : text;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-2 p-4">
      {box ? <p className="whitespace-pre-wrap rounded-xl border-2 border-primary bg-primary-soft px-4 py-3 font-semibold text-primary-soft-text">{box}</p> : null}
      <pre className="whitespace-pre-wrap font-sans text-[14px] leading-relaxed">{rest}</pre>
    </div>
  );
}
