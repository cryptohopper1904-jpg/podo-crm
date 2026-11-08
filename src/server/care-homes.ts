import "server-only";
import { and, asc, count, eq, inArray, isNull, max, ne, or } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db";
import { billingContacts, patients, services, treatmentRecords } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import { mapSequential } from "@/lib/seq";
import { assertCan } from "./authz";
import { bookablePrescriptions } from "./prescriptions";

const opt = (max: number) => z.preprocess((v) => (typeof v === "string" ? v.trim() || null : v), z.string().max(max).nullable().optional());

export const careHomeInput = z.object({
  id: z.preprocess((v) => (v === "" ? undefined : v), z.string().uuid().optional()),
  name: z.string().trim().min(2, "Bitte einen Namen angeben.").max(200),
  street: opt(200),
  zip: opt(10),
  city: opt(100),
  email: z.preprocess((v) => (typeof v === "string" ? v.trim() || null : v), z.string().email("E-Mail ungültig").max(200).nullable().optional()),
  phone: opt(60),
});
export type CareHomeInput = z.infer<typeof careHomeInput>;

const homeWhere = (org: string, id: string) => and(eq(billingContacts.organizationId, org), eq(billingContacts.id, id), eq(billingContacts.kind, "care_home"));

export async function listCareHomes(auth: AuthContext) {
  assertCan(auth, "patients.read");
  const org = auth.organization.id;
  return withOrg(org, async (tx) => {
    const homes = await tx.select().from(billingContacts).where(and(eq(billingContacts.organizationId, org), eq(billingContacts.kind, "care_home"))).orderBy(asc(billingContacts.name));
    const counts = await tx
      .select({ careHomeId: patients.careHomeId, n: count() })
      .from(patients)
      .where(and(eq(patients.organizationId, org), isNull(patients.archivedAt)))
      .groupBy(patients.careHomeId);
    const byHome = new Map(counts.map((c) => [c.careHomeId, Number(c.n)]));
    return homes.map((h) => ({ ...h, patientCount: byHome.get(h.id) ?? 0 }));
  });
}

export async function getCareHome(auth: AuthContext, id: string) {
  assertCan(auth, "patients.read");
  const org = auth.organization.id;
  const res = await withOrg(org, async (tx) => {
    const [home] = await tx.select().from(billingContacts).where(homeWhere(org, id));
    if (!home) return null;
    const residents = await tx
      .select()
      .from(patients)
      .where(and(eq(patients.organizationId, org), eq(patients.careHomeId, id), isNull(patients.archivedAt)))
      .orderBy(asc(patients.lastName), asc(patients.firstName));
    const candidates = await tx
      .select({ id: patients.id, number: patients.number, firstName: patients.firstName, lastName: patients.lastName, birthDate: patients.birthDate })
      .from(patients)
      .where(and(eq(patients.organizationId, org), isNull(patients.archivedAt), or(isNull(patients.careHomeId), ne(patients.careHomeId, id))))
      .orderBy(asc(patients.lastName), asc(patients.firstName))
      .limit(1000);
    return { home, residents, candidates };
  });
  if (res) await audit({ organizationId: org, userId: auth.user.id, action: "care_home.read", entity: "billing_contact", entityId: id, meta: { residents: res.residents.length } });
  return res;
}

export async function saveCareHome(auth: AuthContext, d: CareHomeInput) {
  assertCan(auth, "patients.write");
  const org = auth.organization.id;
  const values = { name: d.name, street: d.street ?? null, zip: d.zip ?? null, city: d.city ?? null, email: d.email ?? null, phone: d.phone ?? null };
  const id = await withOrg(org, async (tx) => {
    if (d.id) {
      const [row] = await tx.update(billingContacts).set(values).where(homeWhere(org, d.id)).returning({ id: billingContacts.id });
      return row?.id ?? null;
    }
    const [row] = await tx.insert(billingContacts).values({ ...values, organizationId: org, kind: "care_home" }).returning({ id: billingContacts.id });
    return row.id;
  });
  if (id) await audit({ organizationId: org, userId: auth.user.id, action: d.id ? "care_home.update" : "care_home.create", entity: "billing_contact", entityId: id });
  return id;
}

/** Bewohner:in zuordnen; optional das Pflegeheim auch als Rechnungsempfänger setzen. */
export async function assignResident(auth: AuthContext, input: { careHomeId: string; patientId: string; billToHome: boolean }) {
  assertCan(auth, "patients.write");
  const org = auth.organization.id;
  const ok = await withOrg(org, async (tx) => {
    const [home] = await tx.select({ id: billingContacts.id }).from(billingContacts).where(homeWhere(org, input.careHomeId));
    if (!home) return false;
    const [p] = await tx
      .update(patients)
      .set({ careHomeId: home.id, ...(input.billToHome ? { billingContactId: home.id } : {}), updatedAt: new Date() })
      .where(and(eq(patients.organizationId, org), eq(patients.id, input.patientId)))
      .returning({ id: patients.id });
    return !!p;
  });
  if (ok) await audit({ organizationId: org, userId: auth.user.id, action: "care_home.assign", entity: "patient", entityId: input.patientId, meta: { careHomeId: input.careHomeId, billToHome: input.billToHome } });
  return ok;
}

export async function removeResident(auth: AuthContext, input: { careHomeId: string; patientId: string }) {
  assertCan(auth, "patients.write");
  const org = auth.organization.id;
  await withOrg(org, async (tx) => {
    const [p] = await tx.select({ billingContactId: patients.billingContactId }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, input.patientId), eq(patients.careHomeId, input.careHomeId)));
    if (!p) return;
    await tx
      .update(patients)
      .set({ careHomeId: null, ...(p.billingContactId === input.careHomeId ? { billingContactId: null } : {}), updatedAt: new Date() })
      .where(and(eq(patients.organizationId, org), eq(patients.id, input.patientId)));
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "care_home.remove", entity: "patient", entityId: input.patientId, meta: { careHomeId: input.careHomeId } });
}

/** Daten für den Besuchstag: Bewohner mit Risiken, letzter Behandlung und buchbaren Verordnungen. */
export async function visitDay(auth: AuthContext, id: string) {
  assertCan(auth, "patients.read");
  const org = auth.organization.id;
  const medical = auth.can("medical.read");
  const res = await withOrg(org, async (tx) => {
    const [home] = await tx.select().from(billingContacts).where(homeWhere(org, id));
    if (!home) return null;
    const residents = await tx
      .select({ id: patients.id, number: patients.number, firstName: patients.firstName, lastName: patients.lastName, title: patients.title, riskFlags: patients.riskFlags, notes: patients.notes })
      .from(patients)
      .where(and(eq(patients.organizationId, org), eq(patients.careHomeId, id), isNull(patients.archivedAt)))
      .orderBy(asc(patients.lastName), asc(patients.firstName));
    const ids = residents.map((r) => r.id);
    const last = medical && ids.length
      ? await tx
          .select({ patientId: treatmentRecords.patientId, last: max(treatmentRecords.treatedAt) })
          .from(treatmentRecords)
          .where(and(eq(treatmentRecords.organizationId, org), inArray(treatmentRecords.patientId, ids)))
          .groupBy(treatmentRecords.patientId)
      : [];
    const lastBy = new Map(last.map((l) => [l.patientId, l.last]));
    // Verordnungsdetails (Diagnosegruppe) nur für Behandler:innen
    const vos = medical ? await mapSequential(residents, async (r) => [r.id, await bookablePrescriptions(tx, org, r.id)] as const) : [];
    const vosBy = new Map(vos);
    const svc = await tx
      .select({ id: services.id, code: services.code, name: services.name })
      .from(services)
      .where(and(eq(services.organizationId, org), eq(services.active, true)))
      .orderBy(asc(services.code));
    return {
      home,
      services: svc,
      residents: residents.map((r) => ({ ...r, lastTreatedAt: lastBy.get(r.id) ?? null, prescriptions: vosBy.get(r.id) ?? [] })),
    };
  });
  if (res) await audit({ organizationId: org, userId: auth.user.id, action: "care_home.visit_day", entity: "billing_contact", entityId: id, meta: { residents: res.residents.length } });
  return res;
}

/** Prüft, dass der Patient im Pflegeheim wohnt (für die Listen-Doku). */
export async function isResident(auth: AuthContext, careHomeId: string, patientId: string) {
  assertCan(auth, "patients.read");
  const org = auth.organization.id;
  const [p] = await withOrg(org, (tx) =>
    tx.select({ id: patients.id }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, patientId), eq(patients.careHomeId, careHomeId))),
  );
  return !!p;
}
