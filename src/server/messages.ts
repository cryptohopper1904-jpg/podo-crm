import "server-only";
import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { withOrg } from "@/db";
import { patients } from "@/db/schema";

/** Ordnet eine Absenderadresse (E-Mail oder Telefonnummer) einer Person zu – nur bei eindeutigem Treffer. */
export async function matchPatientByAddress(organizationId: string, address: string | null | undefined): Promise<string | null> {
  if (!address) return null;
  const a = address.trim();
  return withOrg(organizationId, async (tx) => {
    const base = and(eq(patients.organizationId, organizationId), isNull(patients.archivedAt));
    let rows: { id: string }[] = [];
    if (a.includes("@")) {
      rows = await tx.select({ id: patients.id }).from(patients).where(and(base, ilike(patients.email, a))).limit(2);
    } else {
      const digits = a.replace(/\D/g, "").replace(/^(00)?49/, "0");
      if (digits.length < 7) return null;
      const tail = digits.slice(-9);
      rows = await tx
        .select({ id: patients.id })
        .from(patients)
        .where(
          and(
            base,
            or(
              sql`regexp_replace(coalesce(${patients.phoneMobile}, ''), '\\D', '', 'g') like ${"%" + tail}`,
              sql`regexp_replace(coalesce(${patients.phoneLandline}, ''), '\\D', '', 'g') like ${"%" + tail}`,
            ),
          ),
        )
        .limit(2);
    }
    return rows.length === 1 ? rows[0].id : null;
  });
}
