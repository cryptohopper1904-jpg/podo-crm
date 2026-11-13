import "server-only";
import { sql } from "drizzle-orm";
import { withOrg } from "@/db";
import type { AuthContext } from "@/lib/auth/session";
import { berlinToUtc } from "@/lib/format";
import {
  LEAD_EXCLUDED_SOURCES,
  ONLINE_SOURCES,
  addDaysIso,
  monthsOf,
  stockCoverage,
  weekdayOccurrences,
  type HeatRow,
  type Period,
} from "@/lib/stats";
import { isBelowMinimum } from "@/lib/stock";
import { countedInvoiceSql } from "./finance";

/**
 * Auswertung & Statistik (/auswertung/termine, /auswertung/leistungen).
 * Nur Aggregate (Anzahlen, Summen, Mediane) – keine Namen oder Kennungen von Patient:innen.
 * Aggregation in SQL; Wochentag/Stunde in Berliner Ortszeit. Rechte prüft die Seite (finance.read wie /auswertung).
 */

const n = (v: unknown) => Number(v ?? 0);
const nn = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const ONLINE = sql.raw(ONLINE_SOURCES.map((s) => `'${s}'`).join(", "));
const LEAD_EXCLUDED = sql.raw(LEAD_EXCLUDED_SOURCES.map((s) => `'${s}'`).join(", "));

/** UTC-Grenzen eines Zeitraums bis heute: [from 00:00 Berlin, Tag nach `until` 00:00 Berlin) */
export function periodBounds(p: Pick<Period, "from" | "until">) {
  return { fromTs: berlinToUtc(p.from, "00:00"), toTs: berlinToUtc(addDaysIso(p.until, 1), "00:00") };
}

/** Wählbare Behandler:innen für den Filter: aktive Kalender-Mitglieder und alle, denen je ein Termin zugeordnet war */
export async function statsTherapists(auth: AuthContext): Promise<{ id: string; name: string }[]> {
  const org = auth.organization.id;
  return withOrg(org, async (tx) =>
    (
      await tx.execute<{ id: string; name: string }>(sql`
        select u.id, u.name from users u
        where exists (select 1 from memberships m where m.organization_id = ${org} and m.user_id = u.id and m.role in ('owner', 'therapist') and m.active)
           or exists (select 1 from appointments a where a.organization_id = ${org} and a.therapist_id = u.id)
        order by u.name`)
    ).rows.map((r) => ({ id: r.id, name: r.name })),
  );
}

export type AppointmentStats = Awaited<ReturnType<typeof appointmentStats>>;

/**
 * Termine im Zeitraum (nach Terminbeginn):
 * - Belegung je Wochentag × Stunde (ohne Absagen), stärkste Tage (Ø je Kalendertag)
 * - Vorlaufzeit = Terminbeginn − Anlage des Termins (Median); ohne Absagen, ohne nachgetragene Termine
 *   (Anlage nach Beginn) und ohne Kalender-Abo-Importe (Anlagezeit = Importzeit)
 * - Absagequote = abgesagt ÷ alle; No-Show-Quote = nicht erschienen ÷ (erledigt + nicht erschienen)
 * - Online-Anteil = online/Portal/Doctolib ÷ alle nicht abgesagten
 * - neue Patient:innen = erster (nicht abgesagter) Termin bzw. erste Doku liegt im Zeitraum
 */
export async function appointmentStats(auth: AuthContext, period: Period, therapistId: string | null = null) {
  const org = auth.organization.id;
  const { fromTs, toTs } = periodBounds(period);
  const th = therapistId ? sql`and a.therapist_id = ${therapistId}` : sql``;
  const base = sql`a.organization_id = ${org} and a.starts_at >= ${fromTs} and a.starts_at < ${toTs} ${th}`;
  const leadOk = sql`a.created_at <= a.starts_at and a.source::text not in (${LEAD_EXCLUDED})`;
  const leadH = sql`extract(epoch from (a.starts_at - a.created_at)) / 3600.0`;

  return withOrg(org, async (tx) => {
    const [tot] = (
      await tx.execute<Record<string, number>>(sql`
        select count(*)::int as total,
               count(*) filter (where a.status = 'cancelled')::int as cancelled,
               count(*) filter (where a.status = 'no_show')::int as no_show,
               count(*) filter (where a.status = 'done')::int as done,
               count(*) filter (where a.status <> 'cancelled')::int as booked,
               count(*) filter (where a.status <> 'cancelled' and a.source::text in (${ONLINE}))::int as online
        from appointments a where ${base}`)
    ).rows;

    const bySource = (
      await tx.execute<{ source: string; n: number }>(sql`
        select a.source::text as source, count(*)::int as n
        from appointments a where ${base} and a.status <> 'cancelled'
        group by 1 order by 2 desc`)
    ).rows.map((r) => ({ source: r.source, count: n(r.n) }));

    // Wochentag × Stunde (Belegung + Median-Vorlauf), dazu je Wochentag und gesamt (grouping sets → eine Abfrage)
    const grid = (
      await tx.execute<{ g: number; isodow: number | null; hour: number | null; cnt: number; lead: number | null; lead_n: number }>(sql`
        select grouping(isodow, hour)::int as g, isodow, hour, count(*)::int as cnt,
               percentile_cont(0.5) within group (order by lead_h) filter (where lead_ok) as lead,
               count(*) filter (where lead_ok)::int as lead_n
        from (
          select extract(isodow from (a.starts_at at time zone 'Europe/Berlin'))::int as isodow,
                 extract(hour from (a.starts_at at time zone 'Europe/Berlin'))::int as hour,
                 ${leadH} as lead_h,
                 (${leadOk}) as lead_ok
          from appointments a where ${base} and a.status <> 'cancelled'
        ) x
        group by grouping sets ((isodow, hour), (isodow), ())`)
    ).rows;

    const slots: (HeatRow & { lead: number | null; leadCount: number })[] = [];
    const weekdayCounts = [0, 0, 0, 0, 0, 0, 0];
    const weekdayLead: (number | null)[] = [null, null, null, null, null, null, null];
    let leadMedian: number | null = null;
    let leadCount = 0;
    for (const r of grid) {
      const g = n(r.g);
      if (g === 0) slots.push({ isodow: n(r.isodow), hour: n(r.hour), value: n(r.cnt), lead: nn(r.lead), leadCount: n(r.lead_n) });
      else if (g === 1) {
        weekdayCounts[n(r.isodow) - 1] = n(r.cnt);
        weekdayLead[n(r.isodow) - 1] = nn(r.lead);
      } else {
        leadMedian = nn(r.lead);
        leadCount = n(r.lead_n);
      }
    }

    const topDates = (
      await tx.execute<{ d: string; cnt: number }>(sql`
        select to_char((a.starts_at at time zone 'Europe/Berlin')::date, 'YYYY-MM-DD') as d, count(*)::int as cnt
        from appointments a where ${base} and a.status <> 'cancelled'
        group by 1 order by 2 desc, 1 limit 5`)
    ).rows.map((r) => ({ date: r.d, count: n(r.cnt) }));

    // neue vs. wiederkehrende Patient:innen (nur Anzahlen)
    const [pat] = (
      await tx.execute<{ total: number; new: number }>(sql`
        with p as (
          select distinct a.patient_id from appointments a
          where ${base} and a.status <> 'cancelled' and a.patient_id is not null
        ), f as (
          select least(
                   (select min(a2.starts_at) from appointments a2
                     where a2.organization_id = ${org} and a2.patient_id = p.patient_id and a2.status <> 'cancelled'),
                   (select min(t.treated_at) from treatment_records t
                     where t.organization_id = ${org} and t.patient_id = p.patient_id)
                 ) as first_at
          from p
        )
        select count(*)::int as total, count(*) filter (where first_at >= ${fromTs})::int as new from f`)
    ).rows;

    return {
      total: n(tot?.total),
      cancelled: n(tot?.cancelled),
      noShow: n(tot?.no_show),
      done: n(tot?.done),
      booked: n(tot?.booked),
      online: n(tot?.online),
      bySource,
      slots,
      weekdayCounts,
      weekdayLead,
      weekdayOccurrences: weekdayOccurrences(period.from, period.until),
      leadMedian,
      leadCount,
      topDates,
      patients: { total: n(pat?.total), new: n(pat?.new), returning: n(pat?.total) - n(pat?.new) },
    };
  });
}

export type SalesStats = Awaited<ReturnType<typeof salesStats>>;

/**
 * Leistungen, Produkte, Lager und Umsatz im Zeitraum.
 * - Leistungen/Produkte: Rechnungspositionen nach Rechnungsdatum mit derselben Belegauswahl wie financeOverview
 *   (ohne Entwürfe/Stornos/Gutschriften/Anzahlungen, ohne auf eine Sammelrechnung angerechnete Quittungen)
 * - Umsatz je Wochentag/Monat: Zahlungseingänge (Zuflussprinzip) wie financeOverview – Anrechnungen erzeugen keinen
 *   Zahlungseingang, daher keine Doppelzählung
 */
export async function salesStats(auth: AuthContext, period: Period) {
  const org = auth.organization.id;
  const { fromTs, toTs } = periodBounds(period);
  const issued = sql`i.issued_at >= ${period.from} and i.issued_at <= ${period.until}`;

  return withOrg(org, async (tx) => {
    const billed = (
      await tx.execute<{ id: string | null; name: string; qty: number; total: number }>(sql`
        select l.service_id as id, coalesce(s.name, 'Freitext / sonstige') as name,
               coalesce(sum(l.quantity), 0)::float as qty, coalesce(sum(l.total_cents), 0)::bigint as total
        from invoice_lines l
        join invoices i on i.id = l.invoice_id
        left join services s on s.id = l.service_id
        where l.organization_id = ${org} and i.organization_id = ${org} and l.line_kind = 'service'
          and ${countedInvoiceSql} and ${issued}
        group by 1, 2`)
    ).rows;

    // in Terminen gebuchte Leistungen (ohne Absagen) – Nachfrage unabhängig von der Abrechnung
    const booked = (
      await tx.execute<{ id: string; name: string; qty: number }>(sql`
        select s.id, s.name, coalesce(sum(x.quantity), 0)::float as qty
        from appointment_services x
        join appointments a on a.id = x.appointment_id
        join services s on s.id = x.service_id
        where x.organization_id = ${org} and a.organization_id = ${org} and a.status <> 'cancelled'
          and a.starts_at >= ${fromTs} and a.starts_at < ${toTs}
        group by 1, 2`)
    ).rows;

    const svc = new Map<string, { name: string; quantity: number; totalCents: number; bookedCount: number }>();
    for (const r of billed) svc.set(r.id ?? "-", { name: r.name, quantity: n(r.qty), totalCents: n(r.total), bookedCount: 0 });
    for (const r of booked) {
      const cur = svc.get(r.id) ?? { name: r.name, quantity: 0, totalCents: 0, bookedCount: 0 };
      cur.bookedCount = n(r.qty);
      svc.set(r.id, cur);
    }
    const services = [...svc.values()].sort((a, b) => b.totalCents - a.totalCents || b.quantity - a.quantity || a.name.localeCompare(b.name, "de"));

    const products = (
      await tx.execute<{ name: string; sold_qty: number; sold_total: number; used_qty: number; used_total: number }>(sql`
        select coalesce(pr.name, 'Freitext / sonstige') as name,
               coalesce(sum(l.quantity) filter (where not l.in_treatment), 0)::float as sold_qty,
               coalesce(sum(l.total_cents) filter (where not l.in_treatment), 0)::bigint as sold_total,
               coalesce(sum(l.quantity) filter (where l.in_treatment), 0)::float as used_qty,
               coalesce(sum(l.total_cents) filter (where l.in_treatment), 0)::bigint as used_total
        from invoice_lines l
        join invoices i on i.id = l.invoice_id
        left join products pr on pr.id = l.product_id
        where l.organization_id = ${org} and i.organization_id = ${org} and l.line_kind = 'product'
          and ${countedInvoiceSql} and ${issued}
        group by l.product_id, pr.name`)
    ).rows
      .map((r) => ({ name: r.name, soldQty: n(r.sold_qty), soldCents: n(r.sold_total), usedQty: n(r.used_qty), usedCents: n(r.used_total) }))
      .sort((a, b) => b.soldCents + b.usedCents - (a.soldCents + a.usedCents) || a.name.localeCompare(b.name, "de"));

    // Lager: Bestand heute und Abgang (Verkauf abzgl. Storno, Eigenverbrauch, Bruch) im Zeitraum
    const stock = (
      await tx.execute<{ name: string; unit: string; min_stock: number; stock: number; outflow: number }>(sql`
        select pr.name, pr.unit, pr.min_stock,
               coalesce((select sum(m.quantity) from stock_movements m where m.organization_id = ${org} and m.product_id = pr.id), 0)::int as stock,
               coalesce((select -sum(m.quantity) from stock_movements m
                          where m.organization_id = ${org} and m.product_id = pr.id
                            and m.kind in ('sale', 'storno', 'own_use', 'breakage')
                            and m.occurred_on >= ${period.from} and m.occurred_on <= ${period.until}), 0)::int as outflow
        from products pr
        where pr.organization_id = ${org} and pr.track_stock and pr.active
        order by pr.name`)
    ).rows.map((r) => {
      const item = { name: r.name, unit: r.unit, minStock: n(r.min_stock), stock: n(r.stock), outflow: Math.max(0, n(r.outflow)) };
      return { ...item, ...stockCoverage(item.stock, item.outflow, period.days), reorder: isBelowMinimum({ trackStock: true, active: true, ...item }) };
    });
    stock.sort((a, b) => Number(b.reorder) - Number(a.reorder) || (a.coverageDays ?? Infinity) - (b.coverageDays ?? Infinity) || a.name.localeCompare(b.name, "de"));

    const revRows = (
      await tx.execute<{ isodow: number; ym: string; v: number }>(sql`
        select extract(isodow from (p.paid_at at time zone 'Europe/Berlin'))::int as isodow,
               to_char(p.paid_at at time zone 'Europe/Berlin', 'YYYY-MM') as ym,
               coalesce(sum(p.amount_cents), 0)::bigint as v
        from payments p
        where p.organization_id = ${org} and p.paid_at >= ${fromTs} and p.paid_at < ${toTs}
        group by 1, 2`)
    ).rows;
    const revenueWeekdays = [0, 0, 0, 0, 0, 0, 0];
    const months = monthsOf({ from: period.from, to: period.until });
    const revenueMonths = months.map(() => 0);
    for (const r of revRows) {
      revenueWeekdays[n(r.isodow) - 1] += n(r.v);
      const i = months.indexOf(r.ym);
      if (i >= 0) revenueMonths[i] += n(r.v);
    }

    return {
      services,
      products,
      stock,
      revenueTotal: revenueWeekdays.reduce((s, v) => s + v, 0),
      revenueWeekdays,
      months,
      revenueMonths,
      weekdayOccurrences: weekdayOccurrences(period.from, period.until),
    };
  });
}
