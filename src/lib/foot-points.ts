/**
 * Gemeinsames Vokabular der Fuß-Markierungen (2D-Schema, 3D-Modell, Berichte).
 * Kürzel angelehnt an die Podologie-Ausbildung: D1–D5 = Zehen, N = Nagel, MT = Metatarsalköpfchen.
 * x/y = Lage im 2D-Schema (viewBox 0 0 130 230, rechter Fuß, Aufsicht).
 *
 * Neue Schlüssel nur ANHÄNGEN – gespeicherte Doku verweist dauerhaft auf diese Kürzel.
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
  { id: "DR", label: "Fußrücken", x: 52, y: 112 },
];

export type FootPointId = string;

export const footPointLabel = (id: string): string | undefined => FOOT_POINTS.find((p) => p.id === id)?.label;
