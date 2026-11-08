"use client";

/**
 * Fußbefund: 2D-Schema (Standard, sofort da) oder 3D-Modell (three.js, erst bei Bedarf geladen).
 * - three.js steckt ausschließlich in ./foot3d-viewer.tsx und wird per next/dynamic (ssr:false) nachgeladen.
 * - Ohne WebGL: Hinweis und 2D bleibt aktiv.
 * - Tastatur/Screenreader: Stellen über Auswahlliste hinzufügen, Markierungsliste mit Entfernen.
 */
import dynamic from "next/dynamic";
import { useMemo, useState, type ReactNode } from "react";
import { Box, Loader2, Plus, RotateCcw, Square } from "lucide-react";
import type { FootPoint } from "@/db/schema";
import { FootMap, FootPointList } from "@/components/foot-map";
import { Button, Select, cx } from "@/components/ui";
import { FOOT_POINTS } from "@/lib/foot-points";
import { REGION_ANCHORS, pointFrom3d, type Side } from "@/lib/foot3d";
import type { ViewPreset } from "./foot3d-viewer";

const Foot3dViewer = dynamic(() => import("./foot3d-viewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-80 items-center justify-center gap-2 rounded-xl bg-surface-2 text-sm text-muted sm:h-96">
      <Loader2 size={18} className="animate-spin" aria-hidden /> 3D-Modell wird geladen …
    </div>
  ),
});

/** WebGL vorhanden? (einmalig, nur im Browser) */
export function hasWebGL(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const c = document.createElement("canvas");
    const ok = !!(c.getContext("webgl2") ?? c.getContext("webgl"));
    return ok;
  } catch {
    return false;
  }
}

const VIEWS: [ViewPreset, string][] = [
  ["top", "Oben"],
  ["sole", "Sohle"],
  ["medial", "Innen"],
  ["lateral", "Außen"],
];

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-xl border border-border bg-surface p-1">
      {options.map(([k, l]) => (
        <button
          key={k}
          type="button"
          aria-pressed={value === k}
          onClick={() => onChange(k)}
          className={cx("h-9 rounded-lg px-3 text-sm font-semibold", value === k ? "bg-primary text-on-primary" : "hover:bg-surface-2")}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/** 3D-Ansicht mit Seitenwahl, Ansichten und (optional) Bearbeitung. */
export function Foot3D({
  value,
  onChange,
  readOnly = false,
  onUnavailable,
}: {
  value: FootPoint[];
  onChange?: (v: FootPoint[]) => void;
  readOnly?: boolean;
  onUnavailable?: (reason: string) => void;
}) {
  const [side, setSide] = useState<Side>(() => (value.some((p) => p.side === "right") || !value.length ? "right" : "left"));
  const [selected, setSelected] = useState<number | null>(null);
  const [view, setView] = useState<{ preset: ViewPreset; n: number }>({ preset: "default", n: 0 });
  const [addKey, setAddKey] = useState(FOOT_POINTS[0].id);
  const [announce, setAnnounce] = useState("");
  const editable = !readOnly && !!onChange;

  const add = (p: FootPoint) => {
    if (!onChange) return;
    onChange([...value, p]);
    setSelected(value.length);
    setAnnounce(`Markierung ${value.length + 1} gesetzt: ${p.side === "left" ? "links" : "rechts"}, ${p.label ?? p.point}.`);
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented label="Fußseite" value={side} onChange={(s) => { setSide(s); setSelected(null); }} options={[["right", "Rechts"], ["left", "Links"]]} />
        <div role="group" aria-label="Ansicht" className="inline-flex flex-wrap gap-1">
          {VIEWS.map(([k, l]) => (
            <button key={k} type="button" onClick={() => setView((v) => ({ preset: k, n: v.n + 1 }))} className="h-9 rounded-lg border border-border bg-surface px-3 text-sm font-semibold hover:bg-surface-2">
              {l}
            </button>
          ))}
          <button type="button" onClick={() => setView((v) => ({ preset: "default", n: v.n + 1 }))} className="inline-flex h-9 items-center gap-1 rounded-lg border border-border bg-surface px-3 text-sm font-semibold hover:bg-surface-2">
            <RotateCcw size={14} aria-hidden /> Ansicht zurücksetzen
          </button>
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-surface-2">
        <Foot3dViewer
          side={side}
          points={value}
          readOnly={!editable}
          selected={selected}
          onSelect={setSelected}
          onPick={(pos) => add(pointFrom3d(side, pos))}
          onUnavailable={onUnavailable}
          view={view}
        />
      </div>
      <p className="mt-2 text-xs text-muted">
        {editable ? "Ziehen zum Drehen, zwei Finger oder Mausrad zum Zoomen, kurz tippen setzt eine Markierung. " : "Ziehen zum Drehen, zwei Finger oder Mausrad zum Zoomen. "}
        Tastatur: Modell fokussieren, Pfeiltasten drehen, +/− zoomen, 0 setzt zurück.
      </p>
      <p role="status" aria-live="polite" className="sr-only">{announce}</p>
      {editable ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-sm font-semibold">
            <span className="mb-1 block">Stelle ohne Tippen hinzufügen ({side === "left" ? "links" : "rechts"})</span>
            <Select value={addKey} onChange={(e) => setAddKey(e.target.value)} className="w-64">
              {FOOT_POINTS.map((p) => <option key={p.id} value={p.id}>{p.id} · {p.label}</option>)}
            </Select>
          </label>
          <Button type="button" variant="secondary" onClick={() => add(pointFrom3d(side, REGION_ANCHORS[addKey]))}>
            <Plus size={16} aria-hidden /> Hinzufügen
          </Button>
        </div>
      ) : null}
      {value.length ? (
        <FootPointList
          value={value}
          onChange={editable ? (v) => { onChange?.(v); setSelected(null); } : undefined}
          highlight={selected}
          onSelect={(i) => { setSelected(i); setSide(value[i].side); }}
        />
      ) : editable ? (
        <p className="mt-3 text-sm text-muted">Noch keine Markierung – auf das Modell tippen oder eine Stelle aus der Liste wählen.</p>
      ) : null}
    </div>
  );
}

type Mode = "2d" | "3d";

/** Editor im Doku-Formular: Umschalter 2D / 3D. */
export function FootFindings({ value, onChange }: { value: FootPoint[]; onChange: (v: FootPoint[]) => void }) {
  const [mode, setMode] = useState<Mode>("2d");
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const choose = (m: Mode) => {
    if (m === "3d" && !hasWebGL()) {
      setUnavailable("3D ist auf diesem Gerät nicht verfügbar (kein WebGL) – das 2D-Schema funktioniert wie gewohnt.");
      return;
    }
    setUnavailable(null);
    setMode(m);
  };
  return (
    <div>
      <ModeToggle mode={mode} onChange={choose} />
      {unavailable ? <p role="status" className="mb-3 rounded-xl bg-warn-soft p-3 text-sm font-medium text-warn-soft-text">{unavailable}</p> : null}
      {mode === "3d" ? (
        <Foot3D value={value} onChange={onChange} onUnavailable={(r) => { setUnavailable(`${r} Das 2D-Schema ist aktiv.`); setMode("2d"); }} />
      ) : (
        <FootMap value={value} onChange={onChange} />
      )}
    </div>
  );
}

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="mb-4 flex justify-end">
      <div role="group" aria-label="Darstellung" className="inline-flex rounded-xl border border-border bg-surface p-1">
        {(
          [
            ["2d", "2D", <Square key="i" size={14} aria-hidden />],
            ["3d", "3D", <Box key="i" size={14} aria-hidden />],
          ] as [Mode, string, ReactNode][]
        ).map(([k, l, icon]) => (
          <button
            key={k}
            type="button"
            aria-pressed={mode === k}
            onClick={() => onChange(k)}
            className={cx("inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold", mode === k ? "bg-primary text-on-primary" : "hover:bg-surface-2")}
          >
            {icon} {l}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Nur-Lesen-Ansicht in der Akte: 2D-Schema mit Markierungen, 3D auf Wunsch. */
export function FootRecordView({ points }: { points: FootPoint[] }) {
  const [mode, setMode] = useState<Mode>("2d");
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const has3d = useMemo(() => points.some((p) => p.pos3d), [points]);
  return (
    <div>
      <ModeToggle
        mode={mode}
        onChange={(m) => {
          if (m === "3d" && !hasWebGL()) return setUnavailable("3D ist auf diesem Gerät nicht verfügbar (kein WebGL).");
          setUnavailable(null);
          setMode(m);
        }}
      />
      {unavailable ? <p role="status" className="mb-3 rounded-xl bg-warn-soft p-3 text-sm font-medium text-warn-soft-text">{unavailable}</p> : null}
      {mode === "3d" ? (
        <Foot3D value={points} readOnly onUnavailable={(r) => { setUnavailable(r); setMode("2d"); }} />
      ) : (
        <>
          <FootMap value={points} readOnly />
          <FootPointList value={points} />
          {has3d ? <p className="mt-2 text-xs text-muted">Mit „3D“ werden die exakten Positionen am Modell angezeigt.</p> : null}
        </>
      )}
    </div>
  );
}
