/**
 * Kataloge (Leistungen, Produkte): Darstellung, Filter, Sortierung, Kategorien – reine Funktionen.
 * Die gewählte Darstellung merkt sich jede Person in users.prefs.catalog (keine Migration nötig).
 */

export const CATALOG_VIEWS = ["kacheln", "liste", "kompakt"] as const;
export type CatalogView = (typeof CATALOG_VIEWS)[number];
export const CATALOG_VIEW_LABELS: Record<CatalogView, string> = { kacheln: "Kacheln", liste: "Liste", kompakt: "Kompakt" };
export type CatalogKey = "services" | "products";

export function isCatalogView(v: unknown): v is CatalogView {
  return typeof v === "string" && (CATALOG_VIEWS as readonly string[]).includes(v);
}

/** Gemerkte Darstellung (Standard: Kacheln) */
export function catalogViewOf(prefs: { catalog?: Partial<Record<CatalogKey, unknown>> } | null | undefined, key: CatalogKey): CatalogView {
  const v = prefs?.catalog?.[key];
  return isCatalogView(v) ? v : "kacheln";
}

export const STATUS_FILTERS = ["aktiv", "archiviert", "alle"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];
export const STATUS_FILTER_LABELS: Record<StatusFilter, string> = { aktiv: "Aktiv", archiviert: "Archiviert", alle: "Alle" };

/** „haeufig“ = häufig gebucht (nur Leistungen; Häufigkeit aus src/server/service-catalog.ts) */
export const SORTS = ["haeufig", "name", "kuerzel", "preis"] as const;
export type CatalogSort = (typeof SORTS)[number];
export const SORT_LABELS: Record<CatalogSort, string> = { haeufig: "Häufig gebucht", name: "Name", kuerzel: "Kürzel", preis: "Preis" };
export const PRODUCT_SORTS = ["name", "kuerzel", "preis"] as const satisfies readonly CatalogSort[];

/**
 * Fachliche Arten der Leistungen (services.category = service_categories.kind). Die Kategorien selbst legt jede
 * Praxis an (Tabelle service_categories); an der Art hängen Buchbarkeit, Website, Wegegeld usw.
 * „product“ = Altbestand (Verkauf als Leistung angelegt).
 */
export const SERVICE_CATEGORIES = ["treatment", "brace", "cosmetic", "travel", "product"] as const;
export type ServiceKind = (typeof SERVICE_CATEGORIES)[number];
/** Erklärung der Art beim Anlegen einer Kategorie */
export const SERVICE_KIND_HINTS: Record<ServiceKind, string> = {
  treatment: "Behandlung – online buchbar, auf der Website",
  brace: "Nagelkorrektur – online buchbar, auf der Website",
  cosmetic: "Kosmetik & Wellness – online buchbar, auf der Website",
  travel: "Hausbesuch & Wegegeld – wird in Touren als Wegegeld vorgeschlagen",
  product: "Verkauf (alt) – nicht buchbar",
};
export const SERVICE_CATEGORY_LABELS: Record<string, string> = {
  treatment: "Behandlung",
  brace: "Nagelkorrektur",
  cosmetic: "Kosmetik & Wellness",
  travel: "Hausbesuch & Wegegeld",
  product: "Verkauf (alt)",
};

export const PRODUCT_CATEGORIES = ["salbe", "creme", "pflege", "hilfsmittel", "sonstiges"] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];
export const PRODUCT_CATEGORY_LABELS: Record<string, string> = {
  salbe: "Salben",
  creme: "Cremes",
  pflege: "Pflegeprodukte",
  hilfsmittel: "Hilfsmittel",
  sonstiges: "Sonstiges",
};

export type CatalogQuery = { q: string; category: string; status: StatusFilter; sort: CatalogSort };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * Suchparameter (?q=&kat=&status=&sort=) lesen; Unbekanntes → Standard. `sorts`: erlaubte Sortierungen (Produkte ohne
 * „häufig gebucht“), `defaultSort`: Standard (Leistungen: häufig gebucht).
 */
export function parseCatalogQuery(
  sp: Record<string, string | string[] | undefined>,
  opts: { sorts?: readonly CatalogSort[]; defaultSort?: CatalogSort } = {},
): CatalogQuery {
  const status = one(sp.status);
  const sort = one(sp.sort);
  const sorts = opts.sorts ?? PRODUCT_SORTS;
  return {
    q: one(sp.q).trim().slice(0, 100),
    category: one(sp.kat).slice(0, 40),
    status: (STATUS_FILTERS as readonly string[]).includes(status) ? (status as StatusFilter) : "aktiv",
    sort: (sorts as readonly string[]).includes(sort) ? (sort as CatalogSort) : (opts.defaultSort ?? "name"),
  };
}

type Item = { name: string; code?: string | null; sku?: string | null; ean?: string | null; category: string; priceCents: number; active: boolean };

const norm = (s: string) => s.toLocaleLowerCase("de").normalize("NFKD").replace(/[̀-ͯ]/g, "");

/**
 * Filtern (Status, Kategorie, Suche in Name/Kürzel/Artikelnummer/EAN) und sortieren. „häufig gebucht“ braucht die
 * Häufigkeit je id (`usage`); ohne sie wird nach Name sortiert.
 */
export function filterCatalog<T extends Item & { id?: string }>(items: readonly T[], q: CatalogQuery, usage?: ReadonlyMap<string, number>): T[] {
  const needle = norm(q.q);
  const out = items.filter((i) => {
    if (q.status === "aktiv" && !i.active) return false;
    if (q.status === "archiviert" && i.active) return false;
    if (q.category && i.category !== q.category) return false;
    if (!needle) return true;
    return [i.name, i.code, i.sku, i.ean].some((f) => !!f && norm(f).includes(needle));
  });
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, "de");
  const used = (i: T) => (i.id ? (usage?.get(i.id) ?? 0) : 0);
  out.sort((a, b) =>
    q.sort === "preis"
      ? a.priceCents - b.priceCents || byName(a, b)
      : q.sort === "kuerzel"
        ? (a.code ?? "￿").localeCompare(b.code ?? "￿", "de") || byName(a, b)
        : q.sort === "haeufig" && usage
          ? used(b) - used(a) || byName(a, b)
          : byName(a, b),
  );
  return out;
}

/** Nach Kategorie gruppieren (Reihenfolge der Kategorienliste, Unbekanntes am Ende) */
export function groupByCategory<T extends { category: string }>(items: readonly T[], order: readonly string[]): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const i of items) map.set(i.category, [...(map.get(i.category) ?? []), i]);
  const rank = (c: string) => (order.includes(c) ? order.indexOf(c) : order.length);
  return [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
}
