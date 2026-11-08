"use client";

import { Trash2 } from "lucide-react";
import type { FootPoint } from "@/db/schema";
import { FOOT_POINTS } from "@/lib/foot-points";

/**
 * 2D-Fußschema (Aufsicht plantar/dorsal kombiniert) mit antippbaren Punkten – schneller Standard.
 * Vokabular: src/lib/foot-points.ts (gemeinsam mit dem 3D-Modell in src/components/foot3d).
 */
function Foot({ side, selected, onToggle }: { side: "left" | "right"; selected: Set<string>; onToggle?: (side: "left" | "right", id: string) => void }) {
  const mirror = side === "left";
  return (
    <figure className="flex flex-col items-center gap-2">
      <svg viewBox="0 0 130 230" className="h-72 w-auto" role="group" aria-label={`Fuß ${side === "left" ? "links" : "rechts"}`}>
        <g transform={mirror ? "translate(130,0) scale(-1,1)" : undefined}>
          <path
            d="M30 40 C 25 15, 50 8, 52 28 C 55 10, 70 10, 70 26 C 74 14, 86 18, 85 32 C 90 24, 100 30, 96 42 C 104 38, 110 48, 104 58 C 112 90, 106 130, 100 160 C 96 190, 90 222, 62 222 C 34 222, 30 196, 30 170 C 30 140, 22 110, 24 80 C 25 62, 26 50, 30 40 Z"
            fill="var(--surface-2)"
            stroke="var(--border-strong)"
            strokeWidth="2"
          />
          {FOOT_POINTS.map((p) => {
            const key = `${side}:${p.id}`;
            const on = selected.has(key);
            return (
              <g key={p.id}>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={on ? 9 : 7}
                  fill={on ? "var(--accent)" : "var(--surface)"}
                  stroke={on ? "var(--accent-hover)" : "var(--primary)"}
                  strokeWidth="2"
                />
              </g>
            );
          })}
        </g>
      </svg>
      <figcaption className="text-sm font-semibold">{side === "left" ? "Links" : "Rechts"}</figcaption>
      {/* Zugängliche Bedienung: echte Buttons statt SVG-Klickflächen */}
      {onToggle ? <div className="flex max-w-xs flex-wrap justify-center gap-1.5">
        {FOOT_POINTS.map((p) => {
          const on = selected.has(`${side}:${p.id}`);
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={on}
              title={p.label}
              onClick={() => onToggle(side, p.id)}
              className={`h-9 min-w-11 rounded-lg px-2 text-xs font-bold ${on ? "bg-accent text-on-accent" : "border border-border bg-surface"}`}
            >
              {p.id}
            </button>
          );
        })}
      </div> : null}
    </figure>
  );
}

export function FootMap({ value, onChange, readOnly = false }: { value: FootPoint[]; onChange?: (v: FootPoint[]) => void; readOnly?: boolean }) {
  const selected = new Set(value.map((v) => `${v.side}:${v.point}`));
  const toggle = (side: "left" | "right", id: string) => {
    if (!onChange) return;
    const key = `${side}:${id}`;
    if (selected.has(key)) onChange(value.filter((v) => `${v.side}:${v.point}` !== key));
    else onChange([...value, { side, point: id, label: FOOT_POINTS.find((p) => p.id === id)?.label }]);
  };
  return (
    <div>
      <div className="flex flex-wrap justify-center gap-8">
        <Foot side="right" selected={selected} onToggle={readOnly ? undefined : toggle} />
        <Foot side="left" selected={selected} onToggle={readOnly ? undefined : toggle} />
      </div>
      {readOnly ? null : value.length ? (
        <FootPointList value={value} onChange={onChange} />
      ) : (
        <p className="mt-3 text-center text-sm text-muted">Stellen antippen, um Befunde am Fuß zu markieren.</p>
      )}
    </div>
  );
}

/**
 * Liste der Markierungen mit Befundfeld und Entfernen-Knopf – auch die tastaturbedienbare
 * Alternative zum 3D-Modell. `highlight`/`onSelect`: Markierung im 3D-Modell hervorheben.
 */
export function FootPointList({
  value,
  onChange,
  highlight,
  onSelect,
}: {
  value: FootPoint[];
  onChange?: (v: FootPoint[]) => void;
  highlight?: number | null;
  onSelect?: (i: number) => void;
}) {
  return (
    <ol className="mt-4 flex flex-col gap-2">
      {value.map((v, i) => {
        const name = `${v.side === "left" ? "Links" : "Rechts"} · ${v.label ?? v.point}`;
        return (
          <li key={i} className={`flex flex-wrap items-center gap-2 rounded-xl text-sm ${highlight === i ? "bg-accent-soft p-1.5" : ""}`}>
            <button
              type="button"
              onClick={() => onSelect?.(i)}
              disabled={!onSelect}
              className="flex w-52 items-center gap-2 text-left font-semibold disabled:cursor-default"
              aria-label={onSelect ? `${name} im Modell zeigen` : undefined}
            >
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs text-on-primary">{i + 1}</span>
              <span>{name}{v.pos3d ? <span className="ml-1 text-xs font-normal text-muted">(3D)</span> : null}</span>
            </button>
            {onChange ? (
              <>
                <input
                  aria-label={`Befund ${name}`}
                  className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3"
                  placeholder="Befund an dieser Stelle, z. B. Clavus, Unguis incarnatus"
                  maxLength={500}
                  value={v.note ?? ""}
                  onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))}
                />
                <button
                  type="button"
                  aria-label={`Markierung ${i + 1} (${name}) entfernen`}
                  className="inline-flex size-10 items-center justify-center rounded-lg border border-border bg-surface hover:bg-surface-2"
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                >
                  <Trash2 size={16} aria-hidden />
                </button>
              </>
            ) : v.note ? (
              <span className="text-muted">{v.note}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
