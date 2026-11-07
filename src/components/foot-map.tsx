"use client";

import type { FootPoint } from "@/db/schema";

/**
 * 2D-Fußschema (Aufsicht plantar/dorsal kombiniert) mit antippbaren Punkten.
 * Kürzel angelehnt an die Podologie-Ausbildung: D1–D5 = Zehen, N = Nagel, MT = Metatarsalköpfchen.
 * (3D-Modell ist für Phase 4 geplant.)
 */
export const FOOT_POINTS: { id: string; label: string; x: number; y: number }[] = [
  { id: "N1", label: "Nagel D1", x: 38, y: 22 },
  { id: "N2", label: "Nagel D2", x: 60, y: 20 },
  { id: "N3", label: "Nagel D3", x: 76, y: 26 },
  { id: "N4", label: "Nagel D4", x: 89, y: 35 },
  { id: "N5", label: "Nagel D5", x: 99, y: 47 },
  { id: "Z1", label: "Zehe D1 (Kuppe/Gelenk)", x: 40, y: 45 },
  { id: "Z25", label: "Zehen D2–D5 (Zwischenräume)", x: 78, y: 52 },
  { id: "MT1", label: "Großzehenballen (MT1)", x: 40, y: 82 },
  { id: "MT25", label: "Vorfußballen (MT2–4)", x: 68, y: 86 },
  { id: "MT5", label: "Kleinzehenballen (MT5)", x: 94, y: 90 },
  { id: "MF", label: "Mittelfuß", x: 66, y: 130 },
  { id: "LR", label: "Fußaußenrand", x: 92, y: 140 },
  { id: "FE", label: "Ferse", x: 62, y: 184 },
  { id: "FR", label: "Fersenrand (Rhagaden)", x: 62, y: 206 },
];

function Foot({ side, selected, onToggle }: { side: "left" | "right"; selected: Set<string>; onToggle: (side: "left" | "right", id: string) => void }) {
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
      <div className="flex max-w-xs flex-wrap justify-center gap-1.5">
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
      </div>
    </figure>
  );
}

export function FootMap({ value, onChange }: { value: FootPoint[]; onChange: (v: FootPoint[]) => void }) {
  const selected = new Set(value.map((v) => `${v.side}:${v.point}`));
  const toggle = (side: "left" | "right", id: string) => {
    const key = `${side}:${id}`;
    if (selected.has(key)) onChange(value.filter((v) => `${v.side}:${v.point}` !== key));
    else onChange([...value, { side, point: id, label: FOOT_POINTS.find((p) => p.id === id)?.label }]);
  };
  return (
    <div>
      <div className="flex flex-wrap justify-center gap-8">
        <Foot side="right" selected={selected} onToggle={toggle} />
        <Foot side="left" selected={selected} onToggle={toggle} />
      </div>
      {value.length ? (
        <ul className="mt-4 flex flex-col gap-2">
          {value.map((v, i) => (
            <li key={`${v.side}:${v.point}`} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-48 font-semibold">{v.side === "left" ? "Links" : "Rechts"} · {v.label}</span>
              <input
                aria-label={`Befund ${v.label}`}
                className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3"
                placeholder="Befund an dieser Stelle, z. B. Clavus, Unguis incarnatus"
                value={v.note ?? ""}
                onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-center text-sm text-muted">Stellen antippen, um Befunde am Fuß zu markieren.</p>
      )}
    </div>
  );
}
