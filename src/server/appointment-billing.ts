import "server-only";
import { and, asc, eq, gte, inArray, isNull, lt, ne, notInArray, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { appointmentServices, appointments, invoiceLines, invoices, patients, services, treatmentRecords } from "@/db/schema";
import { assertCan } from "@/lib/auth/assert";
import type { AuthContext } from "@/lib/auth/session";
import { isPrivateOnly } from "@/lib/features";
import { berlinDateIso, berlinToUtc, dateDe, fullName } from "@/lib/format";
import { estimateCents, type UnbilledLine } from "@/lib/year-end";
import { openDepositsFor, openReceiptsFor } from "./invoices";

/**
 * Abrechnung direkt aus Termin bzw. Behandlung (Doku-Eintrag) und die Sammelrechnung zum Jahresende.
 *
 * „Abrechenbar“ sind Doku-Einträge und vergangene, nicht abgesagte Termine ohne Doku-Eintrag (dieselbe Zählung wie
 * in der Auswertung) – ohne Kassenleistungen auf Verordnung (die laufen über die GKV-Abrechnung; bei „nur Privat“
 * gibt es keine Verordnungen). „Abgerechnet“ ist eine Leistung, wenn eine ausgestellte, nicht stornierte Rechnung
 * (keine Anzahlung) eine Position mit diesem Doku-Eintrag bzw. Termin hat – oder (Altbestand ohne Bezug) wenn für die
 * Person am selben Tag eine eigene Rechnung/Quittung ausgestellt wurde. createInvoice prüft verbindlich.
 * Es werden nur Datum, Termin und Leistungen gelesen – keine medizinischen Inhalte.
 */

type Item = { patientId: string; at: Date; recordId: string | null; appointmentId: string | null; title: string | null };
type Svc = { appointmentId: string; serviceId: string; name: string; priceCents: number; vatRate: number; quantity: number };

const BILLED_STATUS_EXCLUDED = ["cancelled", "draft"] as const;

async function servicesOf(tx: Tx, org: string, apptIds: string[]) {
  const rows = apptIds.length
    ? await tx
        .select({ appointmentId: appointmentServices.appointmentId, serviceId: services.id, name: services.name, priceCents: services.priceCents, vatRate: services.vatRate, quantity: appointmentServices.quantity })
        .from(appointmentServices)
        .innerJoin(services, eq(services.id, appointmentServices.serviceId))
        .where(and(eq(appointmentServices.organizationId, org), inArray(appointmentServices.appointmentId, apptIds)))
    : [];
  const map = new Map<string, Svc[]>();
  for (const r of rows) map.set(r.appointmentId, [...(map.get(r.appointmentId) ?? []), { ...r, quantity: Number(r.quantity) || 1 }]);
  return map;
}

/** Positionen zu einer Leistung: je Leistung des Termins (Katalogpreis), sonst Freitext ohne Preis. */
function linesFor(item: Item, svc: Map<string, Svc[]>, withDate: boolean): UnbilledLine[] {
  const prefix = withDate ? `${dateDe(item.at)}: ` : "";
  const ref = { treatmentRecordId: item.recordId, appointmentId: item.appointmentId };
  const list = item.appointmentId ? (svc.get(item.appointmentId) ?? []) : [];
  if (list.length) return list.map((s) => ({ ...ref, serviceId: s.serviceId, description: `${prefix}${s.name}`, quantity: s.quantity, unitPriceCents: s.priceCents, vatRate: s.vatRate }));
  return [{ ...ref, serviceId: null, description: `${prefix}${item.title?.trim() || "Podologische Behandlung"}`, quantity: 1, unitPriceCents: null, vatRate: 0 }];
}

/**
 * Nicht abgerechnete Leistungen im Zeitraum (je Person, nach Datum sortiert).
 * `patientIds` schränkt auf Personen ein; `includePrescriptions` = Verordnungs-Leistungen mitnehmen (nur Privat-Praxis).
 */
async function unbilledItems(tx: Tx, org: string, opts: { from: Date; to: Date; patientIds?: string[]; includePrescriptions: boolean; now: Date }) {
  const to = opts.to < opts.now ? opts.to : opts.now;
  const byPatient = (col: Parameters<typeof inArray>[0]) => (opts.patientIds ? [inArray(col, opts.patientIds)] : []);
  const recsAll = await tx
    .select({ id: treatmentRecords.id, patientId: treatmentRecords.patientId, treatedAt: treatmentRecords.treatedAt, appointmentId: treatmentRecords.appointmentId, prescriptionId: treatmentRecords.prescriptionId })
    .from(treatmentRecords)
    .where(and(eq(treatmentRecords.organizationId, org), gte(treatmentRecords.treatedAt, opts.from), lt(treatmentRecords.treatedAt, opts.to), ...byPatient(treatmentRecords.patientId)))
    .orderBy(asc(treatmentRecords.treatedAt));
  const apptsAll = await tx
    .select({ id: appointments.id, patientId: appointments.patientId, startsAt: appointments.startsAt, title: appointments.title, prescriptionId: appointments.prescriptionId })
    .from(appointments)
    .where(
      and(
        eq(appointments.organizationId, org),
        gte(appointments.startsAt, opts.from),
        lt(appointments.startsAt, to),
        inArray(appointments.status, ["planned", "confirmed", "done"]),
        ...byPatient(appointments.patientId),
      ),
    )
    .orderBy(asc(appointments.startsAt));
  // Termine mit Doku-Eintrag (verknüpft oder am selben Tag) zählen über den Doku-Eintrag
  const apptIdsAll = apptsAll.map((a) => a.id);
  const linked = apptIdsAll.length
    ? await tx.select({ appointmentId: treatmentRecords.appointmentId }).from(treatmentRecords).where(and(eq(treatmentRecords.organizationId, org), inArray(treatmentRecords.appointmentId, apptIdsAll)))
    : [];
  const linkedSet = new Set(linked.map((l) => l.appointmentId));
  const recDays = new Set(recsAll.map((r) => `${r.patientId}|${berlinDateIso(r.treatedAt)}`));
  const recs = recsAll.filter((r) => opts.includePrescriptions || !r.prescriptionId);
  const appts = apptsAll.filter(
    (a): a is typeof a & { patientId: string } =>
      !!a.patientId && (opts.includePrescriptions || !a.prescriptionId) && !linkedSet.has(a.id) && !recDays.has(`${a.patientId}|${berlinDateIso(a.startsAt)}`),
  );

  // exakt abgerechnet (Position mit Doku-/Terminbezug; Anzahlungen zählen nicht)
  const recIds = recs.map((r) => r.id);
  const recApptIds = recs.map((r) => r.appointmentId).filter((x): x is string => !!x);
  const apptIds = [...new Set([...appts.map((a) => a.id), ...recApptIds])];
  const conds: SQL[] = [];
  if (recIds.length) conds.push(inArray(invoiceLines.treatmentRecordId, recIds));
  if (apptIds.length) conds.push(inArray(invoiceLines.appointmentId, apptIds));
  const billedRows = conds.length
    ? await tx
        .select({ recordId: invoiceLines.treatmentRecordId, appointmentId: invoiceLines.appointmentId })
        .from(invoiceLines)
        .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
        .where(and(eq(invoiceLines.organizationId, org), or(...conds), notInArray(invoices.status, [...BILLED_STATUS_EXCLUDED]), ne(invoices.kind, "deposit")))
    : [];
  const billedRecs = new Set(billedRows.map((b) => b.recordId).filter(Boolean));
  const billedAppts = new Set(billedRows.map((b) => b.appointmentId).filter(Boolean));
  // Altbestand ohne Bezug: eigene Rechnung/Quittung der Person am selben Tag
  const pids = [...new Set([...recs.map((r) => r.patientId), ...appts.map((a) => a.patientId)])];
  const own = pids.length
    ? await tx
        .select({ patientId: invoices.patientId, issuedAt: invoices.issuedAt })
        .from(invoices)
        .where(
          and(
            eq(invoices.organizationId, org),
            inArray(invoices.patientId, pids),
            notInArray(invoices.status, [...BILLED_STATUS_EXCLUDED]),
            notInArray(invoices.kind, ["credit_note", "collective", "deposit"]),
          ),
        )
    : [];
  const ownDays = new Set(own.filter((o) => o.issuedAt).map((o) => `${o.patientId}|${o.issuedAt}`));

  const items: Item[] = [];
  let skipped = 0;
  for (const r of recs) {
    if (billedRecs.has(r.id) || (r.appointmentId && billedAppts.has(r.appointmentId)) || ownDays.has(`${r.patientId}|${berlinDateIso(r.treatedAt)}`)) {
      skipped++;
      continue;
    }
    items.push({ patientId: r.patientId, at: r.treatedAt, recordId: r.id, appointmentId: r.appointmentId, title: null });
  }
  for (const a of appts) {
    if (billedAppts.has(a.id) || ownDays.has(`${a.patientId}|${berlinDateIso(a.startsAt)}`)) {
      skipped++;
      continue;
    }
    items.push({ patientId: a.patientId, at: a.startsAt, recordId: null, appointmentId: a.id, title: a.title });
  }
  items.sort((x, y) => x.at.getTime() - y.at.getTime());
  // Titel der verknüpften Termine für Doku-Einträge ohne Leistungen
  const recAppt = items.filter((i) => i.recordId && i.appointmentId).map((i) => i.appointmentId!);
  if (recAppt.length) {
    const titles = await tx.select({ id: appointments.id, title: appointments.title }).from(appointments).where(and(eq(appointments.organizationId, org), inArray(appointments.id, recAppt)));
    const t = new Map(titles.map((x) => [x.id, x.title]));
    for (const i of items) if (i.recordId && i.appointmentId) i.title = t.get(i.appointmentId) ?? null;
  }
  const svc = await servicesOf(tx, org, [...new Set(items.map((i) => i.appointmentId).filter((x): x is string => !!x))]);
  return { items, svc, skipped };
}

const yearRange = (year: number) => ({ from: berlinToUtc(`${year}-01-01`, "00:00"), to: berlinToUtc(`${year + 1}-01-01`, "00:00") });

// ───────────── Rechnung / Quittung aus Termin oder Behandlung ─────────────

export type BillingSource = { appointmentId?: string | null; recordId?: string | null };

/**
 * Vorlage für Rechnung bzw. Anzahlungs-Quittung aus einem Termin oder Doku-Eintrag: Person, Positionen (Leistungen
 * des Termins), Verordnungsbezug und bereits vorhandene Belege zu dieser Leistung.
 */
export async function billingFromSource(auth: AuthContext, src: BillingSource) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  const uuid = z.uuid();
  const apptIn = src.appointmentId && uuid.safeParse(src.appointmentId).success ? src.appointmentId : null;
  const recIn = src.recordId && uuid.safeParse(src.recordId).success ? src.recordId : null;
  if (!apptIn && !recIn) return null;
  const privateOnly = isPrivateOnly(auth.organization);
  return withOrg(org, async (tx) => {
    let record: { id: string; patientId: string; treatedAt: Date; appointmentId: string | null; prescriptionId: string | null } | null = null;
    if (recIn) {
      const [r] = await tx
        .select({ id: treatmentRecords.id, patientId: treatmentRecords.patientId, treatedAt: treatmentRecords.treatedAt, appointmentId: treatmentRecords.appointmentId, prescriptionId: treatmentRecords.prescriptionId })
        .from(treatmentRecords)
        .where(and(eq(treatmentRecords.organizationId, org), eq(treatmentRecords.id, recIn)));
      if (!r) return null;
      record = r;
    }
    const apptId = apptIn ?? record?.appointmentId ?? null;
    const [appt] = apptId
      ? await tx
          .select({ id: appointments.id, patientId: appointments.patientId, startsAt: appointments.startsAt, title: appointments.title, prescriptionId: appointments.prescriptionId, status: appointments.status })
          .from(appointments)
          .where(and(eq(appointments.organizationId, org), eq(appointments.id, apptId)))
      : [];
    if (apptIn && !appt) return null;
    if (!record && appt) {
      const [r] = await tx
        .select({ id: treatmentRecords.id, patientId: treatmentRecords.patientId, treatedAt: treatmentRecords.treatedAt, appointmentId: treatmentRecords.appointmentId, prescriptionId: treatmentRecords.prescriptionId })
        .from(treatmentRecords)
        .where(and(eq(treatmentRecords.organizationId, org), eq(treatmentRecords.appointmentId, appt.id)))
        .orderBy(asc(treatmentRecords.treatedAt))
        .limit(1);
      record = r ?? null;
    }
    const patientId = record?.patientId ?? appt?.patientId ?? null;
    if (!patientId) return { patient: null, error: "Diesem Termin ist keine Patient:in zugeordnet." } as const;
    const [p] = await tx
      .select({ id: patients.id, number: patients.number, firstName: patients.firstName, lastName: patients.lastName, insuranceType: patients.insuranceType })
      .from(patients)
      .where(and(eq(patients.organizationId, org), eq(patients.id, patientId)));
    if (!p) return null;
    const at = record?.treatedAt ?? appt!.startsAt;
    const item: Item = { patientId, at, recordId: record?.id ?? null, appointmentId: appt?.id ?? null, title: appt?.title ?? null };
    const svc = await servicesOf(tx, org, item.appointmentId ? [item.appointmentId] : []);
    const lines = linesFor(item, svc, true);

    // vorhandene Belege zu dieser Leistung (inkl. Anzahlungen)
    const conds: SQL[] = [];
    if (item.recordId) conds.push(eq(invoiceLines.treatmentRecordId, item.recordId));
    if (item.appointmentId) conds.push(eq(invoiceLines.appointmentId, item.appointmentId));
    const docs = await tx
      .selectDistinct({ id: invoices.id, number: invoices.number, kind: invoices.kind, status: invoices.status, totalCents: invoices.totalCents, issuedAt: invoices.issuedAt, collectiveInvoiceId: invoices.collectiveInvoiceId })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(and(eq(invoiceLines.organizationId, org), or(...conds), ne(invoices.status, "draft")))
      .orderBy(asc(invoices.issuedAt));
    const billedBy = docs.filter((d) => d.kind !== "deposit" && d.status !== "cancelled");
    return {
      patient: { ...p, name: fullName(p) },
      appointmentId: item.appointmentId,
      recordId: item.recordId,
      at,
      lines,
      estimateCents: estimateCents(lines),
      /** Kassenleistung auf Verordnung (Abrechnung über die Krankenkasse) – bei „nur Privat“ nie */
      prescription: !privateOnly && !!(record?.prescriptionId || appt?.prescriptionId),
      documents: docs,
      billedBy,
      error: null,
    } as const;
  });
}

// ───────────── Sammelrechnung je Patient:in (Jahr) ─────────────

/**
 * Vorschlag für die Sammelrechnung einer Person über ein Jahr: alle noch nicht abgerechneten Leistungen als
 * Positionen (mit Datum), die offenen Anzahlungen und die offenen normalen Quittungen des Jahres (Teilrechnungen),
 * die angerechnet werden – deren Leistungen übernimmt das Formular als Positionen.
 */
export async function patientYearSuggestion(auth: AuthContext, patientId: string, year: number) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  if (!z.uuid().safeParse(patientId).success) return null;
  const { from, to } = yearRange(year);
  return withOrg(org, async (tx) => {
    const [p] = await tx
      .select({ id: patients.id, number: patients.number, firstName: patients.firstName, lastName: patients.lastName, billingContactId: patients.billingContactId })
      .from(patients)
      .where(and(eq(patients.organizationId, org), eq(patients.id, patientId)));
    if (!p) return null;
    const { items, svc, skipped } = await unbilledItems(tx, org, { from, to, patientIds: [patientId], includePrescriptions: isPrivateOnly(auth.organization), now: new Date() });
    const lines = items.flatMap((i) => linesFor(i, svc, true));
    const deposits = await openDepositsFor(tx, org, patientId);
    const receipts = await openReceiptsFor(tx, org, patientId, year);
    return { patient: { ...p, name: fullName(p) }, year, lines, items: items.length, skipped, deposits, receipts };
  });
}

export type CollectiveOverviewRow = {
  patientId: string;
  number: number;
  name: string;
  items: number;
  firstAt: Date | null;
  lastAt: Date | null;
  estimateCents: number;
  unpricedLines: number;
  depositCount: number;
  depositCents: number;
  /** bezahlte normale Quittungen des Jahres, die noch auf keine Sammelrechnung angerechnet sind */
  receiptCount: number;
  receiptCents: number;
};

/**
 * Jahresend-Erinnerung: Für welche Personen fehlt noch die Sammelrechnung des Jahres? (nicht abgerechnete
 * Leistungen, noch nicht angerechnete Anzahlungen oder noch nicht angerechnete normale Quittungen des Jahres). Bewohner:innen, deren Rechnungen ans Pflegeheim gehen,
 * laufen über die monatliche Pflegeheim-Sammelrechnung und fehlen hier.
 */
export async function collectiveOverview(auth: AuthContext, year: number): Promise<CollectiveOverviewRow[]> {
  assertCan(auth, "invoices.read");
  const org = auth.organization.id;
  const { from, to } = yearRange(year);
  return withOrg(org, async (tx) => {
    const { items, svc } = await unbilledItems(tx, org, { from, to, includePrescriptions: isPrivateOnly(auth.organization), now: new Date() });
    const deps = await tx
      .select({ patientId: invoices.patientId, totalCents: invoices.totalCents })
      .from(invoices)
      .where(and(eq(invoices.organizationId, org), eq(invoices.kind, "deposit"), eq(invoices.status, "paid"), isNull(invoices.collectiveInvoiceId)));
    const recs = await tx
      .select({ patientId: invoices.patientId, totalCents: invoices.totalCents })
      .from(invoices)
      .where(
        and(
          eq(invoices.organizationId, org),
          eq(invoices.kind, "receipt"),
          eq(invoices.status, "paid"),
          isNull(invoices.collectiveInvoiceId),
          gte(invoices.issuedAt, `${year}-01-01`),
          lt(invoices.issuedAt, `${year + 1}-01-01`),
        ),
      );
    const pids = [
      ...new Set([...items.map((i) => i.patientId), ...[...deps, ...recs].map((d) => d.patientId).filter((x): x is string => !!x)]),
    ];
    if (!pids.length) return [];
    const people = await tx
      .select({ id: patients.id, number: patients.number, firstName: patients.firstName, lastName: patients.lastName, careHomeId: patients.careHomeId, billingContactId: patients.billingContactId })
      .from(patients)
      .where(and(eq(patients.organizationId, org), inArray(patients.id, pids)));
    const rows: CollectiveOverviewRow[] = [];
    for (const p of people) {
      if (p.careHomeId && p.billingContactId === p.careHomeId) continue;
      const mine = items.filter((i) => i.patientId === p.id);
      const lines = mine.flatMap((i) => linesFor(i, svc, false));
      const d = deps.filter((x) => x.patientId === p.id);
      const q = recs.filter((x) => x.patientId === p.id);
      rows.push({
        patientId: p.id,
        number: p.number,
        name: [p.lastName, p.firstName].filter(Boolean).join(", "),
        items: mine.length,
        firstAt: mine[0]?.at ?? null,
        lastAt: mine.at(-1)?.at ?? null,
        estimateCents: estimateCents(lines),
        unpricedLines: lines.filter((l) => l.unitPriceCents === null).length,
        depositCount: d.length,
        depositCents: d.reduce((s, x) => s + x.totalCents, 0),
        receiptCount: q.length,
        receiptCents: q.reduce((s, x) => s + x.totalCents, 0),
      });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name, "de"));
  });
}

// ───────────── Anzahlung (Vorauszahlung) ohne Termin ─────────────

/**
 * Person für eine Anzahlung ohne Termin (Vorauszahlung, z. B. Nagelspange). Ausgewählt wird über die Live-Patientensuche
 * (/api/patienten/vorschlaege); hier nur die gewählte Person laden – Praxis der Sitzung (RLS), nicht archiviert, keine
 * gelöschten Kontaktdaten. Sonst null.
 */
export async function depositPatient(auth: AuthContext, patientId: string | null | undefined) {
  assertCan(auth, "invoices.write");
  if (!patientId || !z.uuid().safeParse(patientId).success) return null;
  const org = auth.organization.id;
  return withOrg(org, async (tx) => {
    const [p] = await tx
      .select({ id: patients.id, number: patients.number, firstName: patients.firstName, lastName: patients.lastName })
      .from(patients)
      .where(and(eq(patients.organizationId, org), eq(patients.id, patientId), isNull(patients.archivedAt), isNull(patients.contactErasedAt)));
    return p ? { id: p.id, number: p.number, name: fullName(p) } : null;
  });
}
