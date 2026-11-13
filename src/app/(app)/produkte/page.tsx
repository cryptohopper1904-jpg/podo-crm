import Link from "next/link";
import { AlertTriangle, Archive, ArchiveRestore, Plus } from "lucide-react";
import { Badge, Empty, LinkButton, Table } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { filterCatalog, groupByCategory, parseCatalogQuery, PRODUCT_CATEGORIES, PRODUCT_CATEGORY_LABELS, type CatalogView } from "@/lib/catalog";
import { money } from "@/lib/format";
import { isBelowMinimum } from "@/lib/stock";
import { currentCatalogView } from "@/server/catalog-prefs";
import { listProducts, type ProductRow } from "@/server/products";
import { CatalogToolbar } from "../_catalog/catalog-toolbar";
import { setProductActiveAction } from "./actions";

export const metadata = { title: "Produkte" };

function StockBadge({ p }: { p: ProductRow }) {
  if (!p.trackStock) return <Badge>ohne Bestand</Badge>;
  return isBelowMinimum(p) ? (
    <Badge tone="warn"><AlertTriangle size={12} className="mr-1" aria-hidden />Bestand {p.stock} {p.unit} – nachbestellen</Badge>
  ) : (
    <Badge tone={p.stock < 0 ? "accent" : "neutral"}>Bestand {p.stock} {p.unit}</Badge>
  );
}

function Actions({ p, manage, compact = false }: { p: ProductRow; manage: boolean; compact?: boolean }) {
  return (
    <div className="flex items-center gap-1">
      <Link href={`/produkte/${p.id}`} className="inline-flex h-9 items-center rounded-lg px-2.5 text-sm font-semibold text-primary hover:bg-surface-2">
        {compact ? "Details" : manage ? "Details & bearbeiten" : "Details"}
      </Link>
      {manage ? (
        <form action={setProductActiveAction}>
          <input type="hidden" name="id" value={p.id} />
          <input type="hidden" name="active" value={p.active ? "0" : "1"} />
          <button className="inline-flex h-9 items-center gap-1 rounded-lg px-2.5 text-sm font-semibold text-muted hover:bg-surface-2" aria-label={p.active ? `${p.name} archivieren` : `${p.name} wiederherstellen`}>
            {p.active ? <Archive size={15} aria-hidden /> : <ArchiveRestore size={15} aria-hidden />} {compact ? null : p.active ? "Archivieren" : "Wiederherstellen"}
          </button>
        </form>
      ) : null}
    </div>
  );
}

function ProductList({ rows, view, manage }: { rows: ProductRow[]; view: CatalogView; manage: boolean }) {
  if (view === "liste") {
    return (
      <Table>
        <thead><tr><th>Produkt</th><th>Kategorie</th><th className="text-right">Preis</th><th>USt</th><th>Bestand</th><th>Lieferant</th><th></th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className={p.active ? undefined : "opacity-60"}>
              <td>
                <p className="font-semibold">{p.name}</p>
                <p className="text-xs text-muted">{[p.code, p.sku && `Art.-Nr. ${p.sku}`, p.ean && `EAN ${p.ean}`].filter(Boolean).join(" · ")}</p>
              </td>
              <td className="text-sm text-muted">{PRODUCT_CATEGORY_LABELS[p.category] ?? p.category}</td>
              <td className="text-right tabular-nums">{money(p.priceCents)}</td>
              <td>{p.vatRate} %</td>
              <td><StockBadge p={p} />{!p.active ? <Badge className="ml-1">archiviert</Badge> : null}</td>
              <td className="text-sm">{p.supplierName ?? "–"}</td>
              <td><Actions p={p} manage={manage} compact /></td>
            </tr>
          ))}
        </tbody>
      </Table>
    );
  }
  if (view === "kompakt") {
    return (
      <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
        {rows.map((p) => (
          <li key={p.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-sm ${p.active ? "" : "opacity-60"}`}>
            <span className="w-14 shrink-0 font-mono font-semibold">{p.code ?? "–"}</span>
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            <span className="tabular-nums">{money(p.priceCents)}</span>
            <span className="w-24 text-right text-muted tabular-nums">{p.trackStock ? `${p.stock} ${p.unit}` : "–"}</span>
            {isBelowMinimum(p) ? <Badge tone="warn">nachbestellen</Badge> : null}
            {!p.active ? <Badge>archiviert</Badge> : null}
            <Actions p={p} manage={manage} compact />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {groupByCategory(rows, PRODUCT_CATEGORIES).map(([cat, list]) => (
        <section key={cat}>
          <h2 className="mb-2 font-display text-lg font-semibold">{PRODUCT_CATEGORY_LABELS[cat] ?? cat} <span className="text-sm font-normal text-muted">({list.length})</span></h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((p) => (
              <article key={p.id} className={`flex flex-col gap-2 rounded-[var(--radius-card)] border border-border bg-surface p-4 ${p.active ? "" : "opacity-60"}`}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="min-w-0 font-semibold leading-snug">{p.name}</h3>
                  {p.code ? <span className="shrink-0 rounded-lg bg-surface-2 px-2 py-0.5 font-mono text-sm font-semibold">{p.code}</span> : null}
                </div>
                <p className="flex items-baseline gap-3">
                  <span className="font-display text-2xl font-bold tabular-nums">{money(p.priceCents)}</span>
                  <span className="text-sm text-muted">{p.vatRate} % USt</span>
                </p>
                <div className="flex flex-wrap gap-1">
                  <StockBadge p={p} />
                  {!p.active ? <Badge>archiviert</Badge> : null}
                </div>
                {p.sku || p.supplierName ? <p className="text-xs text-muted">{[p.sku && `Art.-Nr. ${p.sku}`, p.supplierName].filter(Boolean).join(" · ")}</p> : null}
                <div className="mt-auto -ml-2.5 pt-1"><Actions p={p} manage={manage} /></div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default async function ProductsPage(props: PageProps<"/produkte">) {
  const auth = await requireAuth("invoices.read");
  const sp = await props.searchParams;
  const query = parseCatalogQuery(sp);
  const view = await currentCatalogView("products");
  const all = await listProducts(auth);
  const rows = filterCatalog(all, query);
  const manage = auth.can("settings.manage");
  const low = all.filter(isBelowMinimum).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {manage ? <LinkButton href="/produkte/neu"><Plus size={18} aria-hidden /> Neues Produkt</LinkButton> : null}
        {low ? (
          <Link href="/produkte/nachbestellen" className="inline-flex items-center gap-1.5 text-sm font-semibold text-warn-soft-text">
            <AlertTriangle size={16} aria-hidden /> {low} Produkt(e) unter Mindestbestand – Nachbestell-Liste
          </Link>
        ) : null}
      </div>
      <p className="rounded-xl bg-info-soft p-3 text-sm text-info-soft-text">
        Verkauf über <Link href="/rechnungen/neu" className="font-semibold underline">Neue Rechnung/Quittung</Link>: Produkte zum Mitnehmen mit ihrem regulären Satz (meist 19 %). 0 % nur, wenn das Produkt während der Behandlung angewendet/verbraucht wird (Nebenleistung der Heilbehandlung auf demselben Beleg).
      </p>
      <CatalogToolbar
        catalog="products"
        basePath="/produkte"
        query={query}
        categories={PRODUCT_CATEGORIES.map((c) => [c, PRODUCT_CATEGORY_LABELS[c]] as const)}
        view={view}
        counts={{ shown: rows.length, active: all.filter((p) => p.active).length, archived: all.filter((p) => !p.active).length }}
      />
      {rows.length === 0 ? (
        <Empty title={all.length ? "Kein Produkt passt zum Filter" : "Noch keine Produkte angelegt"}>
          {all.length ? <Link href="/produkte" className="font-semibold text-primary">Filter zurücksetzen</Link> : manage ? "Zum Beispiel Hornhautsalbe, Fußcreme oder Zehenschutz." : null}
        </Empty>
      ) : (
        <ProductList rows={rows} view={view} manage={manage} />
      )}
    </div>
  );
}
