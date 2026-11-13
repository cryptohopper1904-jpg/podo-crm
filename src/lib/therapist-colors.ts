/**
 * Kalenderfarbe je Behandler:in (pro Praxis, gespeichert in memberships.color als Schlüssel der Palette).
 * Die Farbwerte stehen als CSS-Variablen in src/app/globals.css – je Farbe für Hell und Dunkel:
 *   --tc-<key>       kräftig (linker Rand, Farbpunkt; Kontrast ≥ 3:1 zur Fläche)
 *   --tc-<key>-soft  getönte Fläche des Terminblocks
 *   --tc-<key>-text  Text auf der getönten Fläche (Kontrast ≥ 4.5:1, WCAG AA)
 * Farbe ist nie alleiniger Informationsträger – Name der Behandler:in bleibt überall sichtbar.
 */
import type { CSSProperties } from "react";

export const THERAPIST_COLORS = ["teal", "blue", "violet", "rose", "orange", "amber", "green", "cyan", "fuchsia", "stone"] as const;
export type TherapistColor = (typeof THERAPIST_COLORS)[number];

export const THERAPIST_COLOR_LABELS: Record<TherapistColor, string> = {
  teal: "Petrol",
  blue: "Blau",
  violet: "Violett",
  rose: "Rosé",
  orange: "Orange",
  amber: "Bernstein",
  green: "Grün",
  cyan: "Türkis",
  fuchsia: "Pink",
  stone: "Grau",
};

export const isTherapistColor = (v: unknown): v is TherapistColor => typeof v === "string" && (THERAPIST_COLORS as readonly string[]).includes(v);

/**
 * Farben für das Team: gewählte Farben bleiben; alle anderen bekommen der Reihe nach (z. B. Eintrittsreihenfolge)
 * die nächste noch freie Palettenfarbe – bei mehr Personen als Farben wird die Palette wiederholt.
 * Ältere/ungültige Werte (z. B. Hex aus früheren Versionen) gelten als „automatisch“.
 */
export function assignTherapistColors<T extends { id: string; color: string | null }>(team: readonly T[]): Map<string, TherapistColor> {
  const out = new Map<string, TherapistColor>();
  const used = new Set<TherapistColor>();
  for (const t of team) {
    if (isTherapistColor(t.color)) {
      out.set(t.id, t.color);
      used.add(t.color);
    }
  }
  let n = 0;
  for (const t of team) {
    if (out.has(t.id)) continue;
    const free = THERAPIST_COLORS.find((c) => !used.has(c));
    const c = free ?? THERAPIST_COLORS[n++ % THERAPIST_COLORS.length];
    used.add(c);
    out.set(t.id, c);
  }
  return out;
}

/** Reihenfolge für die automatische Farbvergabe: Eintritt in die Praxis (stabil – neue Personen verschieben nichts). */
export function byJoined<T extends { id: string; joinedAt: Date }>(team: readonly T[]): T[] {
  return [...team].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime() || a.id.localeCompare(b.id));
}

/** Inline-Stile (nur CSS-Variablen – Hell/Dunkel schaltet globals.css um) */
export const colorVar = (c: TherapistColor, part: "" | "soft" | "text" = "") => `var(--tc-${c}${part ? `-${part}` : ""})`;
export const dotStyle = (c: TherapistColor): CSSProperties => ({ background: colorVar(c) });
