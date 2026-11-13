"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/session";
import { parseMoney } from "@/lib/format";
import {
  bookReceipt,
  correctionInput,
  correctStock,
  ProductError,
  productInput,
  receiptInput,
  saveProduct,
  saveSupplier,
  setProductActive,
  setSupplierActive,
  supplierInput,
} from "@/server/products";

export type ProductState = { error?: string; ok?: string } | undefined;

const str = (form: FormData, k: string) => {
  const v = form.get(k);
  return typeof v === "string" ? v : "";
};
/** leeres Feld → null, sonst Cent (undefined = ungültig) */
const optMoney = (raw: string): number | null | undefined => (raw.trim() === "" ? null : (parseMoney(raw) ?? undefined));

function fail(e: unknown): ProductState {
  if (e instanceof ProductError) return { error: e.message };
  console.error(e);
  return { error: "Speichern fehlgeschlagen. Bitte erneut versuchen." };
}

function refresh() {
  revalidatePath("/produkte", "layout");
  revalidatePath("/rechnungen/neu");
}

export async function saveProductAction(_: ProductState, form: FormData): Promise<ProductState> {
  const auth = await requireAuth("settings.manage");
  const id = z.uuid().safeParse(form.get("id"));
  const price = optMoney(str(form, "price"));
  if (price === null || price === undefined) return { error: "Verkaufspreis ungültig." };
  const purchase = optMoney(str(form, "purchasePrice"));
  if (purchase === undefined) return { error: "Einkaufspreis ungültig." };
  const parsed = productInput.safeParse({
    name: str(form, "name"),
    code: str(form, "code"),
    sku: str(form, "sku"),
    ean: str(form, "ean"),
    category: str(form, "category"),
    priceCents: price,
    purchasePriceCents: purchase,
    vatRate: str(form, "vatRate") || 19,
    unit: str(form, "unit") || "Stück",
    trackStock: form.get("trackStock") === "on",
    minStock: str(form, "minStock") || 0,
    supplierId: str(form, "supplierId"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  let saved: { id: string };
  try {
    saved = await saveProduct(auth, id.success ? id.data : null, parsed.data);
  } catch (e) {
    return fail(e);
  }
  refresh();
  if (!id.success) redirect(`/produkte/${saved.id}`);
  return { ok: "Gespeichert." };
}

export async function setProductActiveAction(form: FormData) {
  const auth = await requireAuth("settings.manage");
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return;
  try {
    await setProductActive(auth, id.data, form.get("active") === "1");
  } catch (e) {
    if (!(e instanceof ProductError)) throw e;
  }
  refresh();
}

export async function saveSupplierAction(_: ProductState, form: FormData): Promise<ProductState> {
  const auth = await requireAuth("settings.manage");
  const id = z.uuid().safeParse(form.get("id"));
  const parsed = supplierInput.safeParse({
    name: str(form, "name"),
    customerNumber: str(form, "customerNumber"),
    email: str(form, "email"),
    website: str(form, "website"),
    phone: str(form, "phone"),
    note: str(form, "note"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  try {
    await saveSupplier(auth, id.success ? id.data : null, parsed.data);
  } catch (e) {
    return fail(e);
  }
  refresh();
  if (!id.success) redirect("/produkte/lieferanten");
  return { ok: "Gespeichert." };
}

export async function setSupplierActiveAction(form: FormData) {
  const auth = await requireAuth("settings.manage");
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return;
  try {
    await setSupplierActive(auth, id.data, form.get("active") === "1");
  } catch (e) {
    if (!(e instanceof ProductError)) throw e;
  }
  refresh();
}

export async function bookReceiptAction(_: ProductState, form: FormData): Promise<ProductState> {
  const auth = await requireAuth("invoices.write");
  const cost = optMoney(str(form, "unitCost"));
  if (cost === undefined) return { error: "Einkaufspreis ungültig." };
  const parsed = receiptInput.safeParse({
    productId: str(form, "productId"),
    quantity: str(form, "quantity"),
    occurredOn: str(form, "occurredOn"),
    unitCostCents: cost,
    deliveryNote: str(form, "deliveryNote"),
    supplierId: str(form, "supplierId"),
    note: str(form, "note"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  try {
    const r = await bookReceipt(auth, parsed.data);
    refresh();
    return { ok: `Wareneingang gebucht: ${parsed.data.quantity} × ${r.name} – Bestand jetzt ${r.stock}.` };
  } catch (e) {
    return fail(e);
  }
}

export async function correctStockAction(_: ProductState, form: FormData): Promise<ProductState> {
  const auth = await requireAuth("invoices.write");
  const parsed = correctionInput.safeParse({
    productId: str(form, "productId"),
    kind: str(form, "kind"),
    amount: str(form, "amount"),
    note: str(form, "note"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  try {
    const r = await correctStock(auth, parsed.data);
    refresh();
    return { ok: `Gebucht (${r.quantity > 0 ? "+" : ""}${r.quantity}). Bestand jetzt ${r.after}.` };
  } catch (e) {
    return fail(e);
  }
}
