import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import {
  cashClosingRegistrations,
  cashClosings,
  cashMovements,
  fiscalTransactions,
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
  reviveBons,
  serializeBons,
  verifyClosingRows,
  type Bon,
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
import { log } from "@/lib/log";
import { chainHash } from "@/lib/records";

export class KasseError extends Error {}
export { verifyClosingRows };

export const NO_TSE_NOTE = "ohne TSE – nur zulässig, wenn keine elektronische Kasse im Sinne der KassenSichV";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum ungültig");
/**
 * Freitexte landen unveränderbar im Z-Bon und im DSFinV-K-Export (CSV): kein führendes =, +, -, @ (Formel-Injection
 * beim Öffnen in Tabellenkalkulationen) und keine Steuerzeichen.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
export const safeFiscalText = (s: string) => !FORMULA_START.test(s) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s);
const FORMULA_MSG = "Text darf nicht mit =, +, - oder @ beginnen.";
const fiscalText = (min: number, max: number, minMsg?: string) => z.string().trim().min(min, minMsg).max(max).refine(safeFiscalText, FORMULA_MSG);
const optText = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(max).refine(safeFiscalText, FORMULA_MSG).nullable().optional());

export const movementInput = z.object({
  kind: z.enum(MOVEMENT_KINDS),
  /** Betrag immer positiv – das Vorzeichen ergibt sich aus der Art */
  amountCents: z.number().int().min(1, "Betrag fehlt").max(10_000_000, "Betrag zu hoch"),
  /** keine Patientendaten (Hinweis im Formular) – der Grund steht unveränderbar im Z-Bon/Export */
  reason: fiscalText(3, 300, "Bitte einen Grund angeben"),
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
    .select({ p: payments, invoiceNumber: invoices.number, voucherCode: vouchers.code, voucherPurpose: vouchers.purpose, ft: fiscalTransactions })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .leftJoin(vouchers, eq(vouchers.id, payments.voucherId))
    .leftJoin(fiscalTransactions, and(eq(fiscalTransactions.paymentId, payments.id), eq(fiscalTransactions.organizationId, org)))
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
        .orderBy(asc(vouchers.code))
    : [];
  const userIds = [...new Set([...payRows.map((r) => r.p.createdBy), ...movRows.map((m) => m.createdBy)].filter((x): x is string => !!x))];
  const names = userIds.length ? await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [];
  const person = (id: string | null) => (id ? { id, name: names.find((n) => n.id === id)?.name ?? "" } : null);
  /** alle mit der Rechnung verkauften Gutscheine (nicht nur der erste); Einzweck nur, wenn alle Einzweck sind */
  const soldFor = (invoiceId: string) => {
    const list = sold.filter((x) => x.invoiceId === invoiceId);
    if (!list.length) return null;
    return { code: list.map((x) => x.code).join(", "), purpose: list.every((x) => x.purpose === "single") ? "single" : "multi" };
  };

  const pays: (KassePayment & { closingId: string | null })[] = payRows.map((r) => ({
    id: r.p.id,
    closingId: r.p.cashClosingId,
    method: r.p.method as KasseMethod,
    amountCents: r.p.amountCents,
    paidAt: r.p.paidAt,
    invoiceNumber: r.invoiceNumber,
    vatGroups: vatRows.filter((v) => v.invoiceId === r.p.invoiceId).map((v) => ({ rate: v.rate, grossCents: Number(v.gross) })),
    voucher: r.voucherCode ? { code: r.voucherCode, purpose: r.voucherPurpose ?? "multi" } : null,
    soldVoucher: soldFor(r.p.invoiceId),
    externalRef: r.p.externalRef,
    // TSE-Daten nur aus fiscal_transactions (vom Server geschrieben); Altbestand: Kurzreferenz nur bei Bar (external_ref
    // wurde dort immer vom Server gesetzt – bei anderen Zahlarten ist external_ref frei eingebbar und nicht vertrauenswürdig)
    tse: r.ft
      ? {
          serial: r.ft.tssSerial,
          number: r.ft.txNumber,
          signatureCounter: r.ft.signatureCounter,
          isTest: r.ft.isTest,
          signature: r.ft.signature,
          startedAt: r.ft.startedAt,
          finishedAt: r.ft.finishedAt,
          processType: r.ft.processType,
        }
      : r.p.method === "cash"
        ? parseTseRef(r.p.externalRef)
        : null,
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
type RegistrationRow = typeof cashClosingRegistrations.$inferSelect;

/** Advisory-Lock je Praxis (64 Bit, gleicher Namensraum wie Buchung/Warteliste) */
const lockClosing = (tx: Tx, org: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`cash-closing:${org}`}, 0))`);

// ───────────────────────── Übersicht ─────────────────────────
export async function kasseOverview(auth: AuthContext) {
  assertCan(auth, "cash.read");
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
  assertCan(auth, "cash.write");
  const org = auth.organization.id;
  const parsed = movementInput.parse(input);
  const signed = MOVEMENT_SIGN[parsed.kind] * parsed.amountCents;
  try {
    // Bewegung und Audit-Eintrag in EINER Transaktion – nie Fiskaldaten ohne Audit
    return await withOrg(org, async (tx) => {
      const [row] = await tx.insert(cashMovements).values({ organizationId: org, kind: parsed.kind, amountCents: signed, reason: parsed.reason, createdBy: auth.user.id }).returning();
      await audit({ organizationId: org, userId: auth.user.id, action: "kasse.movement", entity: "cash_movement", entityId: row.id, meta: { kind: parsed.kind, amountCents: signed } }, tx);
      return row;
    });
  } catch (e) {
    const m = dbMessage(e);
    if (m) throw new KasseError(m);
    throw e;
  }
}

// ───────────────────────── Tagesabschluss (Z-Bon) ─────────────────────────
export type CloseResult = ClosingRow & { registration: "none" | "ok" | "pending" };

/**
 * Erstellt den Kassenabschluss. Pro Praxis serialisiert (Advisory-Lock) → Z-Nummer lückenlos; ein DB-Trigger prüft
 * Nummer, Hash-Kette und Datumsreihenfolge zusätzlich. Abschluss, Zuordnung der Zahlungen und Audit-Eintrag sind EINE
 * Transaktion – schlägt etwas fehl, entsteht keine Lücke. Die Bons werden als unveränderlicher Snapshot gespeichert.
 *
 * Die Meldung an den TSE-/DSFinV-K-Dienst (fiskaly) ist ein externer Aufruf und daher bewusst NICHT Teil der
 * DB-Transaktion: sie erfolgt nach dem Commit, idempotent über die Abschluss-ID, und kann bei einem Ausfall über
 * „Meldung wiederholen“ nachgeholt werden (Zustand „ausstehend“ im Z-Bon). So entsteht nie eine TSE-Meldung ohne Z-Bon.
 */
export async function closeDay(auth: AuthContext, input: ClosingInput): Promise<CloseResult> {
  assertCan(auth, "cash.write");
  const org = auth.organization.id;
  const parsedInput = closingInput.parse(input);
  const today = berlinDateIso();
  if (parsedInput.businessDate > today) throw new KasseError("Ein Tag in der Zukunft kann nicht abgeschlossen werden.");
  let denominations: Record<string, number>;
  try {
    denominations = normalizeDenominations(parsedInput.denominations);
  } catch (e) {
    throw new KasseError(e instanceof Error ? e.message : "Zählprotokoll ungültig.");
  }
  const withTse = !fiscalIsTestMode();

  let created: ClosingRow;
  try {
    created = await withOrg(org, async (tx) => {
      await lockClosing(tx, org);
      const prev = await lastClosing(tx, org);
      if (prev && parsedInput.businessDate <= prev.businessDate) {
        throw new KasseError(prev.businessDate === parsedInput.businessDate ? "Dieser Tag ist bereits abgeschlossen." : "Der Buchungstag liegt vor dem letzten Abschluss.");
      }
      const now = new Date();
      const end = dayEnd(parsedInput.businessDate);
      const closedAt = end.getTime() <= now.getTime() ? new Date(end.getTime() - 1) : now;
      const items = await loadItems(tx, org, { openUntil: closedAt });
      const number = (prev?.number ?? 0) + 1;
      const firstBonNr = (prev?.lastBonNr ?? 0) + 1;
      const openingCents = prev ? prev.countedCashCents : (parsedInput.openingCents ?? 0);
      const operator = { id: auth.user.id, name: auth.user.name };
      const calc = computeClosing({
        zNumber: number,
        firstBonNr,
        closedAt,
        openingCents,
        openingIsNew: !prev,
        denominations,
        differenceReason: parsedInput.differenceReason ?? null,
        payments: items.payments,
        movements: items.movements,
        operator,
      });
      if (calc.differenceCents !== 0 && !parsedInput.differenceReason) throw new KasseError("Bei einer Kassendifferenz ist eine Begründung Pflicht.");

      const id = randomUUID();
      const tse = closingTse(withTse, items.payments);
      const totals: CashClosingTotals = calc.totals;
      const createdAt = new Date();
      const values = {
        id,
        organizationId: org,
        number,
        businessDate: parsedInput.businessDate,
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
        bons: serializeBons(calc.bons),
        differenceReason: parsedInput.differenceReason ?? null,
        note: parsedInput.note ?? null,
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
      await audit(
        {
          organizationId: org,
          userId: auth.user.id,
          action: "kasse.close",
          entity: "cash_closing",
          entityId: row.id,
          meta: { number: row.number, businessDate: row.businessDate, differenceCents: row.differenceCents, tse: row.tse.mode },
        },
        tx,
      );
      return row;
    });
  } catch (e) {
    if (e instanceof KasseError) throw e;
    const m = dbMessage(e);
    if (m) throw new KasseError(m);
    throw e;
  }
  if (created.tse.mode !== "fiskaly") return { ...created, registration: "none" };
  const reg = await registerClosing(org, created).catch(() => null);
  return { ...created, registration: reg ? "ok" : "pending" };
}

/** TSE-Kennzeichnung des Abschlusses (ohne externen Aufruf – die Meldung folgt nach dem Commit). */
function closingTse(withTse: boolean, pays: KassePayment[]): CashClosingTse {
  const refs = pays.map((p) => p.tse).filter((r): r is NonNullable<typeof r> => !!r);
  const testSignatures = refs.some((r) => r.isTest);
  if (!withTse) {
    return { mode: "none", testSignatures, tssSerial: null, transactionNumber: null, signatureCounter: null, exportRef: null, note: NO_TSE_NOTE };
  }
  const real = refs.filter((x) => !x.isTest);
  const lastRef = real[real.length - 1];
  return {
    mode: "fiskaly",
    testSignatures,
    tssSerial: lastRef?.serial ?? null,
    transactionNumber: lastRef?.number ?? null,
    signatureCounter: lastRef?.signatureCounter ?? null,
    exportRef: null,
    registration: "pending",
    note: null,
  };
}

/**
 * Meldet einen gespeicherten Abschluss an den TSE-/DSFinV-K-Dienst (idempotent: Abschluss-ID als Schlüssel, Ergebnis
 * je Abschluss genau einmal in cash_closing_registrations). Fehler werden nur protokolliert (ohne Anbieter-Details an
 * die Oberfläche); der Abschluss bleibt „Meldung ausstehend“ und kann erneut gemeldet werden.
 */
async function registerClosing(org: string, row: ClosingRow): Promise<RegistrationRow | null> {
  const [existing] = await withOrg(org, (tx) =>
    tx.select().from(cashClosingRegistrations).where(and(eq(cashClosingRegistrations.organizationId, org), eq(cashClosingRegistrations.cashClosingId, row.id))),
  );
  if (existing) return existing;
  const port = getFiscalPort();
  if (!port.registerCashPointClosing) {
    log.error("kasse.registration.unsupported", { kind: port.vendor });
    return null;
  }
  const bons = row.bons ? reviveBons(row.bons) : [];
  const payMap = new Map<string, { type: "Bar" | "Unbar"; name: string; amountCents: number }>();
  for (const b of bons)
    for (const p of b.payments) {
      const k = `${p.typ}|${p.name}`;
      const e = payMap.get(k) ?? { type: p.typ, name: p.name, amountCents: 0 };
      e.amountCents += p.amountCents;
      payMap.set(k, e);
    }
  let r: { closingRef: string; tssSerial?: string | null };
  try {
    r = await port.registerCashPointClosing({ closingId: row.id, number: row.number, businessDate: row.businessDate, payments: [...payMap.values()], businessCases: row.totals.businessCases });
  } catch (e) {
    log.error("kasse.registration.failed", { error: e, count: row.number });
    await audit({ organizationId: org, action: "kasse.close_registration_failed", entity: "cash_closing", entityId: row.id, meta: { number: row.number } }).catch(() => undefined);
    return null;
  }
  return withOrg(org, async (tx) => {
    const [ins] = await tx
      .insert(cashClosingRegistrations)
      .values({ organizationId: org, cashClosingId: row.id, vendor: port.vendor, closingRef: String(r.closingRef).slice(0, 200), tssSerial: r.tssSerial ? String(r.tssSerial).slice(0, 100) : null })
      .onConflictDoNothing()
      .returning();
    if (ins) await audit({ organizationId: org, action: "kasse.close_registered", entity: "cash_closing", entityId: row.id, meta: { number: row.number } }, tx);
    if (ins) return ins;
    const [again] = await tx.select().from(cashClosingRegistrations).where(and(eq(cashClosingRegistrations.organizationId, org), eq(cashClosingRegistrations.cashClosingId, row.id)));
    return again ?? null;
  });
}

/** „Meldung wiederholen“ für einen Abschluss mit ausstehender TSE-Meldung. */
export async function retryClosingRegistration(auth: AuthContext, id: string) {
  assertCan(auth, "cash.write");
  const org = auth.organization.id;
  if (!z.uuid().safeParse(id).success) throw new KasseError("Abschluss nicht gefunden.");
  const [row] = await withOrg(org, (tx) => tx.select().from(cashClosings).where(and(eq(cashClosings.organizationId, org), eq(cashClosings.id, id))));
  if (!row) throw new KasseError("Abschluss nicht gefunden.");
  if (row.tse.mode !== "fiskaly") throw new KasseError("Dieser Abschluss wurde ohne TSE erstellt.");
  if (fiscalIsTestMode()) throw new KasseError("Keine TSE angebunden.");
  const reg = await registerClosing(org, row);
  if (!reg) throw new KasseError("Die Meldung an den TSE-Dienst ist fehlgeschlagen. Bitte später erneut versuchen oder den Support kontaktieren.");
  return reg;
}

// ───────────────────────── Anzeige / PDF ─────────────────────────
/** Praxisangaben für Z-Bon/Export – bewusst ohne settings und sonstige Konfiguration */
const orgCols = {
  id: organizations.id,
  slug: organizations.slug,
  name: organizations.name,
  legalName: organizations.legalName,
  street: organizations.street,
  zip: organizations.zip,
  city: organizations.city,
  taxNumber: organizations.taxNumber,
  vatId: organizations.vatId,
  settings: organizations.settings,
};
type OrgInfo = { id: string; slug: string; settings: unknown; name: string; legalName: string | null; street: string | null; zip: string | null; city: string | null; taxNumber: string | null; vatId: string | null };

/** Bons eines Abschlusses: Snapshot (ab 0016) bzw. Rekonstruktion aus den Zahlungen (Altbestand). */
function bonsOf(row: ClosingRow, items: { payments: KassePayment[]; movements: KasseMovement[] }, operator: { id: string; name: string } | null): Bon[] {
  if (row.bons) return reviveBons(row.bons);
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

async function loadClosing(tx: Tx, org: string, id: string) {
  const [row] = await tx.select().from(cashClosings).where(and(eq(cashClosings.organizationId, org), eq(cashClosings.id, id)));
  if (!row) return null;
  const items = await loadItems(tx, org, { closingIds: [row.id] });
  const chain = await tx.select().from(cashClosings).where(and(eq(cashClosings.organizationId, org), lte(cashClosings.number, row.number))).orderBy(asc(cashClosings.number));
  const [o] = await tx.select(orgCols).from(organizations).where(eq(organizations.id, org));
  const [creator] = row.createdBy ? await tx.select({ name: users.name }).from(users).where(eq(users.id, row.createdBy)) : [];
  const [registration] = await tx.select().from(cashClosingRegistrations).where(and(eq(cashClosingRegistrations.organizationId, org), eq(cashClosingRegistrations.cashClosingId, row.id)));
  const bons = bonsOf(row, items, creator ? { id: row.createdBy!, name: creator.name } : null);
  const { settings, ...organization } = o;
  return {
    closing: row,
    organization,
    registerId: registerOf({ ...o, settings }).kasseId,
    createdByName: creator?.name ?? null,
    registration: registration ?? null,
    payments: items.payments,
    movements: items.movements,
    bons,
    chainOk: verifyClosingRows(chain) === -1,
    digestOk: itemsDigest(items.payments, items.movements) === row.itemsDigest,
  };
}

export async function getClosing(auth: AuthContext, id: string) {
  assertCan(auth, "cash.read");
  return withOrg(auth.organization.id, (tx) => loadClosing(tx, auth.organization.id, id));
}

export async function zBonPdfForOrg(org: string, id: string) {
  const data = await withOrg(org, (tx) => loadClosing(tx, org, id));
  if (!data) return null;
  const bytes = await renderZBonPdf({
    closing: data.closing,
    organization: data.organization,
    createdByName: data.createdByName,
    registerId: data.registerId,
    registration: data.registration,
    chainOk: data.chainOk && data.digestOk,
  });
  return { bytes, filename: `Z-Bon-${data.closing.number}-${data.closing.businessDate}.pdf` };
}

// ───────────────────────── DSFinV-K ─────────────────────────
function registerOf(o: Pick<OrgInfo, "id" | "slug" | "settings">): DsfinvkRegister {
  const k = (((o.settings ?? {}) as Record<string, unknown>).kasse ?? {}) as { kasseId?: unknown; serial?: unknown };
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

/** DSFinV-K-Export – eigenes Recht (Inhaber:in, Steuerberatung), nicht jedes Rechnungs-Leserecht. */
export async function buildDsfinvkExport(auth: AuthContext, from: string, to: string) {
  assertCan(auth, "cash.export");
  const org = auth.organization.id;
  const data = await withOrg(org, async (tx) => {
    const [o] = await tx.select(orgCols).from(organizations).where(eq(organizations.id, org));
    // ganze Kette bis zum Ende des Zeitraums prüfen (Hash, Nummern, Belegnummern) – bei Bruch kein Export
    const chain = await tx.select().from(cashClosings).where(and(eq(cashClosings.organizationId, org), lte(cashClosings.businessDate, to))).orderBy(asc(cashClosings.number));
    const broken = verifyClosingRows(chain);
    if (broken !== -1) throw new KasseError(`Die Hash-Kette der Kassenabschlüsse ist ab Z ${chain[broken].number} ungültig. Export abgebrochen – bitte Support kontaktieren.`);
    const rows = chain.filter((r) => r.businessDate >= from);
    const items = await loadItems(tx, org, { closingIds: rows.map((r) => r.id) });
    const regs = rows.length
      ? await tx.select().from(cashClosingRegistrations).where(and(eq(cashClosingRegistrations.organizationId, org), inArray(cashClosingRegistrations.cashClosingId, rows.map((r) => r.id))))
      : [];
    const creatorIds = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => !!x))];
    const creators = creatorIds.length ? await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, creatorIds)) : [];
    return { o, rows, items, regs, creators };
  });
  const closings: DsfinvkClosing[] = data.rows.map((row) => {
    const pays = data.items.payments.filter((p) => p.closingId === row.id);
    const movs = data.items.movements.filter((m) => m.closingId === row.id);
    const creator = data.creators.find((c) => c.id === row.createdBy);
    const bons = bonsOf(row, { payments: pays, movements: movs }, creator ? { id: creator.id, name: creator.name } : null);
    const lastNr = bons.length ? bons[bons.length - 1].bonNr : row.firstBonNr - 1;
    if (lastNr !== row.lastBonNr || itemsDigest(pays, movs) !== row.itemsDigest) {
      throw new KasseError(`Kassenabschluss Z ${row.number} ist inkonsistent (Belege passen nicht zum Abschluss). Bitte Support kontaktieren.`);
    }
    const serials = new Set<string>();
    for (const b of bons) if (b.tse && !b.tse.isTest) serials.add(b.tse.serial);
    const reg = data.regs.find((r) => r.cashClosingId === row.id);
    const closingSerial = reg?.tssSerial ?? (row.tse.mode === "fiskaly" ? row.tse.tssSerial : null);
    if (closingSerial) serials.add(closingSerial);
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
  assertCan(auth, "cash.export");
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
 * Serverseitige Sperre (zusätzlich zum DB-Trigger): Zahlungen, die einem Z-Bon zugeordnet sind oder zeitlich in einem
 * abgeschlossenen Zeitraum liegen (paid_at ≤ Stichzeitpunkt bzw. an/vor einem abgeschlossenen Buchungstag), dürfen
 * nicht geändert/gelöscht werden. Für künftige Bearbeitungsfunktionen.
 */
export async function assertPaymentsEditable(tx: Tx, org: string, paymentIds: string[]) {
  if (!paymentIds.length) return;
  const rows = await tx.execute<{ id: string }>(sql`
    select p.id from payments p
     where p.organization_id = ${org} and p.id in (${sql.join(paymentIds.map((x) => sql`${x}::uuid`), sql`, `)})
       and (p.cash_closing_id is not null or podo_payment_in_closed_period(p.organization_id, p.paid_at))`);
  if (rows.rows.length) throw new KasseError("Zahlungen eines abgeschlossenen Kassentags (Z-Bon) können nicht geändert werden.");
}
