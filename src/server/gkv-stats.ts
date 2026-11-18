import "server-only";
import { sql } from "drizzle-orm";
import { withOrg } from "@/db";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import { feature } from "@/lib/features";
import { berlinDateIso } from "@/lib/format";
import { DEDUCTION_STATUSES, type DeductionStatus } from "@/lib/rules/gkv-billing";
import { monthsOf, type Period } from "@/lib/stats";
import { assertCan } from "./authz";
import { countedInvoiceSql } from "./finance";
import { periodBounds } from "./stats";

/**
 * GKV Paket C (Teil 2): Auswertung Kasse vs. privat und Belegliste.
 *
 * Abgrenzung (bewusst einfach, mit der Steuerberatung abzustimmen – docs/GKV.md):
 *  - GKV-Kassenanteil = Heilmittelkosten − Zuzahlungen laut Abrechnungsläufen (billing_batches, gespeicherte Summen) nach
 *    dem Erstellungstag des Laufs. Das ist der Betrag, den die Kassen zahlen sollen – nicht der Zahlungseingang.
 *  - Zuzahlungen (ZZ) = Zuzahlungsquittungen nach Belegdatum, ohne stornierte (wie countedInvoiceSql).
 *  - Privatumsatz = alle übrigen gezählten Belege (Rechnungen, Quittungen, Sammelrechnungen, Ausfallgebühren) nach
 *    Belegdatum, brutto, ohne Entwürfe/Stornos/Gutschriften/Anzahlungen und ohne angerechnete Quittungen.
 *  - Absetzungen nach Datum der Absetzung, je Status.
 */

const n = (v: unknown) => Number(v ?? 0);

export type GkvPrivateMonth = { month: string; insurerCents: number; copaymentCents: number; privateCents: number; deductionCents: number };
export type GkvPrivateStats = {
  gkvEnabled: boolean;
  batches: { count: number; prescriptions: number; remedyCents: number; copaymentCents: number; insurerCents: number; withoutRemedy: number };
  copayments: { count: number; cents: number };
  private: { count: number; cents: number };
  deductions: Record<DeductionStatus, { count: number; cents: number }>;
  months: GkvPrivateMonth[];
};

/** Auswertung Kasse vs. privat im Zeitraum (nur Summen, keine Personendaten). Recht: finance.read. */
export async function gkvPrivateStats(auth: AuthContext, period: Period): Promise<GkvPrivateStats> {
  assertCan(auth, "finance.read");
  const org = auth.organization.id;
  const gkvEnabled = feature(auth.organization, "gkvBilling");
  const { fromTs, toTs } = periodBounds(period);
  const issued = sql`i.issued_at >= ${period.from} and i.issued_at <= ${period.until}`;
  const months = monthsOf({ from: period.from, to: period.until });
  const res = await withOrg(org, async (tx) => {
    const batchRows = (
      await tx.execute<{ ym: string; n: number; vos: number; remedy: number; copay: number; missing: number }>(sql`
        select to_char(b.created_at at time zone 'Europe/Berlin', 'YYYY-MM') as ym, count(*)::int as n,
               coalesce(sum(b.prescription_count), 0)::int as vos,
               coalesce(sum(b.remedy_total_cents), 0)::bigint as remedy,
               coalesce(sum(coalesce(b.copayment_total_cents, b.total_cents)) filter (where b.remedy_total_cents is not null), 0)::bigint as copay,
               count(*) filter (where b.remedy_total_cents is null)::int as missing
        from billing_batches b
        where b.organization_id = ${org} and b.created_at >= ${fromTs} and b.created_at < ${toTs}
        group by 1`)
    ).rows;
    const invRows = (
      await tx.execute<{ ym: string; zz: boolean; n: number; v: number }>(sql`
        select to_char(i.issued_at, 'YYYY-MM') as ym, (i.kind = 'copayment') as zz, count(*)::int as n, coalesce(sum(i.total_cents), 0)::bigint as v
        from invoices i
        where i.organization_id = ${org} and ${countedInvoiceSql} and ${issued}
        group by 1, 2`)
    ).rows;
    const dedRows = (
      await tx.execute<{ ym: string; status: string; n: number; v: number }>(sql`
        select to_char(d.deducted_on, 'YYYY-MM') as ym, d.status, count(*)::int as n, coalesce(sum(d.amount_cents), 0)::bigint as v
        from gkv_deductions d
        where d.organization_id = ${org} and d.deducted_on >= ${period.from} and d.deducted_on <= ${period.until}
        group by 1, 2`)
    ).rows;
    return { batchRows, invRows, dedRows };
  });
  const byMonth = new Map<string, GkvPrivateMonth>(months.map((m) => [m, { month: m, insurerCents: 0, copaymentCents: 0, privateCents: 0, deductionCents: 0 }]));
  const at = (ym: string) => byMonth.get(ym) ?? byMonth.set(ym, { month: ym, insurerCents: 0, copaymentCents: 0, privateCents: 0, deductionCents: 0 }).get(ym)!;
  const batches = { count: 0, prescriptions: 0, remedyCents: 0, copaymentCents: 0, insurerCents: 0, withoutRemedy: 0 };
  for (const r of res.batchRows) {
    const insurer = n(r.remedy) - n(r.copay);
    batches.count += n(r.n);
    batches.prescriptions += n(r.vos);
    batches.remedyCents += n(r.remedy);
    batches.copaymentCents += n(r.copay);
    batches.insurerCents += insurer;
    batches.withoutRemedy += n(r.missing);
    at(r.ym).insurerCents += insurer;
  }
  const copayments = { count: 0, cents: 0 };
  const priv = { count: 0, cents: 0 };
  for (const r of res.invRows) {
    const t = r.zz ? copayments : priv;
    t.count += n(r.n);
    t.cents += n(r.v);
    if (r.zz) at(r.ym).copaymentCents += n(r.v);
    else at(r.ym).privateCents += n(r.v);
  }
  const deductions = Object.fromEntries(DEDUCTION_STATUSES.map((s) => [s, { count: 0, cents: 0 }])) as GkvPrivateStats["deductions"];
  for (const r of res.dedRows) {
    const s = (DEDUCTION_STATUSES as readonly string[]).includes(r.status) ? (r.status as DeductionStatus) : "open";
    deductions[s].count += n(r.n);
    deductions[s].cents += n(r.v);
    at(r.ym).deductionCents += n(r.v);
  }
  await audit({ organizationId: org, userId: auth.user.id, action: "stats.gkv_private", meta: { from: period.from, to: period.until } });
  return { gkvEnabled, batches, copayments, private: priv, deductions, months: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)) };
}

// ───────────────────────── Belegliste ─────────────────────────

export type BelegZz = {
  invoiceId: string;
  number: string | null;
  issuedAt: string | null;
  kind: "copayment" | "storno";
  status: string;
  totalCents: number;
  patient: string;
  patientNumber: number | null;
  methods: string[];
  /** Storno: Nummer der stornierten Quittung; Quittung: Nummer des Stornobelegs */
  related: string | null;
  prescriptionIssuedAt: string | null;
};
export type BelegBatch = {
  id: string;
  createdOn: string;
  partner: string;
  prescriptionCount: number;
  remedyCents: number | null;
  copaymentCents: number;
  insurerCents: number | null;
  exportedOn: string | null;
  note: string | null;
};

/**
 * Interne Belegliste je Zeitraum: Zuzahlungsquittungen (ZZ) samt Stornobelegen nach Belegdatum und Abrechnungsläufe nach
 * Erstellungstag. Enthält Namen (Beleg-Empfänger:innen), keine Diagnosen. Recht: invoices.read (Belege) + finance.read.
 */
export async function belegliste(auth: AuthContext, period: Pick<Period, "from" | "until">): Promise<{ receipts: BelegZz[]; batches: BelegBatch[] }> {
  assertCan(auth, "invoices.read", "finance.read");
  const org = auth.organization.id;
  const { fromTs, toTs } = periodBounds(period);
  const data = await withOrg(org, async (tx) => {
    const receipts = (
      await tx.execute<{
        id: string;
        number: string | null;
        issued_at: string | null;
        kind: string;
        status: string;
        total_cents: number;
        first_name: string | null;
        last_name: string | null;
        pnum: number | null;
        methods: string[] | null;
        related: string | null;
        vo_issued: string | null;
      }>(sql`
        select i.id, i.number, i.issued_at::text as issued_at, i.kind::text as kind, i.status::text as status, i.total_cents,
               p.first_name, p.last_name, p.number as pnum,
               (select array_agg(distinct pay.method::text) from payments pay where pay.organization_id = ${org} and pay.invoice_id = i.id) as methods,
               case when i.kind = 'copayment' then (select s.number from invoices s where s.organization_id = ${org} and s.cancels_invoice_id = i.id order by s.issued_at limit 1)
                    else c.number end as related,
               vo.issued_at::text as vo_issued
        from invoices i
        left join invoices c on c.id = i.cancels_invoice_id and c.organization_id = ${org}
        left join patients p on p.id = i.patient_id and p.organization_id = ${org}
        left join prescriptions vo on vo.id = coalesce(i.prescription_id, c.prescription_id) and vo.organization_id = ${org}
        where i.organization_id = ${org} and i.status <> 'draft'
          and i.issued_at >= ${period.from} and i.issued_at <= ${period.until}
          and (i.kind = 'copayment' or (i.kind = 'credit_note' and c.kind = 'copayment'))
        order by i.issued_at, i.number`)
    ).rows;
    const batches = (
      await tx.execute<{ id: string; created_at: Date; partner: string; prescription_count: number; remedy: number | null; copay: number | null; total: number; exported_at: Date | null; note: string | null }>(sql`
        select b.id, b.created_at, b.partner, b.prescription_count, b.remedy_total_cents as remedy, b.copayment_total_cents as copay, b.total_cents as total, b.exported_at, b.note
        from billing_batches b
        where b.organization_id = ${org} and b.created_at >= ${fromTs} and b.created_at < ${toTs}
        order by b.created_at`)
    ).rows;
    return { receipts, batches };
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "belegliste.read", meta: { from: period.from, to: period.until, receipts: data.receipts.length, batches: data.batches.length } });
  return {
    receipts: data.receipts.map((r) => ({
      invoiceId: r.id,
      number: r.number,
      issuedAt: r.issued_at,
      kind: r.kind === "copayment" ? "copayment" : "storno",
      status: r.status,
      totalCents: n(r.total_cents),
      patient: [r.first_name, r.last_name].filter(Boolean).join(" "),
      patientNumber: r.pnum === null ? null : n(r.pnum),
      methods: r.methods ?? [],
      related: r.related,
      prescriptionIssuedAt: r.vo_issued,
    })),
    batches: data.batches.map((b) => {
      const copay = n(b.copay ?? b.total);
      return {
        id: b.id,
        createdOn: berlinDateIso(new Date(b.created_at)),
        partner: b.partner,
        prescriptionCount: n(b.prescription_count),
        remedyCents: b.remedy === null ? null : n(b.remedy),
        copaymentCents: copay,
        insurerCents: b.remedy === null ? null : n(b.remedy) - copay,
        exportedOn: b.exported_at ? berlinDateIso(new Date(b.exported_at)) : null,
        note: b.note,
      };
    }),
  };
}

export const BELEGLISTE_HEADER = ["Art", "Datum", "Beleg-/Lauf-Nr.", "Status", "Betrag EUR", "Person", "Personennummer", "Zahlungsart", "Bezug", "Verordnung vom", "Heilmittelkosten EUR", "Zuzahlungen EUR", "Kassenanteil EUR", "Verordnungen", "Partner", "exportiert am"];

const euro = (c: number | null) => (c === null ? "" : (c / 100).toFixed(2).replace(".", ","));

/** CSV-Zeilen der Belegliste (Quittungen und Läufe in einer Tabelle, Spalte „Art“) */
export function beleglisteRows(b: { receipts: BelegZz[]; batches: BelegBatch[] }): (string | number)[][] {
  const rows: (string | number)[][] = [BELEGLISTE_HEADER];
  for (const r of b.receipts) {
    rows.push([
      r.kind === "copayment" ? "Zuzahlungsquittung" : "Storno Zuzahlungsquittung",
      r.issuedAt ?? "",
      r.number ?? "",
      r.status,
      euro(r.totalCents),
      r.patient,
      r.patientNumber ?? "",
      r.methods.join(" | "),
      r.related ?? "",
      r.prescriptionIssuedAt ?? "",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
  }
  for (const b2 of b.batches) {
    rows.push(["Abrechnungslauf", b2.createdOn, b2.id, b2.exportedOn ? "exportiert" : "offen", euro(b2.insurerCents), "", "", "", b2.note ?? "", "", euro(b2.remedyCents), euro(b2.copaymentCents), euro(b2.insurerCents), b2.prescriptionCount, b2.partner, b2.exportedOn ?? ""]);
  }
  return rows;
}
