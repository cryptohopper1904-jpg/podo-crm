import { requireAuth } from "@/lib/auth/session";
import { ProductTabs } from "./product-tabs";

/** Produkte (Verkauf) und kleine Warenwirtschaft: Katalog, Bestand, Wareneingang, Nachbestellen, Lieferanten */
export default async function ProductsLayout({ children }: { children: React.ReactNode }) {
  await requireAuth("invoices.read");
  return (
    <div className="mx-auto max-w-6xl">
      <div className="no-print">
        <h1 className="mb-1 font-display text-3xl font-semibold">Produkte</h1>
        <p className="mb-4 text-sm text-muted">Salben, Cremes, Pflegeprodukte und Hilfsmittel – Verkauf über Rechnung/Quittung, Bestand und Nachbestellung.</p>
        <ProductTabs />
      </div>
      {children}
    </div>
  );
}
