import { LayoutGrid, List, Rows3, Search } from "lucide-react";
import { Button, Input, Select, cx } from "@/components/ui";
import {
  CATALOG_VIEW_LABELS,
  CATALOG_VIEWS,
  SORT_LABELS,
  SORTS,
  STATUS_FILTER_LABELS,
  STATUS_FILTERS,
  type CatalogKey,
  type CatalogQuery,
  type CatalogView,
} from "@/lib/catalog";
import { setCatalogViewAction } from "./actions";

const ICONS = { kacheln: LayoutGrid, liste: List, kompakt: Rows3 } as const;

/** Filter als Suchparameter (Teilen/Zurück-Taste funktionieren), ohne leere Werte und ohne Standardwerte */
export function catalogQs(q: CatalogQuery, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (q.q) p.set("q", q.q);
  if (q.category) p.set("kat", q.category);
  if (q.status !== "aktiv") p.set("status", q.status);
  if (q.sort !== "name") p.set("sort", q.sort);
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return p.toString();
}

/**
 * Werkzeugleiste für Kataloge: Suche, Kategorie, Status (Aktiv/Archiviert/Alle), Sortierung und Darstellung.
 * Reines Server-Formular (GET) – funktioniert ohne JavaScript; die Darstellung wird je Person gespeichert.
 */
export function CatalogToolbar({
  catalog,
  basePath,
  query,
  categories,
  view,
  counts,
}: {
  catalog: CatalogKey;
  basePath: string;
  query: CatalogQuery;
  categories: readonly (readonly [string, string])[];
  view: CatalogView;
  counts: { shown: number; active: number; archived: number };
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-3">
      <form method="get" action={basePath} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(12rem,2fr)_1fr_1fr_1fr_auto] [&>*]:min-w-0">
        <label className="relative">
          <span className="sr-only">Suchen</span>
          <Search size={18} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" aria-hidden />
          <Input name="q" type="search" defaultValue={query.q} placeholder="Name, Kürzel, Artikelnummer …" className="pl-10" />
        </label>
        <Select name="kat" defaultValue={query.category} aria-label="Kategorie">
          <option value="">Alle Kategorien</option>
          {categories.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </Select>
        <Select name="status" defaultValue={query.status} aria-label="Status">
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {STATUS_FILTER_LABELS[s]} ({s === "aktiv" ? counts.active : s === "archiviert" ? counts.archived : counts.active + counts.archived})
            </option>
          ))}
        </Select>
        <Select name="sort" defaultValue={query.sort} aria-label="Sortierung">
          {SORTS.map((s) => (
            <option key={s} value={s}>Sortieren: {SORT_LABELS[s]}</option>
          ))}
        </Select>
        <Button type="submit" variant="secondary">Anzeigen</Button>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">{counts.shown} angezeigt</p>
        <form action={setCatalogViewAction} className="flex gap-1 rounded-xl border border-border p-1" role="group" aria-label="Darstellung">
          <input type="hidden" name="key" value={catalog} />
          <input type="hidden" name="qs" value={catalogQs(query)} />
          {CATALOG_VIEWS.map((v) => {
            const Icon = ICONS[v];
            return (
              <button
                key={v}
                name="view"
                value={v}
                aria-pressed={view === v}
                className={cx(
                  "inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold",
                  view === v ? "bg-primary text-on-primary" : "hover:bg-surface-2",
                )}
              >
                <Icon size={16} aria-hidden /> {CATALOG_VIEW_LABELS[v]}
              </button>
            );
          })}
        </form>
      </div>
    </div>
  );
}
