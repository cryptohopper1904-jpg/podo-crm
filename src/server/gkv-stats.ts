import "server-only";
import { sql } from "drizzle-orm";
import { withOrg } from "@/db";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import { feature } from "@/lib/features";
import { berlinDateIso, dateDe } from "@/lib/format";
import { DEDUCTION_STATUSES, type DeductionStatus } from "@/lib/rules/gkv-billing";
import { monthsOf, type Period } from "@/lib/stats";
import { assertCan } from "./authz";
import { countedInvoiceSql } from "./finance";
import { periodBounds } from "./stats";

/**
 * GKV Paket C (Teil 2): Auswertung Kasse vs. privat und Belegliste.
 *
 * Abrechnungsvolumen, kein Umsatz/Erlös im Sinne der Buchhaltung. Abgrenzung (bewusst einfach, mit der Steuerberatung
 * abzustimmen – docs/GKV.md):
 *  - GKV-Kassenanteil = Heilmittelkosten − Zuzahlungen laut Abrechnungsläufen (billing_batches, gespeicherte Summen) nach
 *    dem Erstellungstag des Laufs. Das ist der Betrag, den die Kassen zahlen sollen (Soll) – nicht der Zahlungseingang.
 *  - Neuabrechnung nach Korrektur: die Verordnung steckt im alten UND im neuen Lauf. Abgezogen wird deshalb „ersetzt durch
 *    Neuabrechnung“ = Heilmittelkosten/Zuzahlung der Erstabrechnung (original_* der Vermerke mit resolution = 'rebilled'),
 *    im Monat des neuen Laufs (resolved_batch_id) – über beide Läufe zählt die Verordnung genau einmal (neuer Stand).
 *    Nur, wenn der alte Lauf Heilmittelkosten gespeichert hat (sonst war die Erstabrechnung nicht summiert).
 *  - Zuzahlungen (ZZ) = Zuzahlungsquittungen nach Belegdatum, ohne stornierte (wie countedInvoiceSql) – Ist.
 *  - Privat = alle übrigen gezählten Belege (Rechnungen, Quittungen, Sammelrechnungen, Ausfallgebühren) nach
 *    Belegdatum, brutto, ohne Entwürfe/Stornos/Gutschriften/Anzahlungen und ohne angerechnete Quittungen.
 *  - Absetzungen nach Datum der Absetzung: Minderung = akzeptiert + erledigt/„Absetzung bleibt“; offen/Widerspruch und
 *    erledigt/„Widerspruch erfolgreich“ getrennt (keine Minderung). Nicht automatisch vom Kassenanteil abgezogen.
 *  - Stand Abruf: Stornos/Korrekturen wirken rückwirkend auf frühere Zeiträume.
 */

const n = (v: unknown) => Number(v ?? 0);

export type GkvPrivateMonth = { month: string; insurerCents: number; copaymentCents: number; privateCents: number; deductionCents: number };
export type GkvPrivateStats = {
  gkvEnabled: boolean;
  /**
   * Summen laut Läufen (brutto, wie gespeichert); `replaced` = „ersetzt durch Neuabrechnung“ (Erstabrechnung der in einem
   * Lauf des Zeitraums neu abgerechneten Verordnungen); `insurerNetCents` = Kassenanteil ohne Doppelzählung
   */
  batches: {
    count: number;
    prescriptions: number;
    remedyCents: number;
    copaymentCents: number;
    insurerCents: number;
    withoutRemedy: number;
    replaced: { count: number; remedyCents: number; copaymentCents: number; insurerCents: number };
    insurerNetCents: number;
  };
  copayments: { count: number; cents: number };
  private: { count: number; cents: number };
  deductions: Record<DeductionStatus, { count: number; cents: number }>;
  /** Minderung = akzeptiert + erledigt/upheld; ausstehend = offen + Widerspruch; reversed = erledigt/Widerspruch erfolgreich */
  deductionSummary: { reductionCents: number; reductionCount: number; pendingCents: number; pendingCount: number; reversedCents: number; reversedCount: number };
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
    // Neuabrechnung nach Korrektur: Erstabrechnung abziehen, im Monat des neuen Laufs
    const replacedRows = (
      await tx.execute<{ ym: string; n: number; remedy: number; copay: number }>(sql`
        select to_char(nb.created_at at time zone 'Europe/Berlin', 'YYYY-MM') as ym, count(*)::int as n,
               coalesce(sum(c.original_remedy_cost_cents), 0)::bigint as remedy, coalesce(sum(c.original_copayment_cents), 0)::bigint as copay
        from prescription_corrections c
        join billing_batches nb on nb.id = c.resolved_batch_id and nb.organization_id = ${org}
        join billing_batches ob on ob.id = c.original_batch_id and ob.organization_id = ${org}
        where c.organization_id = ${org} and c.resolution = 'rebilled' and ob.remedy_total_cents is not null
          and c.original_remedy_cost_cents is not null
          and nb.created_at >= ${fromTs} and nb.created_at < ${toTs}
        group by 1`)
    ).rows;
    const dedRows = (
      await tx.execute<{ ym: string; status: string; outcome: string | null; n: number; v: number }>(sql`
        select to_char(d.deducted_on, 'YYYY-MM') as ym, d.status, d.outcome, count(*)::int as n, coalesce(sum(d.amount_cents), 0)::bigint as v
        from gkv_deductions d
        where d.organization_id = ${org} and d.deducted_on >= ${period.from} and d.deducted_on <= ${period.until}
        group by 1, 2, 3`)
    ).rows;
    return { batchRows, invRows, dedRows, replacedRows };
  });
  const byMonth = new Map<string, GkvPrivateMonth>(months.map((m) => [m, { month: m, insurerCents: 0, copaymentCents: 0, privateCents: 0, deductionCents: 0 }]));
  const at = (ym: string) => byMonth.get(ym) ?? byMonth.set(ym, { month: ym, insurerCents: 0, copaymentCents: 0, privateCents: 0, deductionCents: 0 }).get(ym)!;
  const batches: GkvPrivateStats["batches"] = { count: 0, prescriptions: 0, remedyCents: 0, copaymentCents: 0, insurerCents: 0, withoutRemedy: 0, replaced: { count: 0, remedyCents: 0, copaymentCents: 0, insurerCents: 0 }, insurerNetCents: 0 };
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
  for (const r of res.replacedRows) {
    const insurer = n(r.remedy) - n(r.copay);
    batches.replaced.count += n(r.n);
    batches.replaced.remedyCents += n(r.remedy);
    batches.replaced.copaymentCents += n(r.copay);
    batches.replaced.insurerCents += insurer;
    at(r.ym).insurerCents -= insurer;
  }
  batches.insurerNetCents = batches.insurerCents - batches.replaced.insurerCents;
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
  const deductionSummary = { reductionCents: 0, reductionCount: 0, pendingCents: 0, pendingCount: 0, reversedCents: 0, reversedCount: 0 };
  for (const r of res.dedRows) {
    const s = (DEDUCTION_STATUSES as readonly string[]).includes(r.status) ? (r.status as DeductionStatus) : "open";
    deductions[s].count += n(r.n);
    deductions[s].cents += n(r.v);
    const kind = deductionKind(s, r.outcome);
    deductionSummary[`${kind}Cents`] += n(r.v);
    deductionSummary[`${kind}Count`] += n(r.n);
    // Monatsspalte „Absetzungen“: nur die Minderung (akzeptiert + erledigt/Absetzung bleibt)
    if (kind === "reduction") at(r.ym).deductionCents += n(r.v);
  }
  await audit({ organizationId: org, userId: auth.user.id, action: "stats.gkv_private", meta: { from: period.from, to: period.until } });
  return { gkvEnabled, batches, copayments, private: priv, deductions, deductionSummary, months: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)) };
}

/** Einordnung einer Absetzung für die Auswertung (Minderung nur akzeptiert bzw. erledigt mit „Absetzung bleibt“) */
export function deductionKind(status: DeductionStatus, outcome: string | null): "reduction" | "pending" | "reversed" {
  if (status === "accepted") return "reduction";
  if (status === "done") return outcome === "reversed" ? "reversed" : "reduction";
  return "pending";
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
};
export type BelegBatch = {
  id: string;
  /** lesbar: „Lauf <laufende Nummer der Praxis> vom <Datum>“ */
  label: string;
  createdOn: string;
  partner: string;
  prescriptionCount: number;
  remedyCents: number | null;
  copaymentCents: number;
  insurerCents: number | null;
  exportedOn: string | null;
  note: string | null;
  /** Verordnungen dieses Laufs, die später in einem anderen Lauf neu abgerechnet wurden (Erstabrechnung) */
  replacedCount: number;
  replacedInsurerCents: number;
  /** Neuabrechnungen nach Korrektur in diesem Lauf */
  rebillCount: number;
};

/**
 * Interne Belegliste je Zeitraum (Hilfsliste, keine Buchungsgrundlage): Zuzahlungsquittungen (ZZ) samt Stornobelegen nach
 * Belegdatum und Abrechnungsläufe nach Erstellungstag. Enthält Namen (Beleg-Empfänger:innen), keine Diagnosen und kein
 * Verordnungsdatum (Datenminimierung, Art. 9 DSGVO). Recht: invoices.read (Belege) + finance.read.
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
      }>(sql`
        select i.id, i.number, i.issued_at::text as issued_at, i.kind::text as kind, i.status::text as status, i.total_cents,
               p.first_name, p.last_name, p.number as pnum,
               (select array_agg(distinct pay.method::text) from payments pay where pay.organization_id = ${org} and pay.invoice_id = i.id) as methods,
               case when i.kind = 'copayment' then (select s.number from invoices s where s.organization_id = ${org} and s.cancels_invoice_id = i.id order by s.issued_at limit 1)
                    else c.number end as related
        from invoices i
        left join invoices c on c.id = i.cancels_invoice_id and c.organization_id = ${org}
        left join patients p on p.id = i.patient_id and p.organization_id = ${org}
        where i.organization_id = ${org} and i.status <> 'draft'
          and i.issued_at >= ${period.from} and i.issued_at <= ${period.until}
          and (i.kind = 'copayment' or (i.kind = 'credit_note' and c.kind = 'copayment'))
        order by i.issued_at, i.number`)
    ).rows;
    const batches = (
      await tx.execute<{
        id: string;
        seq: number;
        created_at: Date;
        partner: string;
        prescription_count: number;
        remedy: number | null;
        copay: number | null;
        total: number;
        exported_at: Date | null;
        note: string | null;
        replaced: number;
        replaced_insurer: number;
        rebills: number;
      }>(sql`
        select b.id, b.seq, b.created_at, b.partner, b.prescription_count, b.remedy_total_cents as remedy, b.copayment_total_cents as copay, b.total_cents as total, b.exported_at, b.note,
               (select count(*)::int from prescription_corrections c where c.organization_id = ${org} and c.original_batch_id = b.id and c.resolution = 'rebilled') as replaced,
               (select coalesce(sum(coalesce(c.original_remedy_cost_cents, 0) - coalesce(c.original_copayment_cents, 0)), 0)::bigint from prescription_corrections c
                 where c.organization_id = ${org} and c.original_batch_id = b.id and c.resolution = 'rebilled') as replaced_insurer,
               (select count(*)::int from prescription_corrections c where c.organization_id = ${org} and c.resolved_batch_id = b.id and c.resolution = 'rebilled') as rebills
        from (select bb.*, row_number() over (order by bb.created_at, bb.id)::int as seq from billing_batches bb where bb.organization_id = ${org}) b
        where b.created_at >= ${fromTs} and b.created_at < ${toTs}
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
    })),
    batches: data.batches.map((b) => {
      const copay = n(b.copay ?? b.total);
      const createdOn = berlinDateIso(new Date(b.created_at));
      return {
        id: b.id,
        label: `Lauf ${n(b.seq)} vom ${dateDe(createdOn)}`,
        createdOn,
        partner: b.partner,
        prescriptionCount: n(b.prescription_count),
        remedyCents: b.remedy === null ? null : n(b.remedy),
        copaymentCents: copay,
        insurerCents: b.remedy === null ? null : n(b.remedy) - copay,
        exportedOn: b.exported_at ? berlinDateIso(new Date(b.exported_at)) : null,
        note: b.note,
        replacedCount: n(b.replaced),
        replacedInsurerCents: n(b.replaced_insurer),
        rebillCount: n(b.rebills),
      };
    }),
  };
}

export const BELEGLISTE_HEADER = ["Art", "Datum", "Beleg-/Lauf-Nr.", "Status", "Betrag EUR", "Person", "Personennummer", "Zahlungsart", "Bezug", "Heilmittelkosten EUR", "Zuzahlungen EUR", "Kassenanteil EUR", "Verordnungen", "Partner", "exportiert am"];

/** Kennzeichnung eines Laufs mit Korrekturbezug (Spalte „Bezug“, Seite) – keine Notiz, keine Personendaten */
export function batchCorrectionNote(b: Pick<BelegBatch, "replacedCount" | "replacedInsurerCents" | "rebillCount">): string {
  const parts: string[] = [];
  if (b.replacedCount) parts.push(`${b.replacedCount} Verordnung${b.replacedCount === 1 ? "" : "en"} später neu abgerechnet (Kassenanteil ${euro(b.replacedInsurerCents)} EUR ersetzt)`);
  if (b.rebillCount) parts.push(`enthält ${b.rebillCount} Neuabrechnung${b.rebillCount === 1 ? "" : "en"} nach Korrektur`);
  return parts.join(" | ");
}

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
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
  }
  for (const b2 of b.batches) {
    rows.push(["Abrechnungslauf", b2.createdOn, b2.label, b2.exportedOn ? "exportiert" : "offen", euro(b2.insurerCents), "", "", "", batchCorrectionNote(b2), euro(b2.remedyCents), euro(b2.copaymentCents), euro(b2.insurerCents), b2.prescriptionCount, b2.partner, b2.exportedOn ?? ""]);
  }
  return rows;
}
