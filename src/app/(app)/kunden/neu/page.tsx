import { PageHeader } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { isPrivateOnly } from "@/lib/features";
import { PatientForm } from "../patient-form";

export const metadata = { title: "Neuer Kunde" };

export default async function NewPatientPage() {
  const auth = await requireAuth("patients.write");
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Neuer Kunde" />
      <PatientForm privateOnly={isPrivateOnly(auth.organization)} />
    </div>
  );
}
