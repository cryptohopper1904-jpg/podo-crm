/**
 * Kleine Warenwirtschaft für Verkaufsprodukte – reine Funktionen.
 * Bestand = Summe aller Lagerbewegungen (stock_movements, append-only). Jede Änderung ist eine neue Bewegung
 * mit Art, Menge (mit Vorzeichen), Person und Grund.
 */
import { suggestedOrderQty } from "./hygiene-rules";

export const MOVEMENT_KINDS = ["receipt", "sale", "storno", "inventory", "breakage", "own_use"] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];
export const MOVEMENT_LABELS: Record<MovementKind, string> = {
  receipt: "Wareneingang",
  sale: "Verkauf",
  storno: "Storno (zurück ins Lager)",
  inventory: "Inventur",
  breakage: "Bruch/Verderb",
  own_use: "Eigenverbrauch/Behandlung",
};

/** Gründe für eine manuelle Korrektur (Inventur light) */
export const CORRECTION_KINDS = ["inventory", "breakage", "own_use"] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

/** Obergrenzen (auch per DB-CHECK): Menge je Bewegung und Betrag des Bestands */
export const MAX_MOVEMENT_QTY = 1_000_000;
export const MAX_STOCK = 10_000_000;

/** Prüft eine Bewegung gegen die Obergrenzen; Fehlertext oder null */
export function stockLimitError(before: number, quantity: number): string | null {
  if (!Number.isInteger(quantity) || Math.abs(quantity) > MAX_MOVEMENT_QTY) return `Höchstens ${MAX_MOVEMENT_QTY.toLocaleString("de-DE")} je Buchung.`;
  if (Math.abs(before + quantity) > MAX_STOCK) return `Der Bestand darf ${MAX_STOCK.toLocaleString("de-DE")} nicht übersteigen.`;
  return null;
}

export function stockOf(movements: readonly { quantity: number }[]): number {
  return movements.reduce((s, m) => s + m.quantity, 0);
}

/**
 * Menge der Korrekturbuchung:
 * - Inventur: gezählter Ist-Bestand → Differenz zum Soll (kann + oder − sein; 0 = keine Buchung nötig)
 * - Bruch/Eigenverbrauch: entnommene Menge (positiv eingegeben) → negative Bewegung
 */
export function correctionQuantity(kind: CorrectionKind, current: number, input: number): { quantity: number } | { error: string } {
  if (!Number.isInteger(input)) return { error: "Bitte eine ganze Zahl angeben." };
  if (kind === "inventory") {
    if (input < 0) return { error: "Der gezählte Bestand kann nicht negativ sein." };
    const quantity = input - current;
    if (quantity === 0) return { error: "Der gezählte Bestand stimmt bereits – keine Buchung nötig." };
    const err = stockLimitError(current, quantity);
    return err ? { error: err } : { quantity };
  }
  if (input <= 0) return { error: "Bitte die entnommene Menge (größer 0) angeben." };
  const err = stockLimitError(current, -input);
  return err ? { error: err } : { quantity: -input };
}

export type StockItem = { trackStock: boolean; active: boolean; stock: number; minStock: number };

/** Nachbestellen: Bestandsführung an, aktiv, Mindestbestand gesetzt und erreicht/unterschritten */
export function isBelowMinimum(p: StockItem): boolean {
  return p.trackStock && p.active && p.minStock > 0 && p.stock <= p.minStock;
}

export type ReorderSource = StockItem & {
  name: string;
  unit: string;
  sku?: string | null;
  supplierName: string | null;
  supplierCustomerNumber?: string | null;
  supplierEmail?: string | null;
};

export type ReorderLine = { name: string; unit: string; sku: string | null; stock: number; minStock: number; orderQty: number };
export type ReorderGroup = { supplier: string; customerNumber: string | null; email: string | null; lines: ReorderLine[] };

/** Nachbestell-Liste: Artikel unter Mindestbestand, nach Lieferant gruppiert (ohne Lieferant zuletzt). */
export function reorderGroups(items: readonly ReorderSource[]): ReorderGroup[] {
  const NONE = "ohne Lieferant";
  const map = new Map<string, ReorderGroup>();
  for (const p of items) {
    if (!isBelowMinimum(p)) continue;
    const key = p.supplierName?.trim() || NONE;
    const g = map.get(key) ?? { supplier: key, customerNumber: p.supplierCustomerNumber ?? null, email: p.supplierEmail ?? null, lines: [] };
    g.lines.push({ name: p.name, unit: p.unit, sku: p.sku ?? null, stock: p.stock, minStock: p.minStock, orderQty: Math.max(1, suggestedOrderQty(p)) });
    map.set(key, g);
  }
  for (const g of map.values()) g.lines.sort((a, b) => a.name.localeCompare(b.name, "de"));
  return [...map.values()].sort((a, b) => (a.supplier === NONE ? 1 : b.supplier === NONE ? -1 : a.supplier.localeCompare(b.supplier, "de")));
}

/** Bestelltext zum Kopieren in eine E-Mail (keine automatische Bestellung) */
export function orderEmailText(g: ReorderGroup, practice: { name: string }): string {
  const lines = g.lines.map((l) => `- ${l.orderQty} ${l.unit} ${l.name}${l.sku ? ` (Art.-Nr. ${l.sku})` : ""}`);
  return [
    "Guten Tag,",
    "",
    `wir möchten folgende Artikel bestellen${g.customerNumber ? ` (Kundennummer ${g.customerNumber})` : ""}:`,
    "",
    ...lines,
    "",
    "Vielen Dank und freundliche Grüße",
    practice.name,
  ].join("\n");
}

/**
 * Hinweis „Bestand knapp“ (Heute-Seite): Produkte mit Bestandsführung auf/unter Mindestbestand, knappste zuerst
 * (Verhältnis Bestand/Mindestbestand), höchstens `max` Einträge, der Rest als Anzahl.
 */
export function lowStockSummary<T extends StockItem & { name: string }>(items: readonly T[], max = 3): { shown: T[]; more: number } {
  const low = items
    .filter(isBelowMinimum)
    .sort((a, b) => a.stock / a.minStock - b.stock / b.minStock || a.name.localeCompare(b.name, "de"));
  return { shown: low.slice(0, max), more: Math.max(0, low.length - max) };
}
