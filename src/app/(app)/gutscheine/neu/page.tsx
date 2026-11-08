import { PageHeader } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso } from "@/lib/format";
import { VoucherForm } from "../voucher-form";

export const metadata = { title: "Neuer Gutschein" };

export default async function NewVoucherPage() {
  await requireAuth("invoices.write");
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Neuer Gutschein" subtitle="Der Code wird fortlaufend vergeben (G2026-0001 …)" />
      <VoucherForm today={berlinDateIso()} />
    </div>
  );
}
