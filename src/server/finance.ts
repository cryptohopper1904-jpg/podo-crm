import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { withOrg } from "@/db";
import { fixedCosts, organizations } from "@/db/schema";
import type { AuthContext } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { berlinDateIso, berlinToUtc } from "@/lib/format";
import { breakEvenTreatments, monthlyShare } from "@/lib/invoice-math";

export const DEFAULT_MATERIAL_COST_CENTS = 350;

export const fixedCostInput = z.object({
  category: z.string().trim().min(1, "Bezeichnung fehlt").max(120),
  amountCents: z.number().int().min(1, "Betrag fehlt").max(100_000_000),
  interval: z.enum(["monthly", "quarterly", "yearly"]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Startdatum ungültig"),
  note: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(300).nullable().optional()),
  active: z.boolean().default(true),
});
export type FixedCostInput = z.infer<typeof fixedCostInput>;

type MonthRow = { y: number; m: number; v: number };
const toMonths = (rows: MonthRow[], year: number) => {
  const out = Array.from({ length: 12 }, () => 0);
  for (const r of rows) if (Number(r.y) === year) out[Number(r.m) - 1] += Number(r.v);
  return out;
};

export async function financeOverview(auth: AuthContext, year: number) {
  const org = auth.organization.id;
  const from = berlinToUtc(`${year - 1}-01-01`, "00:00");
  const to = berlinToUtc(`${year + 1}-01-01`, "00:00");
  const today = berlinDateIso();

  return withOrg(org, async (tx) => {
    const revenue = await tx.execute<MonthRow>(sql`
      select extract(year from (p.paid_at at time zone 'Europe/Berlin'))::int as y,
             extract(month from (p.paid_at at time zone 'Europe/Berlin'))::int as m,
             coalesce(sum(p.amount_cents), 0)::bigint as v
      from payments p
      where p.organization_id = ${org} and p.paid_at >= ${from} and p.paid_at < ${to}
      group by 1, 2`);

    // Behandlungen: Doku-Einträge + erledigte Termine ohne Doku (keine Doppelzählung)
    const treatments = await tx.execute<MonthRow>(sql`
      select y, m, count(*)::int as v from (
        select extract(year from (tr.treated_at at time zone 'Europe/Berlin'))::int as y,
               extract(month from (tr.treated_at at time zone 'Europe/Berlin'))::int as m
        from treatment_records tr
        where tr.organization_id = ${org} and tr.treated_at >= ${from} and tr.treated_at < ${to}
        union all
        select extract(year from (a.starts_at at time zone 'Europe/Berlin'))::int,
               extract(month from (a.starts_at at time zone 'Europe/Berlin'))::int
        from appointments a
        where a.organization_id = ${org} and a.status = 'done' and a.starts_at >= ${from} and a.starts_at < ${to}
          and not exists (
            select 1 from treatment_records t2
            where t2.organization_id = ${org}
              and (t2.appointment_id = a.id
                   or (t2.patient_id = a.patient_id
                       and (t2.treated_at at time zone 'Europe/Berlin')::date = (a.starts_at at time zone 'Europe/Berlin')::date)))
      ) x group by 1, 2`);

    const [recv] = (
      await tx.execute<{ open: number; overdue: number; n: number }>(sql`
        select coalesce(sum(total_cents - paid_cents), 0)::bigint as open,
               coalesce(sum(case when due_at < ${today} then total_cents - paid_cents else 0 end), 0)::bigint as overdue,
               count(*)::int as n
        from invoices
        where organization_id = ${org} and status in ('issued', 'partially_paid') and total_cents > 0`)
    ).rows;

    const byService = (
      await tx.execute<{ name: string; qty: number; total: number }>(sql`
        select coalesce(s.name, 'Freitext / sonstige') as name,
               coalesce(sum(l.quantity), 0)::float as qty,
               coalesce(sum(l.total_cents), 0)::bigint as total
        from invoice_lines l
        join invoices i on i.id = l.invoice_id
        left join services s on s.id = l.service_id
        where l.organization_id = ${org} and i.organization_id = ${org}
          and i.status not in ('draft', 'cancelled') and i.kind <> 'credit_note'
          and i.issued_at >= ${`${year}-01-01`} and i.issued_at < ${`${year + 1}-01-01`}
        group by 1
        order by 3 desc`)
    ).rows.map((r) => ({ name: r.name, quantity: Number(r.qty), totalCents: Number(r.total) }));

    const costs = await tx.select().from(fixedCosts).where(eq(fixedCosts.organizationId, org)).orderBy(asc(fixedCosts.category));
    const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, org));
    const mc = Number((o?.settings as { materialCostCents?: unknown } | undefined)?.materialCostCents);
    const materialCostCents = Number.isFinite(mc) && mc >= 0 ? mc : DEFAULT_MATERIAL_COST_CENTS;

    const revenueMonths = toMonths(revenue.rows, year);
    const revenuePrevMonths = toMonths(revenue.rows, year - 1);
    const treatmentMonths = toMonths(treatments.rows, year);
    const treatmentPrevMonths = toMonths(treatments.rows, year - 1);
    const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);

    const revenueYear = sum(revenueMonths);
    const treatmentsYear = sum(treatmentMonths);
    const revenuePrev = sum(revenuePrevMonths);
    const treatmentsPrev = sum(treatmentPrevMonths);
    // Ø Umsatz je Behandlung: laufendes Jahr, sonst Vorjahr
    const avgRevenuePerTreatment = treatmentsYear
      ? Math.round(revenueYear / treatmentsYear)
      : treatmentsPrev
        ? Math.round(revenuePrev / treatmentsPrev)
        : 0;
    const fixedMonthlyCents = costs.filter((c) => c.active).reduce((s, c) => s + monthlyShare(c.amountCents, c.interval), 0);
    const currentYear = Number(today.slice(0, 4));
    const monthsElapsed = year < currentYear ? 12 : year > currentYear ? 0 : Number(today.slice(5, 7));

    return {
      year,
      revenueMonths,
      revenuePrevMonths,
      treatmentMonths,
      treatmentPrevMonths,
      revenueYear,
      revenuePrev,
      treatmentsYear,
      treatmentsPrev,
      receivables: { openCents: Number(recv?.open ?? 0), overdueCents: Number(recv?.overdue ?? 0), count: Number(recv?.n ?? 0) },
      byService,
      costs,
      fixedMonthlyCents,
      materialCostCents,
      avgRevenuePerTreatment,
      breakEven: breakEvenTreatments(fixedMonthlyCents, avgRevenuePerTreatment, materialCostCents),
      avgTreatmentsPerMonth: monthsElapsed ? Math.round((treatmentsYear / monthsElapsed) * 10) / 10 : 0,
    };
  });
}

export async function saveFixedCost(auth: AuthContext, id: string | null, input: FixedCostInput) {
  const org = auth.organization.id;
  const savedId = await withOrg(org, async (tx) => {
    if (id) {
      const r = await tx
        .update(fixedCosts)
        .set(input)
        .where(and(eq(fixedCosts.organizationId, org), eq(fixedCosts.id, id)))
        .returning({ id: fixedCosts.id });
      return r[0]?.id ?? null;
    }
    const [r] = await tx.insert(fixedCosts).values({ ...input, organizationId: org }).returning({ id: fixedCosts.id });
    return r.id;
  });
  if (savedId) {
    await audit({ organizationId: org, userId: auth.user.id, action: id ? "fixed_cost.update" : "fixed_cost.create", entity: "fixed_cost", entityId: savedId });
  }
  return savedId;
}

export async function deleteFixedCost(auth: AuthContext, id: string) {
  const org = auth.organization.id;
  await withOrg(org, (tx) => tx.delete(fixedCosts).where(and(eq(fixedCosts.organizationId, org), eq(fixedCosts.id, id))));
  await audit({ organizationId: org, userId: auth.user.id, action: "fixed_cost.delete", entity: "fixed_cost", entityId: id });
}

export async function setMaterialCost(auth: AuthContext, cents: number) {
  const org = auth.organization.id;
  await withOrg(org, (tx) =>
    tx
      .update(organizations)
      .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('materialCostCents', ${cents}::int)` })
      .where(eq(organizations.id, org)),
  );
  await audit({ organizationId: org, userId: auth.user.id, action: "settings.material_cost", meta: { cents } });
}
