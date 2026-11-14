import "server-only";
import { UUID } from "./patient-route";
import { and, asc, desc, eq, ilike, isNull, max, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db";
import {
  appointments,
  billingContacts,
  consents,
  invoices,
  media,
  patients,
  treatmentRecords,
} from "@/db/schema";
import type { AuthContext } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { assertPatientCapacity, PatientLimitError } from "./patient-limit";
import { patientStatus } from "@/lib/patient-status";
import { deceasedInfo, isDeceased } from "@/lib/patient-deceased";
import { sequential } from "@/lib/seq";
import { queryTokens } from "@/lib/patient-search";

const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const optText = z.preprocess(emptyToNull, z.string().trim().max(500).nullable().optional());

export const patientInput = z.object({
  salutation: optText,
  title: optText,
  lastName: z.string().trim().min(1, "Nachname fehlt").max(120),
  firstName: optText,
  birthDate: z.preprocess(emptyToNull, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Geburtsdatum als TT.MM.JJJJ").nullable().optional()),
  street: optText,
  zip: optText,
  city: optText,
  phoneMobile: optText,
  phoneLandline: optText,
  email: z.preprocess(emptyToNull, z.string().trim().email("E-Mail ungültig").nullable().optional()),
  preferredChannel: z.enum(["email", "whatsapp", "sms", "phone", "letter", "none"]).default("none"),
  insuranceType: z.enum(["gkv", "pkv", "self", "beihilfe"]).default("self"),
  insurerName: optText,
  insuranceNumber: optText,
  gpName: optText,
  notes: optText,
  visitIntervalWeeks: z.preprocess(emptyToNull, z.coerce.number().int().min(1).max(52).nullable().optional()),
  homeVisit: z.preprocess((v) => v === "on" || v === true, z.boolean()).default(false),
  risk_diabetes: z.preprocess((v) => v === "on", z.boolean()).optional(),
  risk_diabetesType: optText,
  risk_anticoagulation: z.preprocess((v) => v === "on", z.boolean()).optional(),
  risk_pavk: z.preprocess((v) => v === "on", z.boolean()).optional(),
  risk_neuropathy: z.preprocess((v) => v === "on", z.boolean()).optional(),
  risk_mrsa: z.preprocess((v) => v === "on", z.boolean()).optional(),
  risk_allergies: optText,
});
export type PatientInput = z.infer<typeof patientInput>;

export function toPatientValues(d: PatientInput) {
  const { risk_diabetes, risk_diabetesType, risk_anticoagulation, risk_pavk, risk_neuropathy, risk_mrsa, risk_allergies, ...rest } = d;
  return {
    ...rest,
    riskFlags: {
      diabetes: !!risk_diabetes,
      diabetesType: risk_diabetesType ?? undefined,
      anticoagulation: !!risk_anticoagulation,
      pavk: !!risk_pavk,
      neuropathy: !!risk_neuropathy,
      mrsa: !!risk_mrsa,
      allergies: risk_allergies ?? undefined,
    },
  };
}

/** `%`/`_`/`\\` im Suchtext wörtlich nehmen */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Suchbedingung der Patientenliste und der Live-Suche (Kopfzeile): Jedes Suchwort muss in Nachname, Vorname,
 * E-Mail, Mobilnummer oder Ort vorkommen oder der Patientennummer entsprechen (TT.MM.JJJJ: Geburtsdatum).
 * „Erika Muster“ und „Muster, Erika“ finden dieselbe Person; ein einzelnes Wort verhält sich wie bisher.
 */
export function patientSearchCondition(q: string): SQL | undefined {
  const tokens = queryTokens(q);
  if (!tokens.length) return undefined;
  const parts = tokens.map((t) => {
    const like = `%${likeEscape(t)}%`;
    const conds: SQL[] = [
      ilike(patients.lastName, like),
      ilike(patients.firstName, like),
      ilike(patients.email, like),
      ilike(patients.phoneMobile, like),
      ilike(patients.city, like),
      sql`${patients.number}::text = ${t}`,
    ];
    const iso = isoDate(t);
    if (iso) conds.push(eq(patients.birthDate, iso));
    return or(...conds)!;
  });
  return parts.length === 1 ? parts[0] : and(...parts);
}

/** „TT.MM.JJJJ“ → „JJJJ-MM-TT“ (nur gültige Kalenderdaten) */
function isoDate(t: string): string | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export async function listPatients(auth: AuthContext, opts: { q?: string; status?: string; limit?: number } = {}) {
  const org = auth.organization.id;
  return withOrg(org, async (tx) => {
    const q = opts.q?.trim();
    const where = [eq(patients.organizationId, org), isNull(patients.archivedAt)];
    const match = q ? patientSearchCondition(q) : null;
    if (match) where.push(match);
    const lastVisit = tx
      .select({ patientId: appointments.patientId, last: max(appointments.startsAt).as("last") })
      .from(appointments)
      .where(and(eq(appointments.organizationId, org), eq(appointments.status, "done")))
      .groupBy(appointments.patientId)
      .as("lv");
    const open = tx
      .select({
        patientId: invoices.patientId,
        openCents: sql<number>`coalesce(sum(${invoices.totalCents} - ${invoices.paidCents}), 0)`.as("open_cents"),
      })
      .from(invoices)
      .where(and(eq(invoices.organizationId, org), sql`${invoices.status} in ('issued','partially_paid')`))
      .groupBy(invoices.patientId)
      .as("op");
    // Offene Beträge nur mit Rechnungs-Leserecht – ohne (z. B. Azubi) wird die Summe gar nicht erst abgefragt
    const withMoney = auth.can("invoices.read");
    const rows = withMoney
      ? await tx
          .select({ p: patients, last: lastVisit.last, openCents: open.openCents })
          .from(patients)
          .leftJoin(lastVisit, eq(lastVisit.patientId, patients.id))
          .leftJoin(open, eq(open.patientId, patients.id))
          .where(and(...where))
          .orderBy(asc(patients.lastName), asc(patients.firstName))
          .limit(opts.limit ?? 300)
      : await tx
          .select({ p: patients, last: lastVisit.last })
          .from(patients)
          .leftJoin(lastVisit, eq(lastVisit.patientId, patients.id))
          .where(and(...where))
          .orderBy(asc(patients.lastName), asc(patients.firstName))
          .limit(opts.limit ?? 300);
    await audit({ organizationId: org, userId: auth.user.id, action: "patients.list", meta: { q: q ? "[suche]" : null, n: rows.length } });
    return rows
      .map((r) => ({
        ...r.p,
        lastVisit: r.last ? new Date(r.last) : null,
        /** null = kein Rechnungs-Leserecht (nicht anzeigen) */
        openCents: withMoney ? Number(("openCents" in r ? r.openCents : 0) ?? 0) : null,
        status: patientStatus(r.last ? new Date(r.last) : null, r.p.visitIntervalWeeks),
        deceased: isDeceased(r.p.extra),
      }))
      // Filter „verstorben“ zeigt nur Verstorbene; die übrigen Status-Filter (z. B. „Überfällig“ für Rückholung) blenden sie aus
      .filter((r) => !opts.status || (opts.status === "deceased" ? r.deceased : !r.deceased && r.status === opts.status));
  });
}

export async function getPatient(auth: AuthContext, id: string) {
  // Kaputte Kennung: kein DB-Aufruf (sonst „invalid input syntax for type uuid“ als Fehler im Log)
  if (!UUID.test(id)) return null;
  const org = auth.organization.id;
  const result = await withOrg(org, async (tx) => {
    const [p] = await tx.select().from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, id)));
    if (!p) return null;
    const medical = auth.can("medical.read");
    const [appts, recs, photos, invs, cons, billing] = await sequential(
      () => tx.select().from(appointments).where(and(eq(appointments.organizationId, org), eq(appointments.patientId, id))).orderBy(desc(appointments.startsAt)).limit(50),
      () => medical
        ? tx.select().from(treatmentRecords).where(and(eq(treatmentRecords.organizationId, org), eq(treatmentRecords.patientId, id))).orderBy(desc(treatmentRecords.treatedAt)).limit(100)
        : Promise.resolve([]),
      () => medical
        ? tx.select().from(media).where(and(eq(media.organizationId, org), eq(media.patientId, id), isNull(media.deletedAt))).orderBy(desc(media.takenAt)).limit(200)
        : Promise.resolve([]),
      () => auth.can("invoices.read")
        ? tx.select().from(invoices).where(and(eq(invoices.organizationId, org), eq(invoices.patientId, id))).orderBy(desc(invoices.createdAt)).limit(50)
        : Promise.resolve([]),
      () => tx.select().from(consents).where(and(eq(consents.organizationId, org), eq(consents.patientId, id))).orderBy(desc(consents.recordedAt)),
      () => p.billingContactId
        ? tx.select().from(billingContacts).where(eq(billingContacts.id, p.billingContactId))
        : Promise.resolve([]),
    );
    const lastDone = appts.find((a) => a.status === "done");
    return {
      patient: p,
      appointments: appts,
      records: recs,
      media: photos,
      invoices: invs,
      consents: cons,
      billingContact: billing[0] ?? null,
      status: patientStatus(lastDone ? lastDone.startsAt : null, p.visitIntervalWeeks),
      deceased: deceasedInfo(p.extra),
      /** null = kein Rechnungs-Leserecht: Beträge nicht anzeigen (Rechnungen werden dann auch nicht geladen) */
      openCents: auth.can("invoices.read") ? invs.filter((i) => i.status === "issued" || i.status === "partially_paid").reduce((s, i) => s + i.totalCents - i.paidCents, 0) : null,
      revenueCents: auth.can("invoices.read") ? invs.filter((i) => i.status !== "cancelled" && i.status !== "draft").reduce((s, i) => s + i.paidCents, 0) : null,
    };
  });
  if (result) await audit({ organizationId: org, userId: auth.user.id, action: "patient.read", entity: "patient", entityId: id });
  return result;
}

/** Aktuell gültige Einwilligungen (letzter Eintrag je Typ). */
export function currentConsents(rows: { type: string; granted: boolean; recordedAt: Date }[]) {
  const map = new Map<string, { granted: boolean; recordedAt: Date }>();
  for (const r of [...rows].sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())) {
    if (!map.has(r.type)) map.set(r.type, { granted: r.granted, recordedAt: r.recordedAt });
  }
  return map;
}

export async function nextPatientNumber(org: string) {
  return withOrg(org, async (tx) => {
    const [r] = await tx.select({ n: max(patients.number) }).from(patients).where(eq(patients.organizationId, org));
    return (r?.n ?? 0) + 1;
  });
}

/** Mögliche Dubletten: gleicher Name+Geburtsdatum oder gleiche E-Mail/Mobilnummer. */
export async function findDuplicates(org: string, d: { lastName: string; firstName?: string | null; birthDate?: string | null; email?: string | null; phoneMobile?: string | null }, excludeId?: string) {
  return withOrg(org, async (tx) => {
    const conds = [];
    if (d.birthDate) conds.push(and(ilike(patients.lastName, d.lastName), eq(patients.birthDate, d.birthDate)));
    if (d.email) conds.push(ilike(patients.email, d.email));
    if (d.phoneMobile) conds.push(eq(patients.phoneMobile, d.phoneMobile));
    if (!conds.length) return [];
    const rows = await tx
      .select({ id: patients.id, number: patients.number, lastName: patients.lastName, firstName: patients.firstName })
      .from(patients)
      .where(and(eq(patients.organizationId, org), or(...conds)))
      .limit(5);
    return rows.filter((r) => r.id !== excludeId);
  });
}

/** Geburtsdatum aus Formularen: „TT.MM.JJJJ“ → JJJJ-MM-TT, sonst unverändert (Prüfung in patientInput) */
export function parseBirthDate(raw: FormDataEntryValue | null) {
  const s = String(raw ?? "").trim();
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return s;
}

/**
 * Neue Patient:in anlegen (Akte „Patienten → Neu“ und Terminformular): Patientennummer lückenlos unter der Sperre
 * vergeben, Tarif-Obergrenze prüfen. Audit macht der Aufrufer.
 */
export async function insertPatient(org: string, values: ReturnType<typeof toPatientValues>): Promise<{ ok: true; id: string; number: number } | { ok: false; error: string }> {
  try {
    const [row] = await withOrg(org, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"pnum:" + org}))`);
      await assertPatientCapacity(tx, org);
      const [m] = await tx.select({ n: max(patients.number) }).from(patients).where(eq(patients.organizationId, org));
      return tx.insert(patients).values({ ...values, organizationId: org, number: (m?.n ?? 0) + 1, source: "manual" }).returning({ id: patients.id, number: patients.number });
    });
    return { ok: true, id: row.id, number: row.number };
  } catch (e) {
    if (e instanceof PatientLimitError) return { ok: false, error: e.message };
    throw e;
  }
}
