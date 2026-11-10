import { Card } from "@/components/ui";
import { requirePlatformAdmin } from "@/server/platform";
import { createLeadAction } from "../actions";
import { LeadForm } from "../lead-form";

export const metadata = { title: "Praxis anlegen · Vertrieb" };

export default async function NewLeadPage() {
  await requirePlatformAdmin();
  return (
    <Card className="max-w-3xl">
      <h2 className="mb-4 font-display text-xl font-semibold">Praxis anlegen</h2>
      <LeadForm action={createLeadAction} submit="Anlegen" />
    </Card>
  );
}
