/**
 * Cookie für die eingeklappte Navigation. Bewusst NICHT in der Client-Komponente (src/components/sidebar.tsx):
 * Server-Komponenten bekommen aus „use client“-Dateien nur Platzhalter, keine Werte.
 */
export const NAV_COOKIE = "podo_nav";

/** Schlüssel der Hauptnavigation (Liste mit Beschriftung und Icon: src/components/app-nav.tsx) */
export type NavKey =
  | "heute"
  | "kalender"
  | "touren"
  | "kunden"
  | "doku"
  | "posteingang"
  | "rechnungen"
  | "gutscheine"
  | "bewertungen"
  | "news"
  | "auswertung"
  | "einstellungen"
  | "verordnungen"
  | "pflegeheime"
  | "hygiene"
  | "team"
  | "kasse"
  | "produkte"
  | "telefon"
  | "plattform";

/** Alle Navigationsschlüssel in der Reihenfolge der Navigation (Beschriftung/Icon: src/components/app-nav.tsx) */
export const NAV_KEYS = [
  "heute",
  "kalender",
  "touren",
  "kunden",
  "doku",
  "posteingang",
  "verordnungen",
  "pflegeheime",
  "rechnungen",
  "kasse",
  "produkte",
  "gutscheine",
  "telefon",
  "bewertungen",
  "news",
  "hygiene",
  "team",
  "auswertung",
  "einstellungen",
  "plattform",
] as const satisfies readonly NavKey[];

/**
 * Kandidaten für die feste untere Leiste (Handy/Tablet hochkant), nach Vorrang. Es stehen höchstens
 * BOTTOM_BAR_SLOTS davon in der Leiste – der fünfte Platz gehört immer „Mehr“ (alle übrigen Bereiche).
 */
export const BOTTOM_BAR_CANDIDATES: readonly NavKey[] = ["heute", "kalender", "kunden", "doku", "posteingang"];
export const BOTTOM_BAR_SLOTS = 4;

/**
 * Aufteilung für Handy/Tablet hochkant (untere Leiste + „Mehr“-Blatt).
 * - `bar`: bis zu 4 Kernbereiche, die die Ansicht zeigt (Reihenfolge der Navigation)
 * - `inView`: übrige Bereiche der Ansicht (stehen am Desktop links in der Navigation)
 * - `hidden`: von der Ansicht ausgeblendete Bereiche (am Desktop unter „Mehr“)
 * Zusammen ergeben die drei Listen genau `allowed` – nichts geht verloren, nichts kommt hinzu. „Einstellungen“
 * steht nie in den Listen: das „Mehr“-Blatt zeigt es immer gesondert (persönliche Einstellungen gibt es für alle Rollen).
 */
export function bottomNavSplit<K extends NavKey>(allowed: readonly K[], visible: readonly K[]): { bar: K[]; inView: K[]; hidden: K[] } {
  const bar = allowed.filter((k) => visible.includes(k) && BOTTOM_BAR_CANDIDATES.includes(k)).slice(0, BOTTOM_BAR_SLOTS);
  const rest = allowed.filter((k) => !bar.includes(k) && k !== "einstellungen");
  return { bar, inView: rest.filter((k) => visible.includes(k)), hidden: rest.filter((k) => !visible.includes(k)) };
}

/** Gruppen der linken Navigation (Desktop). „Einstellungen“ steht unten fest (Sidebar), nicht in einer Gruppe. */
export const NAV_GROUPS: readonly { id: string; label: string; keys: readonly NavKey[] }[] = [
  { id: "praxis", label: "Praxis", keys: ["heute", "kalender", "touren", "kunden", "doku", "posteingang", "verordnungen", "pflegeheime"] },
  { id: "abrechnung", label: "Abrechnung", keys: ["rechnungen", "kasse", "produkte", "gutscheine", "auswertung"] },
  { id: "verwaltung", label: "Verwaltung", keys: ["telefon", "bewertungen", "news", "hygiene", "team", "plattform"] },
];

/** Teilt Schlüssel in die Gruppen (leere Gruppen fallen weg, Reihenfolge der Navigation bleibt; ohne „Einstellungen“). */
export function groupNav<K extends NavKey>(keys: readonly K[]): { id: string; label: string; keys: K[] }[] {
  return NAV_GROUPS.map((g) => ({ id: g.id, label: g.label, keys: keys.filter((k) => g.keys.includes(k)) })).filter((g) => g.keys.length);
}
