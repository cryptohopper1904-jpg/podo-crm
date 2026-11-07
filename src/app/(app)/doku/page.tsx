import Link from "next/link";
import { Search } from "lucide-react";
import { AppointmentRow } from "@/components/appointment-row";
import { Card, CardTitle, Empty, PageHeader } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso } from "@/lib/format";
import { listAppointments } from "@/server/appointments";

export const metadata = { title: "Behandlung" };

/** Einstieg am Behandlungsstuhl (iPad/iPhone): heutige Termine → direkt dokumentieren. */
export default async function DokuEntryPage() {
  const auth = await requireAuth("medical.write");
  const rows = (await listAppointments(auth, berlinDateIso(), 1)).filter((r) => r.a.status !== "cancelled");
  const open = rows.filter((r) => r.a.status !== "done");
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Behandlung dokumentieren" subtitle="Heute" />
      <Card className="mb-6">
        <CardTitle>Als Nächstes</CardTitle>
        {open.length === 0 ? <Empty title="Keine offenen Termine heute" /> : open.map((r) => <AppointmentRow key={r.a.id} row={r} canDoc canEdit={false} />)}
      </Card>
      <Link href="/kunden" className="flex h-14 items-center justify-center gap-2 rounded-xl border border-border bg-surface font-semibold">
        <Search size={18} aria-hidden /> Anderen Kunden suchen
      </Link>
    </div>
  );
}
