import "server-only";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db";
import { invoices, organizations, patients, payments, vouchers } from "@/db/schema";
import type { AuthContext } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { berlinDateIso } from "@/lib/format";
import { defaultVoucherValidUntil, voucherBalance } from "@/lib/invoice-math";
import { nextNumber } from "@/lib/numbering";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum ungültig");

export const voucherInput = z
  .object({
    amountCents: z.number().int().min(100, "Mindestens 1,00 €").max(100_000, "Höchstens 1.000 €"),
    issuedAt: isoDate,
    validUntil: isoDate,
    purpose: z.enum(["single", "multi"]).default("multi"),
    note: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(300).nullable().optional()),
  })
  .refine((v) => v.validUntil >= v.issuedAt, { message: "„Gültig bis“ liegt vor dem Ausstellungsdatum.", path: ["validUntil"] });
export type VoucherInput = z.infer<typeof voucherInput>;

export { defaultVoucherValidUntil };

export async function createVoucher(auth: AuthContext, input: VoucherInput) {
  const org = auth.organization.id;
  const row = await withOrg(org, async (tx) => {
    const code = await nextNumber(tx, org, "voucher", Number(input.issuedAt.slice(0, 4)));
    const [v] = await tx
      .insert(vouchers)
      .values({
        organizationId: org,
        code,
        issuedAt: input.issuedAt,
        validUntil: input.validUntil,
        amountCents: input.amountCents,
        purpose: input.purpose,
        note: input.note ?? null,
      })
      .returning();
    return v;
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "voucher.create", entity: "voucher", entityId: row.id, meta: { code: row.code, amountCents: row.amountCents } });
  return row;
}

export async function listVouchers(auth: AuthContext, opts: { q?: string; filter?: "active" | "all" } = {}) {
  const org = auth.organization.id;
  const today = berlinDateIso();
  return withOrg(org, async (tx) => {
    const used = tx
      .select({
        voucherId: payments.voucherId,
        usedCents: sql<number>`coalesce(sum(${payments.amountCents}), 0)`.as("used_cents"),
        n: sql<number>`count(*)`.as("n"),
      })
      .from(payments)
      .where(and(eq(payments.organizationId, org), eq(payments.method, "voucher")))
      .groupBy(payments.voucherId)
      .as("u");
    const where = [eq(vouchers.organizationId, org)];
    if (opts.q?.trim()) where.push(ilike(vouchers.code, `%${opts.q.trim()}%`));
    const rows = await tx
      .select({ v: vouchers, usedCents: used.usedCents, n: used.n })
      .from(vouchers)
      .leftJoin(used, eq(used.voucherId, vouchers.id))
      .where(and(...where))
      .orderBy(desc(vouchers.issuedAt), desc(vouchers.code))
      .limit(500);
    const list = rows.map((r) => {
      const balanceCents = voucherBalance(r.v.amountCents, [{ amountCents: Number(r.usedCents ?? 0) }]);
      return { ...r.v, balanceCents, redemptions: Number(r.n ?? 0), expired: r.v.validUntil < today };
    });
    const filtered = opts.filter === "all" ? list : list.filter((v) => v.balanceCents > 0 && !v.expired);
    return {
      rows: filtered,
      totals: {
        outstandingCents: list.filter((v) => !v.expired).reduce((s, v) => s + v.balanceCents, 0),
        count: list.length,
      },
    };
  });
}

export async function getVoucher(auth: AuthContext, id: string) {
  const org = auth.organization.id;
  return withOrg(org, async (tx) => {
    const [v] = await tx.select().from(vouchers).where(and(eq(vouchers.organizationId, org), eq(vouchers.id, id)));
    if (!v) return null;
    const redemptions = await tx
      .select({
        id: payments.id,
        amountCents: payments.amountCents,
        paidAt: payments.paidAt,
        invoiceId: invoices.id,
        invoiceNumber: invoices.number,
        patientFirst: patients.firstName,
        patientLast: patients.lastName,
      })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .leftJoin(patients, eq(patients.id, invoices.patientId))
      .where(and(eq(payments.organizationId, org), eq(payments.voucherId, id)))
      .orderBy(desc(payments.paidAt));
    return {
      voucher: v,
      redemptions,
      balanceCents: voucherBalance(v.amountCents, redemptions),
      expired: v.validUntil < berlinDateIso(),
    };
  });
}

export async function getOrganizationForPrint(auth: AuthContext) {
  const org = auth.organization.id;
  return withOrg(org, async (tx) => {
    const [o] = await tx.select().from(organizations).where(eq(organizations.id, org));
    return o;
  });
}
