import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { fullName } from "@/lib/format";
import { deletionStatus } from "@/server/patient-deletion";
import { getPatient } from "@/server/patients";
import { DeletePatientCard } from "./delete-card";
import { PatientForm } from "../../patient-form";

export const metadata = { title: "Kunde bearbeiten" };

export default async function EditPatientPage(props: PageProps<"/kunden/[id]/bearbeiten">) {
  const { id } = await props.params;
  const auth = await requireAuth("patients.write");
  const data = await getPatient(auth, id);
  if (!data) notFound();
  const status = auth.role === "owner" && !auth.support ? await deletionStatus(auth, id) : null;
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={fullName(data.patient)} subtitle={`Kunde #${data.patient.number} bearbeiten`} />
      <PatientForm patient={data.patient} />
      {status ? <DeletePatientCard id={id} number={data.patient.number} status={status} /> : null}
    </div>
  );
}
