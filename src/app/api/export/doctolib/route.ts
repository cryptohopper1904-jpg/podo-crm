import { NextResponse } from "next/server";
import { and, asc, eq, isNull } from "drizzle-orm";
import { withOrg } from "@/db";
import { patients } from "@/db/schema";
import { writeDoctolibPatientsCsv } from "@/integrations/doctolib/csv";
import type { Gender } from "@/integrations/types";
import { audit } from "@/lib/audit";
import { downloadAllowed, SUPPORT_DOWNLOAD_DENIED } from "@/lib/auth/access";
import { getAuth } from "@/lib/auth/session";
import { berlinDateIso } from "@/lib/format";

/** Patienten im Doctolib-Importformat (22 Spalten). */
export async function GET() {
  const auth = await getAuth();
  if (!auth || !auth.can("patients.read")) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  if (!downloadAllowed(auth, "patient_list_export")) return NextResponse.json({ error: SUPPORT_DOWNLOAD_DENIED }, { status: 403 });
  const org = auth.organization.id;
  const rows = await withOrg(org, (tx) =>
    tx.select().from(patients).where(and(eq(patients.organizationId, org), isNull(patients.archivedAt))).orderBy(asc(patients.number)),
  );
  const csv = writeDoctolibPatientsCsv(
    rows.map((p) => {
      const extra = (p.extra ?? {}) as Record<string, unknown>;
      const ext = (p.externalIds ?? {}) as Record<string, unknown>;
      const s = (k: string) => (typeof extra[k] === "string" ? (extra[k] as string) : null);
      const gender: Gender = p.salutation === "Frau" ? "female" : p.salutation === "Herr" ? "male" : p.salutation === "Divers" ? "diverse" : "unknown";
      return {
        externalId: typeof ext.doctolib === "string" ? ext.doctolib : null,
        importIdentifier: p.number,
        gender,
        salutation: p.salutation,
        lastName: p.lastName,
        maidenName: s("maidenName"),
        firstName: p.firstName,
        birthDate: p.birthDate,
        email: p.email,
        phoneMobile: p.phoneMobile,
        phoneLandline: p.phoneLandline,
        street: p.street,
        zip: p.zip,
        city: p.city,
        insuranceType: p.insuranceType,
        // Bewusst KEINE Risikoangaben/Notizen exportieren (Datenminimierung) – nur was Doctolib für Termine braucht
        crucialInfo: null,
        referrer: s("referrer"),
        occupation: s("occupation"),
        gpName: p.gpName,
        gpCity: s("gpCity"),
        notes: null,
        noNotifications: extra.noReminders === true,
      };
    }),
  );
  await audit({ organizationId: org, userId: auth.user.id, action: "patients.export.doctolib", meta: { count: rows.length } });
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="doctolib-patienten-${berlinDateIso()}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
