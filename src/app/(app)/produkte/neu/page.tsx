import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Card, CardTitle } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { listSuppliers } from "@/server/products";
import { saveProductAction } from "../actions";
import { ProductFields } from "../product-fields";

export const metadata = { title: "Neues Produkt" };

export default async function NewProductPage() {
  const auth = await requireAuth("settings.manage");
  const sup = await listSuppliers(auth);
  return (
    <Card>
      <CardTitle action={<Link href="/produkte" className="text-sm font-semibold text-muted">Abbrechen</Link>}>Neues Produkt</CardTitle>
      <ActionForm action={saveProductAction} submit="Produkt anlegen">
        <ProductFields suppliers={sup.map((s) => s.supplier)} />
      </ActionForm>
    </Card>
  );
}
