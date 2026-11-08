/**
 * Reine Rechenfunktionen für Rechnungen, Zahlungen, Gutscheine und Praxisfinanzen.
 * Keine Server-Importe – wird auch im Browser (Positionseditor) verwendet.
 *
 * Grundsätze:
 * - Alle Beträge in Cent (integer).
 * - Preise sind Bruttopreise. USt-Anteil = round(brutto × satz / (100 + satz)).
 * - Die USt wird je Steuersatz über die Summe der Positionen berechnet (Ausweis je Satz).
 */

export const VAT_RATES = [0, 7, 19] as const;
export type VatRate = (typeof VAT_RATES)[number];

export const isVatRate = (n: number): n is VatRate => (VAT_RATES as readonly number[]).includes(n);

/** Gesamtbetrag einer Position: Einzelpreis × Menge × Faktor (kaufmännisch gerundet). */
export function lineTotalCents(unitPriceCents: number, quantity: number, factor = 1): number {
  return roundHalfAwayFromZero(unitPriceCents * quantity * factor);
}

/** USt-Anteil aus einem Bruttobetrag. */
export function vatPortion(grossCents: number, rate: number): number {
  if (!rate) return 0;
  return roundHalfAwayFromZero((grossCents * rate) / (100 + rate));
}

/** Kaufmännisches Runden, auch für negative Beträge (Gutschriften) symmetrisch. */
export function roundHalfAwayFromZero(n: number): number {
  const r = Math.round(Math.abs(n) + Number.EPSILON * Math.abs(n));
  return n < 0 ? -r : r;
}

export type VatGroup = { rate: number; grossCents: number; vatCents: number; netCents: number };
export type Totals = { totalCents: number; vatCents: number; netCents: number; groups: VatGroup[] };

export function computeTotals(lines: { totalCents: number; vatRate: number }[]): Totals {
  const byRate = new Map<number, number>();
  for (const l of lines) byRate.set(l.vatRate, (byRate.get(l.vatRate) ?? 0) + l.totalCents);
  const groups = [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, grossCents]) => {
      const vatCents = vatPortion(grossCents, rate);
      return { rate, grossCents, vatCents, netCents: grossCents - vatCents };
    });
  const totalCents = groups.reduce((s, g) => s + g.grossCents, 0);
  const vatCents = groups.reduce((s, g) => s + g.vatCents, 0);
  return { totalCents, vatCents, netCents: totalCents - vatCents, groups };
}

/**
 * Steuersatz einer Position:
 * - Kleinunternehmer (§ 19 UStG) → immer 0 %.
 * - sonst der gewählte Satz (0/7/19).
 */
export function effectiveVatRate(rate: number, opts: { smallBusiness: boolean }): number {
  if (opts.smallBusiness) return 0;
  return isVatRate(rate) ? rate : 19;
}

/**
 * USt-Wächter (§ 4 Nr. 14 UStG): 0 % ist nur bei Heilbehandlung mit therapeutischem Ziel zulässig.
 * Gibt true zurück, wenn für mindestens eine Position die Bestätigung nötig ist.
 */
export function needsTherapeuticConfirmation(
  lines: { vatRate: number; requiresTherapeuticPurpose?: boolean | null }[],
  opts: { smallBusiness: boolean },
): boolean {
  if (opts.smallBusiness) return false;
  return lines.some((l) => l.vatRate === 0 && !!l.requiresTherapeuticPurpose);
}

export type InvoiceStatusPaid = "issued" | "partially_paid" | "paid";

/**
 * Status aus Gesamt- und gezahltem Betrag. Funktioniert auch für Gutschriften (negative Beträge):
 * dort bedeutet „bezahlt“, dass die Erstattung bzw. Verrechnung vollständig ist.
 */
export function statusFromPayments(totalCents: number, paidCents: number): InvoiceStatusPaid {
  if (totalCents === 0) return "paid";
  const sign = totalCents < 0 ? -1 : 1;
  const t = totalCents * sign;
  const p = paidCents * sign;
  if (p >= t) return "paid";
  if (p > 0) return "partially_paid";
  return "issued";
}

export const openCents = (totalCents: number, paidCents: number) => totalCents - paidCents;

/**
 * Prüft neue Zahlungen gegen den offenen Betrag. Überzahlung ist nicht erlaubt
 * (Rückgeld bei Barzahlung wird nicht gebucht). Bei Gutschriften sind die Beträge negativ (Erstattung).
 */
export function validatePayments(open: number, amounts: number[]): string | null {
  if (!amounts.length) return null;
  if (amounts.some((a) => !Number.isInteger(a) || a === 0)) return "Zahlungsbeträge müssen ungleich 0 sein.";
  const sign = open < 0 ? -1 : 1;
  if (amounts.some((a) => Math.sign(a) !== sign)) {
    return sign < 0 ? "Erstattungen werden als negative Beträge erfasst." : "Zahlungsbeträge müssen positiv sein.";
  }
  const sum = amounts.reduce((s, a) => s + a, 0);
  if (sum * sign > open * sign) return "Die Zahlungen übersteigen den offenen Betrag.";
  return null;
}

/** Restguthaben eines Gutscheins: Betrag − Summe der Gutschein-Zahlungen (Erstattungen sind negativ). */
export function voucherBalance(amountCents: number, voucherPayments: { amountCents: number }[]): number {
  return amountCents - voucherPayments.reduce((s, p) => s + p.amountCents, 0);
}

/**
 * Standard-Gültigkeit: Ende des dritten Jahres nach Ausstellung (regelmäßige Verjährung, § 195/§ 199 BGB).
 * Eine kürzere Befristung muss rechtlich geprüft werden (PLAN 14.1).
 */
export function defaultVoucherValidUntil(issuedIso: string): string {
  const y = Number(issuedIso.slice(0, 4));
  return `${y + 3}-12-31`;
}

/** Positionen für eine Stornorechnung: gleiche Positionen, negative Beträge. */
export function negateLines<T extends { unitPriceCents: number; totalCents: number; quantity: string | number }>(lines: T[]): T[] {
  return lines.map((l) => ({
    ...l,
    // Menge bleibt positiv, der Einzelpreis wird negativ – so stimmt Einzelpreis × Menge = Gesamt
    unitPriceCents: -l.unitPriceCents,
    totalCents: -l.totalCents,
  }));
}

export function negateTotals(t: { totalCents: number; vatCents: number; netCents: number }) {
  return { totalCents: -t.totalCents, vatCents: -t.vatCents, netCents: -t.netCents };
}

/**
 * Verrechnung beim Storno: Der unbezahlte Teil der Originalrechnung wird mit der Gutschrift verrechnet,
 * der bereits bezahlte Teil bleibt als Erstattung offen.
 * Rückgabe: paidCents der Gutschrift (negativ oder 0).
 */
export function creditNoteSettlement(originalTotalCents: number, originalPaidCents: number): number {
  return -(originalTotalCents - originalPaidCents);
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ───────────────────────── Praxisfinanzen ─────────────────────────
export type CostInterval = "monthly" | "quarterly" | "yearly";

export function monthlyShare(amountCents: number, interval: string): number {
  if (interval === "quarterly") return Math.round(amountCents / 3);
  if (interval === "yearly") return Math.round(amountCents / 12);
  return amountCents;
}

/**
 * Break-even: Wie viele Behandlungen pro Monat decken die Fixkosten?
 * Deckungsbeitrag je Behandlung = Ø Umsatz je Behandlung − Materialkosten je Behandlung.
 * Gibt null zurück, wenn kein positiver Deckungsbeitrag vorliegt.
 */
export function breakEvenTreatments(fixedMonthlyCents: number, avgRevenuePerTreatmentCents: number, materialCostCents = 0): number | null {
  const margin = avgRevenuePerTreatmentCents - materialCostCents;
  if (margin <= 0) return null;
  return Math.ceil(fixedMonthlyCents / margin);
}

export function percentChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}
