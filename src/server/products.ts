import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { products, services, stockMovements, suppliers, users } from "@/db/schema";
import type { AuthContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/assert";
import { audit } from "@/lib/audit";
import { PRODUCT_CATEGORIES } from "@/lib/catalog";
import { berlinDateIso } from "@/lib/format";
import { CORRECTION_KINDS, correctionQuantity, reorderGroups, stockLimitError, type ReorderSource } from "@/lib/stock";

/**
 * Produkte (Verkaufsware) und kleine Warenwirtschaft.
 * Rechte: Katalog/Lieferanten pflegen = settings.manage (wie Leistungen); ansehen = invoices.read;
 * Wareneingang/Inventur/Verkauf = invoices.write.
 * Bestand = Summe der Lagerbewegungen (append-only, DB-Trigger) – nie ein überschreibbares Feld.
 */
export class ProductError extends Error {}

const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const optText = (max: number) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());
const optUuid = z.preprocess(emptyToNull, z.uuid().nullable().optional());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum ungültig");

export const productInput = z.object({
  name: z.string().trim().min(2, "Name fehlt").max(200),
  code: z.preprocess(emptyToNull, z.string().trim().max(10).toUpperCase().nullable().optional()),
  sku: optText(60),
  ean: z.preprocess(emptyToNull, z.string().trim().regex(/^\d{8,14}$/, "EAN: 8 bis 14 Ziffern").nullable().optional()),
  category: z.enum(PRODUCT_CATEGORIES),
  priceCents: z.number().int().min(0, "Preis ungültig").max(10_000_000),
  purchasePriceCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  vatRate: z.coerce.number().refine((v) => v === 19 || v === 7, "USt: 19 % oder 7 %"),
  unit: z.string().trim().min(1).max(30).default("Stück"),
  trackStock: z.boolean().default(false),
  minStock: z.coerce.number().int("Mindestbestand: ganze Zahl").min(0).max(1_000_000).default(0),
  supplierId: optUuid,
});
export type ProductInput = z.infer<typeof productInput>;

export const supplierInput = z.object({
  name: z.string().trim().min(2, "Name fehlt").max(160),
  customerNumber: optText(60),
  email: z.preprocess(emptyToNull, z.email("E-Mail ungültig").max(200).nullable().optional()),
  website: z.preprocess(
    emptyToNull,
    z.string().trim().max(300).url("Website ungültig").refine((u) => /^https?:\/\//i.test(u), "Website muss mit http(s):// beginnen").nullable().optional(),
  ),
  phone: optText(60),
  note: optText(500),
});
export type SupplierInput = z.infer<typeof supplierInput>;

export const receiptInput = z.object({
  productId: z.uuid({ error: "Bitte ein Produkt wählen." }),
  quantity: z.coerce.number().int("Menge: ganze Zahl").min(1, "Menge muss größer 0 sein").max(100_000),
  occurredOn: isoDate,
  unitCostCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  deliveryNote: optText(60),
  supplierId: optUuid,
  note: optText(300),
});
export type ReceiptInput = z.infer<typeof receiptInput>;

export const correctionInput = z.object({
  productId: z.uuid(),
  kind: z.enum(CORRECTION_KINDS),
  /** Inventur: gezählter Ist-Bestand; Bruch/Eigenverbrauch: entnommene Menge */
  amount: z.coerce.number().int("Bitte eine ganze Zahl angeben.").min(0).max(1_000_000),
  note: optText(300),
});
export type CorrectionInput = z.infer<typeof correctionInput>;

/** Bestand je Produkt (Summe der Bewegungen) */
const stockSum = sql<number>`coalesce((select sum(m.quantity) from stock_movements m where m.product_id = ${products.id} and m.organization_id = ${products.organizationId}), 0)::bigint`.mapWith(Number);

export async function listProducts(auth: AuthContext) {
  assertCan(auth, "invoices.read");
  const org = auth.organization.id;
  return withOrg(org, (tx) =>
    tx
      .select({
        id: products.id,
        name: products.name,
        code: products.code,
        sku: products.sku,
        ean: products.ean,
        category: products.category,
        priceCents: products.priceCents,
        purchasePriceCents: products.purchasePriceCents,
        vatRate: products.vatRate,
        unit: products.unit,
        trackStock: products.trackStock,
        minStock: products.minStock,
        supplierId: products.supplierId,
        supplierName: suppliers.name,
        supplierCustomerNumber: suppliers.customerNumber,
        supplierEmail: suppliers.email,
        active: products.active,
        stock: stockSum,
      })
      .from(products)
      .leftJoin(suppliers, eq(suppliers.id, products.supplierId))
      .where(eq(products.organizationId, org))
      .orderBy(asc(products.name)),
  );
}
export type ProductRow = Awaited<ReturnType<typeof listProducts>>[number];

export async function getProduct(auth: AuthContext, id: string) {
  assertCan(auth, "invoices.read");
  if (!z.uuid().safeParse(id).success) return null;
  const org = auth.organization.id;
  return withOrg(org, async (tx) => {
    const [p] = await tx
      .select({ product: products, supplierName: suppliers.name, stock: stockSum })
      .from(products)
      .leftJoin(suppliers, eq(suppliers.id, products.supplierId))
      .where(and(eq(products.organizationId, org), eq(products.id, id)));
    if (!p) return null;
    const movements = await tx
      .select({
        id: stockMovements.id,
        kind: stockMovements.kind,
        quantity: stockMovements.quantity,
        occurredOn: stockMovements.occurredOn,
        unitCostCents: stockMovements.unitCostCents,
        deliveryNote: stockMovements.deliveryNote,
        invoiceId: stockMovements.invoiceId,
        note: stockMovements.note,
        createdAt: stockMovements.createdAt,
        userName: users.name,
        supplierName: suppliers.name,
      })
      .from(stockMovements)
      .leftJoin(users, eq(users.id, stockMovements.createdBy))
      .leftJoin(suppliers, eq(suppliers.id, stockMovements.supplierId))
      .where(and(eq(stockMovements.organizationId, org), eq(stockMovements.productId, id)))
      .orderBy(desc(stockMovements.occurredOn), desc(stockMovements.createdAt))
      .limit(300);
    return { ...p.product, supplierName: p.supplierName, stock: p.stock, movements };
  });
}

async function assertSupplier(tx: Tx, org: string, supplierId: string | null | undefined) {
  if (!supplierId) return;
  const [s] = await tx.select({ id: suppliers.id }).from(suppliers).where(and(eq(suppliers.organizationId, org), eq(suppliers.id, supplierId)));
  if (!s) throw new ProductError("Lieferant nicht gefunden.");
}

const AUDIT_FIELDS = ["name", "code", "category", "priceCents", "purchasePriceCents", "vatRate", "trackStock", "minStock", "supplierId"] as const;
type AuditField = (typeof AUDIT_FIELDS)[number];

export async function saveProduct(auth: AuthContext, id: string | null, input: ProductInput): Promise<{ id: string }> {
  assertCan(auth, "settings.manage");
  const org = auth.organization.id;
  const values = {
    name: input.name,
    code: input.code ?? null,
    sku: input.sku ?? null,
    ean: input.ean ?? null,
    category: input.category,
    priceCents: input.priceCents,
    purchasePriceCents: input.purchasePriceCents ?? null,
    vatRate: input.vatRate,
    unit: input.unit,
    trackStock: input.trackStock,
    minStock: input.minStock,
    supplierId: input.supplierId ?? null,
  };
  const result = await withOrg(org, async (tx) => {
    await assertSupplier(tx, org, values.supplierId);
    if (values.code) {
      const [dup] = await tx
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.organizationId, org), eq(products.code, values.code)));
      if (dup && dup.id !== id) throw new ProductError(`Das Kürzel ${values.code} hat schon ein anderes Produkt.`);
      // Schnelleingabe in der Rechnung: Leistungs-Kürzel haben Vorrang – gleiche Kürzel wären nicht erreichbar
      if (await codeTaken(tx, org, values.code, "service")) throw new ProductError(`Das Kürzel ${values.code} ist schon eine Leistung. Bitte ein anderes wählen.`);
    }
    if (id) {
      const [before] = await tx.select().from(products).where(and(eq(products.organizationId, org), eq(products.id, id))).for("no key update");
      if (!before) throw new ProductError("Produkt nicht gefunden.");
      if (before.trackStock && !values.trackStock) {
        const [m] = await tx.select({ id: stockMovements.id }).from(stockMovements).where(and(eq(stockMovements.organizationId, org), eq(stockMovements.productId, id))).limit(1);
        if (m) {
          throw new ProductError(
            "Die Bestandsführung lässt sich nicht mehr abschalten, weil es schon Lagerbewegungen gibt. Den Bestand bei Bedarf per Inventur auf 0 setzen oder das Produkt archivieren.",
          );
        }
      }
      await tx
        .update(products)
        .set({ ...values, updatedAt: new Date() })
        .where(and(eq(products.organizationId, org), eq(products.id, id)));
      return { id, created: false, before };
    }
    const [r] = await tx.insert(products).values({ ...values, organizationId: org }).returning({ id: products.id });
    return { id: r.id, created: true, before: null };
  });
  const snap = (p: Record<AuditField, unknown>) => Object.fromEntries(AUDIT_FIELDS.map((k) => [k, p[k]]));
  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: result.created ? "product.create" : "product.update",
    entity: "product",
    entityId: result.id,
    // Preis/USt/Name usw. vorher → nachher (nachvollziehbare Preisänderungen)
    meta: result.before ? { before: snap(result.before), after: snap(values) } : { after: snap(values) },
  });
  return { id: result.id };
}

/** Archivieren statt Löschen: archivierte Produkte erscheinen nicht mehr in der Rechnungsauswahl, alte Belege bleiben unverändert. */
export async function setProductActive(auth: AuthContext, id: string, active: boolean) {
  assertCan(auth, "settings.manage");
  const org = auth.organization.id;
  const r = await withOrg(org, (tx) =>
    tx.update(products).set({ active, updatedAt: new Date() }).where(and(eq(products.organizationId, org), eq(products.id, id))).returning({ id: products.id }),
  );
  if (!r.length) throw new ProductError("Produkt nicht gefunden.");
  await audit({ organizationId: org, userId: auth.user.id, action: active ? "product.unarchive" : "product.archive", entity: "product", entityId: id });
}

export async function listSuppliers(auth: AuthContext) {
  assertCan(auth, "invoices.read");
  const org = auth.organization.id;
  return withOrg(org, (tx) =>
    tx
      .select({
        supplier: suppliers,
        products: sql<number>`(select count(*) from products p where p.supplier_id = ${suppliers.id} and p.organization_id = ${suppliers.organizationId} and p.active)::int`,
      })
      .from(suppliers)
      .where(eq(suppliers.organizationId, org))
      .orderBy(desc(suppliers.active), asc(suppliers.name)),
  );
}

export async function saveSupplier(auth: AuthContext, id: string | null, input: SupplierInput): Promise<{ id: string }> {
  assertCan(auth, "settings.manage");
  const org = auth.organization.id;
  const values = {
    name: input.name,
    customerNumber: input.customerNumber ?? null,
    email: input.email ?? null,
    website: input.website ?? null,
    phone: input.phone ?? null,
    note: input.note ?? null,
  };
  const result = await withOrg(org, async (tx) => {
    if (id) {
      const r = await tx.update(suppliers).set(values).where(and(eq(suppliers.organizationId, org), eq(suppliers.id, id))).returning({ id: suppliers.id });
      if (!r.length) throw new ProductError("Lieferant nicht gefunden.");
      return { id, created: false };
    }
    const [r] = await tx.insert(suppliers).values({ ...values, organizationId: org }).returning({ id: suppliers.id });
    return { id: r.id, created: true };
  });
  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: result.created ? "supplier.create" : "supplier.update",
    entity: "supplier",
    entityId: result.id,
    meta: { name: values.name, customerNumber: values.customerNumber, email: values.email, website: values.website },
  });
  return result;
}

export async function setSupplierActive(auth: AuthContext, id: string, active: boolean) {
  assertCan(auth, "settings.manage");
  const org = auth.organization.id;
  const r = await withOrg(org, (tx) => tx.update(suppliers).set({ active }).where(and(eq(suppliers.organizationId, org), eq(suppliers.id, id))).returning({ id: suppliers.id }));
  if (!r.length) throw new ProductError("Lieferant nicht gefunden.");
  await audit({ organizationId: org, userId: auth.user.id, action: active ? "supplier.unarchive" : "supplier.archive", entity: "supplier", entityId: id });
}

/** Produkt sperren (Reihenfolge der Bestandsbuchungen je Produkt) und prüfen */
async function lockProduct(tx: Tx, org: string, productId: string) {
  const [p] = await tx.select().from(products).where(and(eq(products.organizationId, org), eq(products.id, productId))).for("no key update");
  if (!p) throw new ProductError("Produkt nicht gefunden.");
  return p;
}

/**
 * Kürzel-Schnelleingabe in der Rechnung: Leistungen und Produkte teilen sich die Kürzel (ohne Groß-/Kleinschreibung).
 * `where`: wo gesucht wird – beim Speichern eines Produkts in den Leistungen und umgekehrt.
 */
export async function codeTaken(tx: Tx, org: string, code: string, where: "service" | "product"): Promise<boolean> {
  const needle = code.trim().toUpperCase();
  if (!needle) return false;
  const t = where === "service" ? services : products;
  const [r] = await tx.select({ id: t.id }).from(t).where(and(eq(t.organizationId, org), sql`upper(${t.code}) = ${needle}`)).limit(1);
  return !!r;
}

/**
 * Mehrere Produkte sperren, sortiert nach id. „FOR NO KEY UPDATE“ statt „FOR UPDATE“: verträgt sich mit den
 * FOR-KEY-SHARE-Sperren, die das Einfügen von Rechnungspositionen (FK → products) setzt – sonst Deadlock bei
 * gleichzeitigen Verkäufen desselben Produkts –, serialisiert aber alle Bestandsbuchungen.
 * Rechnung/Storno rufen das schon VOR dem Einfügen der Positionen auf.
 */
export async function lockProducts(tx: Tx, org: string, ids: string[]) {
  if (!ids.length) return [];
  return tx
    .select({ id: products.id, trackStock: products.trackStock })
    .from(products)
    .where(and(eq(products.organizationId, org), inArray(products.id, ids)))
    .orderBy(asc(products.id))
    .for("no key update");
}

async function currentStock(tx: Tx, org: string, productId: string): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`coalesce(sum(${stockMovements.quantity}), 0)::bigint`.mapWith(Number) })
    .from(stockMovements)
    .where(and(eq(stockMovements.organizationId, org), eq(stockMovements.productId, productId)));
  return r?.n ?? 0;
}

/** Wareneingang buchen (erhöht den Bestand). Schaltet die Bestandsführung des Produkts ein, falls noch aus. */
export async function bookReceipt(auth: AuthContext, input: ReceiptInput) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  if (input.occurredOn > berlinDateIso()) throw new ProductError("Das Datum des Wareneingangs darf nicht in der Zukunft liegen.");
  const result = await withOrg(org, async (tx) => {
    const p = await lockProduct(tx, org, input.productId);
    if (!p.active) throw new ProductError(`„${p.name}“ ist archiviert. Für einen Wareneingang bitte zuerst wiederherstellen.`);
    await assertSupplier(tx, org, input.supplierId);
    const limit = stockLimitError(await currentStock(tx, org, p.id), input.quantity);
    if (limit) throw new ProductError(limit);
    if (!p.trackStock) await tx.update(products).set({ trackStock: true, updatedAt: new Date() }).where(and(eq(products.organizationId, org), eq(products.id, p.id)));
    const [m] = await tx
      .insert(stockMovements)
      .values({
        organizationId: org,
        productId: p.id,
        kind: "receipt",
        quantity: input.quantity,
        occurredOn: input.occurredOn,
        unitCostCents: input.unitCostCents ?? null,
        deliveryNote: input.deliveryNote ?? null,
        supplierId: input.supplierId ?? p.supplierId ?? null,
        note: input.note ?? null,
        createdBy: auth.user.id,
      })
      .returning({ id: stockMovements.id });
    return { id: m.id, stock: await currentStock(tx, org, p.id), name: p.name };
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "stock.receipt", entity: "product", entityId: input.productId, meta: { quantity: input.quantity, stock: result.stock, deliveryNote: input.deliveryNote ?? null } });
  return result;
}

/** Inventur light: Bestand korrigieren (Inventur = gezählter Bestand; Bruch/Eigenverbrauch = entnommene Menge) */
export async function correctStock(auth: AuthContext, input: CorrectionInput) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  const result = await withOrg(org, async (tx) => {
    const p = await lockProduct(tx, org, input.productId);
    const before = await currentStock(tx, org, p.id);
    const q = correctionQuantity(input.kind, before, input.amount);
    if ("error" in q) throw new ProductError(q.error);
    if (!p.trackStock) await tx.update(products).set({ trackStock: true, updatedAt: new Date() }).where(and(eq(products.organizationId, org), eq(products.id, p.id)));
    await tx.insert(stockMovements).values({
      organizationId: org,
      productId: p.id,
      kind: input.kind,
      quantity: q.quantity,
      occurredOn: berlinDateIso(),
      note: input.note ?? null,
      createdBy: auth.user.id,
    });
    return { before, after: before + q.quantity, quantity: q.quantity };
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "stock.correct", entity: "product", entityId: input.productId, meta: { kind: input.kind, ...result } });
  return result;
}

/** Nachbestellen: Produkte unter Mindestbestand, nach Lieferant gruppiert */
export async function productReorderGroups(auth: AuthContext) {
  const rows = await listProducts(auth);
  return reorderGroups(rows satisfies ReorderSource[]);
}

/** Letzte Wareneingänge (Übersicht Wareneingang) */
export async function recentReceipts(auth: AuthContext, limit = 30) {
  assertCan(auth, "invoices.read");
  const org = auth.organization.id;
  return withOrg(org, (tx) =>
    tx
      .select({
        id: stockMovements.id,
        productId: stockMovements.productId,
        productName: products.name,
        unit: products.unit,
        quantity: stockMovements.quantity,
        occurredOn: stockMovements.occurredOn,
        unitCostCents: stockMovements.unitCostCents,
        deliveryNote: stockMovements.deliveryNote,
        supplierName: suppliers.name,
        userName: users.name,
      })
      .from(stockMovements)
      .innerJoin(products, eq(products.id, stockMovements.productId))
      .leftJoin(suppliers, eq(suppliers.id, stockMovements.supplierId))
      .leftJoin(users, eq(users.id, stockMovements.createdBy))
      .where(and(eq(stockMovements.organizationId, org), eq(stockMovements.kind, "receipt")))
      .orderBy(desc(stockMovements.occurredOn), desc(stockMovements.createdAt))
      .limit(limit),
  );
}

// ───────────────────────── Verkauf über Rechnungen (aus src/server/invoices.ts) ─────────────────────────

/**
 * Verkauf beim Ausstellen: je Produkt mit Bestandsführung eine Abgangsbuchung (Menge der Positionen).
 * Der Bestand darf dabei negativ werden (die Ware ist ja physisch verkauft) – die Bestandsliste zeigt das an.
 */
export async function bookSaleStock(tx: Tx, org: string, userId: string, invoiceId: string, lines: { productId: string | null; quantity: number }[], date: string) {
  const qty = new Map<string, number>();
  for (const l of lines) if (l.productId) qty.set(l.productId, (qty.get(l.productId) ?? 0) + l.quantity);
  if (!qty.size) return;
  // dieselbe Sperre wie Wareneingang/Inventur (Reihenfolge nach id → keine Verklemmung bei mehreren Produkten)
  const locked = await lockProducts(tx, org, [...qty.keys()]);
  const rows = locked.filter((p) => p.trackStock && (qty.get(p.id) ?? 0) > 0);
  if (!rows.length) return;
  for (const p of rows) {
    const err = stockLimitError(await currentStock(tx, org, p.id), -(qty.get(p.id) ?? 0));
    if (err) throw new ProductError(err);
  }
  await tx.insert(stockMovements).values(
    rows.map((p) => ({ organizationId: org, productId: p.id, kind: "sale", quantity: -(qty.get(p.id) ?? 0), occurredOn: date, invoiceId, createdBy: userId })),
  );
}

/**
 * Storno: verkaufte Ware wieder zugehen lassen (Bezug: Stornorechnung).
 * - Positionen „in der Behandlung angewendet“ werden NIE zurückgebucht (Ware ist verbraucht).
 * - `lineIds`: nur diese Produktpositionen zurückbuchen (Auswahl im Storno-Dialog); undefined = alle übrigen.
 * - Höchstens die beim Verkauf tatsächlich abgebuchte Menge (Produkte ohne Bestandsführung beim Verkauf: nichts).
 */
export async function restoreSaleStock(
  tx: Tx,
  org: string,
  userId: string,
  originalInvoiceId: string,
  creditNoteId: string,
  date: string,
  lines: { id: string; productId: string | null; quantity: string | number; inTreatment: boolean }[],
  lineIds?: readonly string[],
) {
  const want = new Map<string, number>();
  for (const l of lines) {
    if (!l.productId || l.inTreatment) continue;
    if (lineIds && !lineIds.includes(l.id)) continue;
    want.set(l.productId, (want.get(l.productId) ?? 0) + Number(l.quantity));
  }
  if (!want.size) return 0;
  const sold = await tx
    .select({ productId: stockMovements.productId, n: sql<number>`sum(${stockMovements.quantity})::bigint`.mapWith(Number) })
    .from(stockMovements)
    .where(and(eq(stockMovements.organizationId, org), eq(stockMovements.invoiceId, originalInvoiceId), eq(stockMovements.kind, "sale"), inArray(stockMovements.productId, [...want.keys()])))
    .groupBy(stockMovements.productId);
  const rows = sold.map((s) => ({ productId: s.productId, qty: Math.min(-s.n, want.get(s.productId) ?? 0) })).filter((r) => r.qty > 0);
  if (!rows.length) return 0;
  await lockProducts(tx, org, rows.map((r) => r.productId));
  for (const r of rows) {
    const err = stockLimitError(await currentStock(tx, org, r.productId), r.qty);
    if (err) throw new ProductError(err);
  }
  await tx.insert(stockMovements).values(
    rows.map((r) => ({ organizationId: org, productId: r.productId, kind: "storno", quantity: r.qty, occurredOn: date, invoiceId: creditNoteId, note: "Storno – Ware zurück ins Lager", createdBy: userId })),
  );
  return rows.length;
}

/** Produkte für das Rechnungsformular (nur aktive) */
export async function productsForInvoice(tx: Tx, org: string) {
  return tx
    .select({ id: products.id, code: products.code, name: products.name, priceCents: products.priceCents, vatRate: products.vatRate, unit: products.unit })
    .from(products)
    .where(and(eq(products.organizationId, org), eq(products.active, true)))
    .orderBy(asc(products.category), asc(products.name));
}
