import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import {
  cashClosings,
  cashMovements,
  invoiceLines,
  invoices,
  organizations,
  payments,
  users,
  vouchers,
  type CashClosingTotals,
  type CashClosingTse,
} from "@/db/schema";
import { fiscalIsTestMode, getFiscalPort } from "@/integrations/tse";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/assert";
import type { AuthContext } from "@/lib/auth/session";
import { berlinDateIso, berlinToUtc } from "@/lib/format";
import { addDaysIso } from "@/lib/invoice-math";
import { buildDsfinvkZip, type DsfinvkClosing, type DsfinvkRegister } from "@/lib/kasse/dsfinvk";
import {
  buildBons,
  closingHashContent,
  computeClosing,
  itemsDigest,
  MOVEMENT_KINDS,
  MOVEMENT_SIGN,
  normalizeDenominations,
  parseTseRef,
  type KasseMethod,
  type KasseMovement,
  type KassePayment,
  type MovementKind,
} from "@/lib/kasse/model";
import { renderZBonPdf } from "@/lib/kasse/zbon-pdf";
import { chainHash } from "@/lib/records";

export class KasseError extends Error {}

export const NO_TSE_NOTE = "ohne TSE – nur zulässig, wenn keine elektronische Kasse im Sinne der KassenSichV";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum ungültig");
const optText = (max: number) => z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(max).nullable().optional());

export const movementInput = z.object({
  kind: z.enum(MOVEMENT_KINDS),
  /** Betrag immer positiv – das Vorzeichen ergibt sich aus der Art */
  amountCents: z.number().int().min(1, "Betrag fehlt").max(10_000_000, "Betrag zu hoch"),
  reason: z.string().trim().min(3, "Bitte einen Grund angeben").max(300),
});
export type MovementInput = z.infer<typeof movementInput>;

export const closingInput = z.object({
  businessDate: isoDate,
  denominations: z.record(z.string(), z.unknown()),
  /** nur beim allerersten Abschluss: Anfangsbestand (Wechselgeld) */
  openingCents: z.number().int().min(0).max(10_000_000).optional(),
  differenceReason: optText(300),
  note: optText(500),
});
export type ClosingInput = z.infer<typeof closingInput>;

/** Ende des Buchungstags (Europe/Berlin) als exklusive Grenze */
const dayEnd = (iso: string) => berlinToUtc(addDaysIso(iso, 1), "00:00");

function dbMessage(e: unknown): string | null {
  const err = e as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = err?.code ?? err?.cause?.code;
  const msg = err?.cause?.message ?? err?.message ?? "";
  if (code === "P0001") return msg;
  if (code === "23505") return "Für diesen Tag gibt es bereits einen Kassenabschluss.";
  return null;
}

// ───────────────────────── Laden ─────────────────────────
type ItemsFilter = { closingIds: string[] } | { openUntil: Date };

async function loadItems(tx: Tx, org: string, filter: ItemsFilter) {
  const payCond =
    "closingIds" in filter
      ? filter.closingIds.length
        ? inArray(payments.cashClosingId, filter.closingIds)
        : sql`false`
      : and(isNull(payments.cashClosingId), lte(payments.paidAt, filter.openUntil));
  const movCond =
    "closingIds" in filter
      ? filter.closingIds.length
        ? inArray(cashMovements.cashClosingId, filter.closingIds)
        : sql`false`
      : and(isNull(cashMovements.cashClosingId), lte(cashMovements.occurredAt, filter.openUntil));

  const payRows = await tx
    .select({ p: payments, invoiceNumber: invoices.number, voucherCode: vouchers.code, voucherPurpose: vouchers.purpose })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .leftJoin(vouchers, eq(vouchers.id, payments.voucherId))
    .where(and(eq(payments.organizationId, org), payCond))
    .orderBy(asc(payments.paidAt), asc(payments.id));
  const movRows = await tx
    .select()
    .from(cashMovements)
    .where(and(eq(cashMovements.organizationId, org), movCond))
    .orderBy(asc(cashMovements.occurredAt), asc(cashMovements.id));

  const invoiceIds = [...new Set(payRows.map((r) => r.p.invoiceId))];
  const vatRows = invoiceIds.length
    ? await tx
        .select({ invoiceId: invoiceLines.invoiceId, rate: invoiceLines.vatRate, gross: sql<number>`coalesce(sum(${invoiceLines.totalCents}), 0)::int` })
        .from(invoiceLines)
        .where(and(eq(invoiceLines.organizationId, org), inArray(invoiceLines.invoiceId, invoiceIds)))
        .groupBy(invoiceLines.invoiceId, invoiceLines.vatRate)
    : [];
  const sold = invoiceIds.length
    ? await tx
        .select({ invoiceId: vouchers.soldInvoiceId, code: vouchers.code, purpose: vouchers.purpose })
        .from(vouchers)
        .where(and(eq(vouchers.organizationId, org), inArray(vouchers.soldInvoiceId, invoiceIds)))
    : [];
  const userIds = [...new Set([...payRows.map((r) => r.p.createdBy), ...movRows.map((m) => m.createdBy)].filter((x): x is string => !!x))];
  const names = userIds.length ? await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [];
  const person = (id: string | null) => (id ? { id, name: names.find((n) => n.id === id)?.name ?? "" } : null);

  const pays: (KassePayment & { closingId: string | null })[] = payRows.map((r) => ({
    id: r.p.id,
    closingId: r.p.cashClosingId,
    method: r.p.method as KasseMethod,
    amountCents: r.p.amountCents,
    paidAt: r.p.paidAt,
    invoiceNumber: r.invoiceNumber,
    vatGroups: vatRows.filter((v) => v.invoiceId === r.p.invoiceId).map((v) => ({ rate: v.rate, grossCents: Number(v.gross) })),
    voucher: r.voucherCode ? { code: r.voucherCode, purpose: r.voucherPurpose ?? "multi" } : null,
    soldVoucher: (() => {
      const s = sold.find((x) => x.invoiceId === r.p.invoiceId);
      return s ? { code: s.code, purpose: s.purpose } : null;
    })(),
    externalRef: r.p.externalRef,
    createdBy: person(r.p.createdBy),
  }));
  const movs: (KasseMovement & { closingId: string | null })[] = movRows.map((m) => ({
    id: m.id,
    closingId: m.cashClosingId,
    kind: m.kind as MovementKind,
    amountCents: m.amountCents,
    reason: m.reason,
    occurredAt: m.occurredAt,
    createdBy: person(m.createdBy),
  }));
  return { payments: pays, movements: movs };
}

async function lastClosing(tx: Tx, org: string) {
  const [row] = await tx.select().from(cashClosings).where(eq(cashClosings.organizationId, org)).orderBy(desc(cashClosings.number)).limit(1);
  return row ?? null;
}

type ClosingRow = typeof cashClosings.$inferSelect;

const contentOf = (r: ClosingRow) =>
  closingHashContent({
    id: r.id,
    organizationId: r.organizationId,
    number: r.number,
    businessDate: r.businessDate,
    closedAt: r.closedAt,
    createdAt: r.createdAt,
    openingCents: r.openingCents,
    cashPaymentsCents: r.cashPaymentsCents,
    movementsCents: r.movementsCents,
    expectedCashCents: r.expectedCashCents,
    countedCashCents: r.countedCashCents,
    differenceCents: r.differenceCents,
    denominations: r.denominations,
    totals: r.totals,
    paymentCount: r.paymentCount,
    movementCount: r.movementCount,
    firstBonNr: r.firstBonNr,
    lastBonNr: r.lastBonNr,
    itemsDigest: r.itemsDigest,
    tse: r.tse,
    differenceReason: r.differenceReason,
    note: r.note,
    createdBy: r.createdBy,
  });

/** Prüft die Hash-Kette aller Abschlüsse – Index des ersten ungültigen Eintrags, -1 wenn alles stimmt. */
export function verifyClosingRows(rows: ClosingRow[]): number {
  let prev: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.number !== i + 1 || r.prevHash !== prev || chainHash(prev, contentOf(r)) !== r.hash) return i;
    prev = r.hash;
  }
  return -1;
}

// ───────────────────────── Übersicht ─────────────────────────
export async function kasseOverview(auth: AuthContext) {
  assertCan(auth, "invoices.read");
  const org = auth.organization.id;
  const today = berlinDateIso();
  const now = new Date();
  return withOrg(org, async (tx) => {
    const last = await lastClosing(tx, org);
    const open = await loadItems(tx, org, { openUntil: now });
    const recent = await tx.select().from(cashClosings).where(eq(cashClosings.organizationId, org)).orderBy(desc(cashClosings.number)).limit(30);
    const openingCents = last ? last.countedCashCents : 0;
    const calc = computeClosing({
      zNumber: (last?.number ?? 0) + 1,
      firstBonNr: (last?.lastBonNr ?? 0) + 1,
      closedAt: now,
      openingCents,
      openingIsNew: !last,
      denominations: {},
      payments: open.payments,
      movements: open.movements,
    });
    return {
      today,
      lastClosing: last,
      closedToday: last?.businessDate === today,
      needsOpening: !last,
      openingCents,
      open,
      calc,
      recent,
      tseMode: fiscalIsTestMode() ? ("none" as const) : ("fiskaly" as const),
    };
  });
}

// ───────────────────────── Einlagen / Entnahmen ─────────────────────────
export async function addCashMovement(auth: AuthContext, input: MovementInput) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  const signed = MOVEMENT_SIGN[input.kind] * input.amountCents;
  let row: typeof cashMovements.$inferSelect;
  try {
    [row] = await withOrg(org, (tx) =>
      tx.insert(cashMovements).values({ organizationId: org, kind: input.kind, amountCents: signed, reason: input.reason, createdBy: auth.user.id }).returning(),
    );
  } catch (e) {
    const m = dbMessage(e);
    if (m) throw new KasseError(m);
    throw e;
  }
  await audit({ organizationId: org, userId: auth.user.id, action: "kasse.movement", entity: "cash_movement", entityId: row.id, meta: { kind: input.kind, amountCents: signed } });
  return row;
}

// ───────────────────────── Tagesabschluss (Z-Bon) ─────────────────────────
/**
 * Erstellt den Kassenabschluss. Pro Praxis serialisiert (Advisory-Lock) → Z-Nummer lückenlos; ein DB-Trigger prüft
 * Nummer, Hash-Kette und Datumsreihenfolge zusätzlich. Schlägt etwas fehl (auch die TSE-Meldung), wird alles
 * zurückgerollt – es entsteht keine Lücke.
 */
export async function closeDay(auth: AuthContext, input: ClosingInput) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  const today = berlinDateIso();
  if (input.businessDate > today) throw new KasseError("Ein Tag in der Zukunft kann nicht abgeschlossen werden.");
  let denominations: Record<string, number>;
  try {
    denominations = normalizeDenominations(input.denominations);
  } catch (e) {
    throw new KasseError(e instanceof Error ? e.message : "Zählprotokoll ungültig.");
  }

  let created: ClosingRow;
  try {
    created = await withOrg(org, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cash-closing:${org}`}))`);
      const prev = await lastClosing(tx, org);
      if (prev && input.businessDate <= prev.businessDate) {
        throw new KasseError(prev.businessDate === input.businessDate ? "Dieser Tag ist bereits abgeschlossen." : "Der Buchungstag liegt vor dem letzten Abschluss.");
      }
      const now = new Date();
      const end = dayEnd(input.businessDate);
      const closedAt = end.getTime() <= now.getTime() ? new Date(end.getTime() - 1) : now;
      const items = await loadItems(tx, org, { openUntil: closedAt });
      const number = (prev?.number ?? 0) + 1;
      const firstBonNr = (prev?.lastBonNr ?? 0) + 1;
      const openingCents = prev ? prev.countedCashCents : (input.openingCents ?? 0);
      const operator = { id: auth.user.id, name: auth.user.name };
      const calc = computeClosing({
        zNumber: number,
        firstBonNr,
        closedAt,
        openingCents,
        openingIsNew: !prev,
        denominations,
        differenceReason: input.differenceReason ?? null,
        payments: items.payments,
        movements: items.movements,
        operator,
      });
      if (calc.differenceCents !== 0 && !input.differenceReason) throw new KasseError("Bei einer Kassendifferenz ist eine Begründung Pflicht.");

      const id = randomUUID();
      const tse = await closingTse(id, number, input.businessDate, calc, items.payments);
      const totals: CashClosingTotals = calc.totals;
      const createdAt = new Date();
      const values = {
        id,
        organizationId: org,
        number,
        businessDate: input.businessDate,
        closedAt,
        createdAt,
        openingCents,
        cashPaymentsCents: calc.cashPaymentsCents,
        movementsCents: calc.movementsCents,
        expectedCashCents: calc.expectedCashCents,
        countedCashCents: calc.countedCashCents,
        differenceCents: calc.differenceCents,
        denominations,
        totals,
        paymentCount: items.payments.length,
        movementCount: items.movements.length,
        firstBonNr,
        lastBonNr: calc.lastBonNr,
        itemsDigest: calc.itemsDigest,
        tse,
        differenceReason: input.differenceReason ?? null,
        note: input.note ?? null,
        createdBy: auth.user.id,
      };
      const prevHash = prev?.hash ?? null;
      const hash = chainHash(prevHash, closingHashContent(values));
      const [row] = await tx.insert(cashClosings).values({ ...values, prevHash, hash }).returning();
      const payIds = items.payments.map((p) => p.id);
      const movIds = items.movements.map((m) => m.id);
      if (payIds.length) {
        const upd = await tx
          .update(payments)
          .set({ cashClosingId: id })
          .where(and(eq(payments.organizationId, org), inArray(payments.id, payIds), isNull(payments.cashClosingId)))
          .returning({ id: payments.id });
        if (upd.length !== payIds.length) throw new KasseError("Zahlungen haben sich während des Abschlusses geändert. Bitte erneut versuchen.");
      }
      if (movIds.length) {
        const upd = await tx
          .update(cashMovements)
          .set({ cashClosingId: id })
          .where(and(eq(cashMovements.organizationId, org), inArray(cashMovements.id, movIds), isNull(cashMovements.cashClosingId)))
          .returning({ id: cashMovements.id });
        if (upd.length !== movIds.length) throw new KasseError("Kassenbuch hat sich während des Abschlusses geändert. Bitte erneut versuchen.");
      }
      return row;
    });
  } catch (e) {
    if (e instanceof KasseError) throw e;
    const m = dbMessage(e);
    if (m) throw new KasseError(m);
    throw e;
  }
  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: "kasse.close",
    entity: "cash_closing",
    entityId: created.id,
    meta: { number: created.number, businessDate: created.businessDate, differenceCents: created.differenceCents, tse: created.tse.mode },
  });
  return created;
}

async function closingTse(closingId: string, number: number, businessDate: string, calc: ReturnType<typeof computeClosing>, pays: KassePayment[]): Promise<CashClosingTse> {
  const refs = pays.map((p) => parseTseRef(p.externalRef)).filter((r): r is NonNullable<typeof r> => !!r);
  if (fiscalIsTestMode()) {
    return { mode: "none", testSignatures: refs.some((r) => r.isTest), tssSerial: null, transactionNumber: null, signatureCounter: null, exportRef: null, note: NO_TSE_NOTE };
  }
  const port = getFiscalPort();
  if (!port.registerCashPointClosing) throw new KasseError("Der TSE-Anbieter unterstützt keine Kassenabschlüsse.");
  const payMap = new Map<string, { type: "Bar" | "Unbar"; name: string; amountCents: number }>();
  for (const b of calc.bons)
    for (const p of b.payments) {
      const k = `${p.typ}|${p.name}`;
      const e = payMap.get(k) ?? { type: p.typ, name: p.name, amountCents: 0 };
      e.amountCents += p.amountCents;
      payMap.set(k, e);
    }
  try {
    const r = await port.registerCashPointClosing({ closingId, number, businessDate, payments: [...payMap.values()], businessCases: calc.totals.businessCases });
    const real = refs.filter((x) => !x.isTest);
    const lastRef = real[real.length - 1];
    return {
      mode: "fiskaly",
      testSignatures: refs.some((x) => x.isTest),
      tssSerial: r.tssSerial ?? lastRef?.serial ?? null,
      transactionNumber: lastRef?.number ?? null,
      signatureCounter: lastRef?.signatureCounter ?? null,
      exportRef: r.closingRef,
      note: null,
    };
  } catch (e) {
    throw new KasseError(`Kassenabschluss konnte nicht an die TSE gemeldet werden: ${e instanceof Error ? e.message : "unbekannter Fehler"}`.slice(0, 300));
  }
}

// ───────────────────────── Anzeige / PDF ─────────────────────────
async function loadClosing(tx: Tx, org: string, id: string) {
  const [row] = await tx.select().from(cashClosings).where(and(eq(cashClosings.organizationId, org), eq(cashClosings.id, id)));
  if (!row) return null;
  const items = await loadItems(tx, org, { closingIds: [row.id] });
  const chain = await tx.select().from(cashClosings).where(and(eq(cashClosings.organizationId, org), lte(cashClosings.number, row.number))).orderBy(asc(cashClosings.number));
  const [o] = await tx.select().from(organizations).where(eq(organizations.id, org));
  const [creator] = row.createdBy ? await tx.select({ name: users.name }).from(users).where(eq(users.id, row.createdBy)) : [];
  const bons = rebuildBons(row, items, creator ? { id: row.createdBy!, name: creator.name } : null);
  return {
    closing: row,
    organization: o,
    createdByName: creator?.name ?? null,
    payments: items.payments,
    movements: items.movements,
    bons,
    chainOk: verifyClosingRows(chain) === -1,
    digestOk: itemsDigest(items.payments, items.movements) === row.itemsDigest,
  };
}

function rebuildBons(row: ClosingRow, items: { payments: KassePayment[]; movements: KasseMovement[] }, operator: { id: string; name: string } | null) {
  return buildBons({
    zNumber: row.number,
    firstBonNr: row.firstBonNr,
    closedAt: row.closedAt,
    openingCents: row.openingCents,
    openingIsNew: row.number === 1,
    differenceCents: row.differenceCents,
    differenceReason: row.differenceReason,
    payments: items.payments,
    movements: items.movements,
    operator,
  });
}

export async function getClosing(auth: AuthContext, id: string) {
  assertCan(auth, "invoices.read");
  return withOrg(auth.organization.id, (tx) => loadClosing(tx, auth.organization.id, id));
}

export async function zBonPdfForOrg(org: string, id: string) {
  const data = await withOrg(org, (tx) => loadClosing(tx, org, id));
  if (!data) return null;
  const bytes = await renderZBonPdf({
    closing: data.closing,
    organization: data.organization,
    createdByName: data.createdByName,
    registerId: registerOf(data.organization).kasseId,
    chainOk: data.chainOk && data.digestOk,
  });
  return { bytes, filename: `Z-Bon-${data.closing.number}-${data.closing.businessDate}.pdf` };
}

// ───────────────────────── DSFinV-K ─────────────────────────
function registerOf(o: typeof organizations.$inferSelect): DsfinvkRegister {
  const k = (o.settings?.kasse ?? {}) as { kasseId?: unknown; serial?: unknown };
  const fallback = `PODOCRM-${o.slug}`.slice(0, 50);
  const kasseId = typeof k.kasseId === "string" && k.kasseId.trim() ? k.kasseId.trim().slice(0, 50) : fallback;
  return {
    kasseId,
    brand: "PodoCRM",
    model: "PodoCRM Cloud-Kasse",
    serial: typeof k.serial === "string" && k.serial.trim() ? k.serial.trim().slice(0, 70) : `${kasseId}-${o.id.slice(0, 8)}`,
    swBrand: "PodoCRM",
    swVersion: process.env.APP_VERSION?.slice(0, 50) || "0.1.0",
  };
}

export const exportRangeInput = z
  .object({ from: isoDate, to: isoDate })
  .refine((r) => r.from <= r.to, "„Von“ liegt nach „Bis“.")
  .refine((r) => (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 <= 3 * 366, "Zeitraum höchstens drei Jahre.");

export async function buildDsfinvkExport(auth: AuthContext, from: string, to: string) {
  assertCan(auth, "invoices.read");
  const org = auth.organization.id;
  const data = await withOrg(org, async (tx) => {
    const [o] = await tx.select().from(organizations).where(eq(organizations.id, org));
    const rows = await tx
      .select()
      .from(cashClosings)
      .where(and(eq(cashClosings.organizationId, org), gte(cashClosings.businessDate, from), lte(cashClosings.businessDate, to)))
      .orderBy(asc(cashClosings.number));
    const items = await loadItems(tx, org, { closingIds: rows.map((r) => r.id) });
    const creatorIds = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => !!x))];
    const creators = creatorIds.length ? await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, creatorIds)) : [];
    return { o, rows, items, creators };
  });
  const closings: DsfinvkClosing[] = data.rows.map((row) => {
    const pays = data.items.payments.filter((p) => p.closingId === row.id);
    const movs = data.items.movements.filter((m) => m.closingId === row.id);
    const creator = data.creators.find((c) => c.id === row.createdBy);
    const bons = rebuildBons(row, { payments: pays, movements: movs }, creator ? { id: creator.id, name: creator.name } : null);
    const lastNr = bons.length ? bons[bons.length - 1].bonNr : row.firstBonNr - 1;
    if (lastNr !== row.lastBonNr || itemsDigest(pays, movs) !== row.itemsDigest) {
      throw new KasseError(`Kassenabschluss Z ${row.number} ist inkonsistent (Belege passen nicht zum Abschluss). Bitte Support kontaktieren.`);
    }
    const serials = new Set<string>();
    for (const b of bons) if (b.tse && !b.tse.isTest) serials.add(b.tse.serial);
    if (row.tse.mode === "fiskaly" && row.tse.tssSerial) serials.add(row.tse.tssSerial);
    return { number: row.number, businessDate: row.businessDate, createdAt: row.createdAt, bons, tseSerials: [...serials] };
  });
  const o = data.o;
  const bytes = await buildDsfinvkZip(
    { name: o.legalName || o.name, street: o.street, zip: o.zip, city: o.city, taxNumber: o.taxNumber, vatId: o.vatId },
    registerOf(o),
    closings,
    { from, to },
  );
  await audit({ organizationId: org, userId: auth.user.id, action: "kasse.dsfinvk_export", entity: "organization", entityId: org, meta: { from, to, closings: closings.length } });
  return { bytes, closings: closings.length, filename: `dsfinvk-${o.slug.replace(/[^a-z0-9-]/g, "")}-${from}-${to}.zip` };
}

/** Anzahl der Abschlüsse im Zeitraum (Vorschau auf der Exportseite) */
export async function closingsInRange(auth: AuthContext, from: string, to: string) {
  assertCan(auth, "invoices.read");
  const org = auth.organization.id;
  return withOrg(org, (tx) =>
    tx
      .select({ id: cashClosings.id, number: cashClosings.number, businessDate: cashClosings.businessDate })
      .from(cashClosings)
      .where(and(eq(cashClosings.organizationId, org), gte(cashClosings.businessDate, from), lte(cashClosings.businessDate, to)))
      .orderBy(asc(cashClosings.number)),
  );
}

/**
 * Serverseitige Sperre (zusätzlich zum DB-Trigger): Zahlungen, die einem Z-Bon zugeordnet sind oder an einem
 * abgeschlossenen Tag liegen, dürfen nicht geändert/gelöscht werden. Für künftige Bearbeitungsfunktionen.
 */
export async function assertPaymentsEditable(tx: Tx, org: string, paymentIds: string[]) {
  if (!paymentIds.length) return;
  const rows = await tx.execute<{ id: string }>(sql`
    select p.id from payments p
     where p.organization_id = ${org} and p.id in (${sql.join(paymentIds.map((x) => sql`${x}::uuid`), sql`, `)})
       and (p.cash_closing_id is not null or exists (
         select 1 from cash_closings c where c.organization_id = p.organization_id
            and c.business_date = (p.paid_at at time zone 'Europe/Berlin')::date))`);
  if (rows.rows.length) throw new KasseError("Zahlungen eines abgeschlossenen Kassentags (Z-Bon) können nicht geändert werden.");
}
