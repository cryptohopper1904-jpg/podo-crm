/**
 * Kasse (Kassenbuch, Tagesabschluss/Z-Bon) – reine Funktionen ohne Server-Importe.
 *
 * Ein Kassenabschluss (Z-Bon) umfasst alle bis zum Stichzeitpunkt noch nicht abgeschlossenen Zahlungen und
 * Einlagen/Entnahmen. Daraus entstehen die „Bons“ (DSFinV-K: Einzelaufzeichnungen) – dieselbe Funktion wird beim
 * Abschluss (Summen, Belegnummern) und beim DSFinV-K-Export verwendet, damit beide garantiert übereinstimmen.
 */
import { createHash } from "node:crypto";
import { allocateByVat } from "@/integrations/tse/types";
import { vatPortion } from "@/lib/invoice-math";
import { canonical } from "@/lib/records";
import { countedTotal, MOVEMENT_LABEL, type MovementKind } from "./labels";

export * from "./labels";

// ───────────────────────── Eingangsdaten ─────────────────────────
export type KasseMethod = "cash" | "card" | "transfer" | "voucher" | "payment_link";
/** Zahlarten, die an der Kasse (Empfang) entstehen und in die Einzelaufzeichnung (DSFinV-K) gehören */
export const REGISTER_METHODS: readonly KasseMethod[] = ["cash", "card", "voucher"];
export const isRegisterMethod = (m: string) => (REGISTER_METHODS as readonly string[]).includes(m);

export type KassePerson = { id: string; name: string } | null;

export type KassePayment = {
  id: string;
  method: KasseMethod;
  amountCents: number;
  paidAt: Date;
  invoiceNumber: string | null;
  /** Beträge der Rechnung je Steuersatz (für die anteilige Aufteilung) */
  vatGroups: { rate: number; grossCents: number }[];
  /** Zahlung mit Gutschein (Einlösung) */
  voucher: { code: string; purpose: string } | null;
  /** die Rechnung ist ein Gutscheinverkauf */
  soldVoucher: { code: string; purpose: string } | null;
  externalRef: string | null;
  createdBy: KassePerson;
};

export type KasseMovement = {
  id: string;
  kind: MovementKind;
  amountCents: number;
  reason: string;
  occurredAt: Date;
  createdBy: KassePerson;
};

// ───────────────────────── Bons (Einzelaufzeichnung) ─────────────────────────
/** DSFinV-K-Geschäftsvorfalltypen (Auszug) */
export type GvTyp =
  | "Umsatz"
  | "MehrzweckgutscheinKauf"
  | "MehrzweckgutscheinEinloesung"
  | "EinzweckgutscheinKauf"
  | "EinzweckgutscheinEinloesung"
  | "Anfangsbestand"
  | "Privateinlage"
  | "Privatentnahme"
  | "Geldtransit"
  | "Einzahlung"
  | "Auszahlung"
  | "DifferenzSollIst";

const MOVEMENT_GV: Record<MovementKind, GvTyp> = {
  private_deposit: "Privateinlage",
  private_withdrawal: "Privatentnahme",
  transit_in: "Geldtransit",
  transit_out: "Geldtransit",
  payout: "Auszahlung",
  payin: "Einzahlung",
};

/**
 * DSFinV-K USt-Schlüssel: 1 = 19 %, 2 = 7 %, 5 = nicht steuerbar, 6 = umsatzsteuerfrei.
 * 0 % bei uns = steuerfrei nach § 4 Nr. 14 UStG bzw. Kleinunternehmer (§ 19 UStG).
 * // TODO DSFinV-K prüfen: Schlüssel für Kleinunternehmer (§ 19 UStG) – 6 oder 7 („nicht ermittelbar“)?
 */
export function ustKey(rate: number, opts: { nonTaxable?: boolean } = {}): number {
  if (opts.nonTaxable) return 5;
  if (rate === 19) return 1;
  if (rate === 7) return 2;
  return 6;
}
export const UST_KEY_RATE: Record<number, number> = { 1: 19, 2: 7, 5: 0, 6: 0 };
export const UST_KEY_LABEL: Record<number, string> = {
  1: "Regelsteuersatz",
  2: "Ermäßigter Steuersatz",
  5: "Nicht steuerbar",
  6: "Umsatzsteuerfrei",
};

export type BonLine = {
  pos: number;
  text: string;
  gvTyp: GvTyp;
  ustKey: number;
  rate: number;
  grossCents: number;
  netCents: number;
  vatCents: number;
  voucherCode: string | null;
};

export type BonPayment = { typ: "Bar" | "Unbar"; name: string; amountCents: number };

export type BonTse = { serial: string; number: number; signatureCounter: number; isTest: boolean };

export type Bon = {
  bonId: string;
  bonNr: number;
  kind: "payment" | "movement" | "opening" | "difference";
  start: Date;
  end: Date;
  operator: KassePerson;
  lines: BonLine[];
  payments: BonPayment[];
  totalCents: number;
  invoiceNumber: string | null;
  tse: BonTse | null;
  note: string | null;
};

const line = (pos: number, text: string, gvTyp: GvTyp, key: number, grossCents: number, voucherCode: string | null = null): BonLine => {
  const rate = UST_KEY_RATE[key] ?? 0;
  const vatCents = rate ? vatPortion(grossCents, rate) : 0;
  return { pos, text, gvTyp, ustKey: key, rate, grossCents, netCents: grossCents - vatCents, vatCents, voucherCode };
};

/** Referenz „tse:[test:]SERIAL:NUMMER:ZÄHLER“ aus payments.external_ref (siehe fiscalRef) */
export function parseTseRef(ref: string | null): BonTse | null {
  if (!ref?.startsWith("tse:")) return null;
  const parts = ref.split(":");
  const isTest = parts[1] === "test";
  const rest = isTest ? parts.slice(2) : parts.slice(1);
  if (rest.length < 3) return null;
  const signatureCounter = Number(rest.pop());
  const number = Number(rest.pop());
  if (!Number.isInteger(number) || !Number.isInteger(signatureCounter)) return null;
  return { serial: rest.join(":"), number, signatureCounter, isTest };
}

function paymentLines(p: KassePayment): BonLine[] {
  const ref = p.invoiceNumber ? ` ${p.invoiceNumber}` : "";
  const parts = allocateByVat(p.amountCents, p.vatGroups).filter((a) => a.grossCents !== 0);
  const split = parts.length ? parts : [{ vatRate: 0 as const, grossCents: p.amountCents }];
  const out: BonLine[] = [];
  if (p.soldVoucher) {
    // Gutscheinverkauf: Mehrzweck = nicht steuerbar (USt erst bei Einlösung), Einzweck = USt beim Verkauf
    // TODO DSFinV-K prüfen: Einzweckgutschein-Verkauf mit dem Steuersatz der Rechnung
    if (p.soldVoucher.purpose === "single") {
      for (const a of split) out.push(line(out.length + 1, `Einzweckgutschein ${p.soldVoucher.code}`, "EinzweckgutscheinKauf", ustKey(a.vatRate), a.grossCents, p.soldVoucher.code));
    } else {
      out.push(line(1, `Mehrzweckgutschein ${p.soldVoucher.code}`, "MehrzweckgutscheinKauf", 5, p.amountCents, p.soldVoucher.code));
    }
    return out;
  }
  for (const a of split) out.push(line(out.length + 1, `Zahlung zu Rechnung${ref} (${a.vatRate} % USt)`, "Umsatz", ustKey(a.vatRate), a.grossCents));
  if (p.method === "voucher" && p.voucher) {
    // Einlösung = negative Position, gleicht den Umsatz aus (kein Zahlungsmittel)
    // TODO DSFinV-K prüfen: Einzweckgutschein-Einlösung mit gespiegeltem Steuersatz, Mehrzweck mit Schlüssel 5
    if (p.voucher.purpose === "single") {
      for (const a of split) out.push(line(out.length + 1, `Einlösung Gutschein ${p.voucher.code}`, "EinzweckgutscheinEinloesung", ustKey(a.vatRate), -a.grossCents, p.voucher.code));
    } else {
      out.push(line(out.length + 1, `Einlösung Gutschein ${p.voucher.code}`, "MehrzweckgutscheinEinloesung", 5, -p.amountCents, p.voucher.code));
    }
  }
  return out;
}

function paymentMeans(p: KassePayment): BonPayment[] {
  if (p.method === "cash") return [{ typ: "Bar", name: "Bar", amountCents: p.amountCents }];
  // TODO DSFinV-K prüfen: genauer Typ (ECKarte/Kreditkarte/ElZahlungsdienstleister) ist bei SumUp nicht bekannt
  if (p.method === "card") return [{ typ: "Unbar", name: "Karte (SumUp)", amountCents: p.amountCents }];
  return [];
}

const byTime = <T extends { at: Date; id: string }>(a: T, b: T) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id);

/**
 * Bons eines Abschlusses in fester Reihenfolge: [Anfangsbestand], Zahlungen/Bewegungen nach Zeit, [Differenz].
 * Nur kassenrelevante Zahlarten (Bar, Karte, Gutschein); Überweisung/Zahlungslink sind keine Kassenvorgänge.
 */
export function buildBons(input: {
  zNumber: number;
  firstBonNr: number;
  closedAt: Date;
  /** Anfangsbestand als eigener Vorgang (nur beim ersten Abschluss) */
  openingCents: number;
  openingIsNew: boolean;
  differenceCents: number;
  differenceReason?: string | null;
  payments: KassePayment[];
  movements: KasseMovement[];
  operator?: KassePerson;
}): Bon[] {
  const items = [
    ...input.payments.filter((p) => isRegisterMethod(p.method)).map((p) => ({ at: p.paidAt, id: p.id, p })),
    ...input.movements.map((m) => ({ at: m.occurredAt, id: m.id, m })),
  ].sort(byTime);
  const bons: Omit<Bon, "bonNr">[] = [];
  const first = items[0]?.at ?? input.closedAt;
  if (input.openingIsNew && input.openingCents !== 0) {
    bons.push({
      bonId: `Z${input.zNumber}-AB`,
      kind: "opening",
      start: first,
      end: first,
      operator: input.operator ?? null,
      lines: [line(1, "Anfangsbestand", "Anfangsbestand", 5, input.openingCents)],
      payments: [{ typ: "Bar", name: "Bar", amountCents: input.openingCents }],
      totalCents: input.openingCents,
      invoiceNumber: null,
      tse: null,
      note: null,
    });
  }
  for (const it of items) {
    if ("p" in it && it.p) {
      const p = it.p;
      const lines = paymentLines(p);
      bons.push({
        bonId: p.id,
        kind: "payment",
        start: p.paidAt,
        end: p.paidAt,
        operator: p.createdBy,
        lines,
        payments: paymentMeans(p),
        totalCents: lines.reduce((s, l) => s + l.grossCents, 0),
        invoiceNumber: p.invoiceNumber,
        tse: parseTseRef(p.externalRef),
        note: null,
      });
    } else if ("m" in it && it.m) {
      const m = it.m;
      bons.push({
        bonId: m.id,
        kind: "movement",
        start: m.occurredAt,
        end: m.occurredAt,
        operator: m.createdBy,
        lines: [line(1, MOVEMENT_LABEL[m.kind], MOVEMENT_GV[m.kind], 5, m.amountCents)],
        payments: [{ typ: "Bar", name: "Bar", amountCents: m.amountCents }],
        totalCents: m.amountCents,
        invoiceNumber: null,
        tse: null,
        note: m.reason,
      });
    }
  }
  if (input.differenceCents !== 0) {
    bons.push({
      bonId: `Z${input.zNumber}-DIFF`,
      kind: "difference",
      start: input.closedAt,
      end: input.closedAt,
      operator: input.operator ?? null,
      lines: [line(1, "Kassendifferenz (Soll/Ist)", "DifferenzSollIst", 5, input.differenceCents)],
      payments: [{ typ: "Bar", name: "Bar", amountCents: input.differenceCents }],
      totalCents: input.differenceCents,
      invoiceNumber: null,
      tse: null,
      note: input.differenceReason ?? null,
    });
  }
  return bons.map((b, i) => ({ ...b, bonNr: input.firstBonNr + i }));
}

// ───────────────────────── Abschluss-Berechnung ─────────────────────────
export type ClosingComputation = {
  cashPaymentsCents: number;
  movementsCents: number;
  expectedCashCents: number;
  countedCashCents: number;
  differenceCents: number;
  totals: {
    byMethod: Record<string, number>;
    byVat: { rate: number; grossCents: number; netCents: number; vatCents: number }[];
    movements: Record<string, number>;
    businessCases: { gvTyp: string; ustKey: number; grossCents: number; netCents: number; vatCents: number }[];
  };
  bons: Bon[];
  lastBonNr: number;
  itemsDigest: string;
};

export function computeClosing(input: {
  zNumber: number;
  firstBonNr: number;
  closedAt: Date;
  openingCents: number;
  openingIsNew: boolean;
  denominations: Record<string, number>;
  differenceReason?: string | null;
  payments: KassePayment[];
  movements: KasseMovement[];
  operator?: KassePerson;
}): ClosingComputation {
  const byMethod: Record<string, number> = {};
  for (const p of input.payments) byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amountCents;
  const movements: Record<string, number> = {};
  for (const m of input.movements) movements[m.kind] = (movements[m.kind] ?? 0) + m.amountCents;
  const cashPaymentsCents = byMethod.cash ?? 0;
  const movementsCents = input.movements.reduce((s, m) => s + m.amountCents, 0);
  const expectedCashCents = input.openingCents + cashPaymentsCents + movementsCents;
  const countedCashCents = countedTotal(input.denominations);
  const differenceCents = countedCashCents - expectedCashCents;
  const bons = buildBons({ ...input, differenceCents });

  const bc = new Map<string, { gvTyp: string; ustKey: number; grossCents: number; netCents: number; vatCents: number }>();
  const vat = new Map<number, { rate: number; grossCents: number; netCents: number; vatCents: number }>();
  for (const b of bons)
    for (const l of b.lines) {
      const k = `${l.gvTyp}|${l.ustKey}`;
      const e = bc.get(k) ?? { gvTyp: l.gvTyp, ustKey: l.ustKey, grossCents: 0, netCents: 0, vatCents: 0 };
      e.grossCents += l.grossCents;
      e.netCents += l.netCents;
      e.vatCents += l.vatCents;
      bc.set(k, e);
      if (l.gvTyp === "Umsatz") {
        const v = vat.get(l.rate) ?? { rate: l.rate, grossCents: 0, netCents: 0, vatCents: 0 };
        v.grossCents += l.grossCents;
        v.netCents += l.netCents;
        v.vatCents += l.vatCents;
        vat.set(l.rate, v);
      }
    }
  return {
    cashPaymentsCents,
    movementsCents,
    expectedCashCents,
    countedCashCents,
    differenceCents,
    totals: {
      byMethod,
      byVat: [...vat.values()].sort((a, b) => b.rate - a.rate),
      movements,
      businessCases: [...bc.values()].sort((a, b) => a.gvTyp.localeCompare(b.gvTyp) || a.ustKey - b.ustKey),
    },
    bons,
    lastBonNr: input.firstBonNr + bons.length - 1,
    itemsDigest: itemsDigest(input.payments, input.movements),
  };
}

/** SHA-256 über die Zahlungen/Bewegungen eines Abschlusses (Mitgliedschaft und Beträge manipulationssicher). */
export function itemsDigest(payments: Pick<KassePayment, "id" | "method" | "amountCents" | "paidAt">[], movements: Pick<KasseMovement, "id" | "kind" | "amountCents" | "occurredAt">[]): string {
  const list = [
    ...payments.map((p) => ({ t: "p", id: p.id, k: p.method, a: p.amountCents, at: p.paidAt.toISOString() })),
    ...movements.map((m) => ({ t: "m", id: m.id, k: m.kind, a: m.amountCents, at: m.occurredAt.toISOString() })),
  ].sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(canonical(list)).digest("hex");
}

/** Inhalt eines Abschlusses, der in die Hash-Kette eingeht (Reihenfolge egal – canonical sortiert die Schlüssel). */
export function closingHashContent(c: {
  id: string;
  organizationId: string;
  number: number;
  businessDate: string;
  closedAt: Date;
  createdAt: Date;
  openingCents: number;
  cashPaymentsCents: number;
  movementsCents: number;
  expectedCashCents: number;
  countedCashCents: number;
  differenceCents: number;
  denominations: Record<string, number>;
  totals: unknown;
  paymentCount: number;
  movementCount: number;
  firstBonNr: number;
  lastBonNr: number;
  itemsDigest: string;
  tse: unknown;
  differenceReason: string | null;
  note: string | null;
  createdBy: string | null;
}): Record<string, unknown> {
  // JSON-Rundreise: identisch zu dem, was aus jsonb/timestamptz zurückkommt (undefined entfällt, Datum → ISO)
  return JSON.parse(JSON.stringify({ ...c, closedAt: c.closedAt.toISOString(), createdAt: c.createdAt.toISOString() })) as Record<string, unknown>;
}
