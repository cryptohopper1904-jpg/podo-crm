import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { withOrg } from "@/db";
import { anamneses, appointments, consents, invoiceLines, invoices, media, patients, payments, recordAddenda, treatmentRecords } from "@/db/schema";
import { audit } from "@/lib/audit";
import { getAuth } from "@/lib/auth/session";
import { mapSequential } from "@/lib/seq";

/** Auskunft nach Art. 15 DSGVO / Kopie nach § 630g BGB – maschinenlesbar (Art. 20). Fotos als Liste mit Prüfsumme. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/patients/[id]/export">) {
  const { id } = await ctx.params;
  const auth = await getAuth();
  if (!auth || !auth.can("medical.read") || !auth.can("patients.read")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  const org = auth.organization.id;
  const data = await withOrg(org, async (tx) => {
    const w = <T extends { organizationId: unknown; patientId: unknown }>(t: T) => and(eq(t.organizationId as never, org), eq(t.patientId as never, id));
    const [p] = await tx.select().from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, id)));
    if (!p) return null;
    const inv = await tx.select().from(invoices).where(w(invoices));
    const recs = await tx.select().from(treatmentRecords).where(w(treatmentRecords));
    return {
      exportiertAm: new Date().toISOString(),
      praxis: auth.organization.name,
      person: p,
      einwilligungen: await tx.select().from(consents).where(w(consents)),
      anamnesen: await tx.select().from(anamneses).where(w(anamneses)),
      termine: await tx.select().from(appointments).where(w(appointments)),
      behandlungen: await mapSequential(
        recs, async (r) => ({ ...r, nachtraege: await tx.select().from(recordAddenda).where(and(eq(recordAddenda.organizationId, org), eq(recordAddenda.recordId, r.id))) })),
      medien: (await tx.select().from(media).where(w(media))).map((m) => ({ ...m, storageKey: undefined })),
      rechnungen: await mapSequential(
        inv, async (i) => ({
          ...i,
          positionen: await tx.select().from(invoiceLines).where(and(eq(invoiceLines.organizationId, org), eq(invoiceLines.invoiceId, i.id))),
          zahlungen: await tx.select().from(payments).where(and(eq(payments.organizationId, org), eq(payments.invoiceId, i.id))),
        })),
    };
  });
  if (!data) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  await audit({ organizationId: org, userId: auth.user.id, action: "patient.export", entity: "patient", entityId: id });
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="auskunft-${data.person.number}.json"`,
      "Cache-Control": "private, no-store",
    },
  });
}
