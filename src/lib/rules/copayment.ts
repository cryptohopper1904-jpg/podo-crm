/**
 * Zuzahlungsquittung (GKV Paket B): Aufteilung der Zuzahlung einer Verordnung je Position und Verordnungsblattgebühr –
 * reine Funktionen (Server und Browser).
 *
 * Grundlage ist der Preis-Snapshot (`priceSnapshot` in ./prescription.ts): je Zeile der 10-%-Anteil laut Spalte „davon
 * Zuzahlung (nachrichtlich)“ der Anlage 2 (`copayCents`, `null` = Position ohne Zuzahlung, z. B. 78530) und die
 * gedeckelte Pauschale von 10 € je Verordnung (`flatFeeCents`) – SGB V § 61 Satz 3, § 32 Abs. 2; Vertrag § 8 Abs. 1–2.
 */
import type { PriceSnapshot } from "./prescription";

/** Zahlarten der Zuzahlung (sofort erhalten, kein Zahlungslink): Bar/Karte sind Kassenvorgänge (TSE bzw. Praxiskasse) */
export const COPAYMENT_RECEIPT_METHODS = ["cash", "card", "transfer"] as const;
export type CopaymentReceiptMethod = (typeof COPAYMENT_RECEIPT_METHODS)[number];

/**
 * Pflichthinweis auf der Quittung (Review R2-6): Rechtsgrundlage der Zuzahlung, Quittungspflicht (§ 61 Satz 4 SGB V)
 * und Steuerbefreiung der Heilbehandlung (Annahme: Zuzahlung ist Teil des Entgelts für die steuerfreie Heilbehandlung).
 */
export const COPAYMENT_LEGAL_NOTE =
  "Gesetzliche Zuzahlung nach § 32 Abs. 2 i. V. m. § 61 SGB V (10 % der Kosten zzgl. 10 € je Verordnung); Quittung nach § 61 Satz 4 SGB V. Umsatzsteuerfrei nach § 4 Nr. 14 Buchst. a UStG.";

export type CopaymentBreakdown = {
  /** 10-%-Anteil je Position (nur zuzahlungspflichtige Positionen mit Betrag > 0), Reihenfolge wie im Snapshot */
  positions: { position: string; units: number; cents: number }[];
  /** Verordnungsblattgebühr (gedeckelt, 0 bei Befreiung/unter 18) */
  flatCents: number;
  totalCents: number;
};

/** Zuzahlung je Position + Pauschale aus einem Preis-Snapshot (Summe = `copaymentCents` des Snapshots). */
export function copaymentBreakdown(snap: Pick<PriceSnapshot, "lines" | "flatFeeCents" | "copaymentCents">): CopaymentBreakdown {
  const byPos = new Map<string, { position: string; units: number; cents: number }>();
  for (const l of snap.lines) {
    if (l.copayCents === null || l.copayCents <= 0) continue;
    const row = byPos.get(l.position) ?? { position: l.position, units: 0, cents: 0 };
    row.units += l.units;
    row.cents += l.copayCents;
    byPos.set(l.position, row);
  }
  const positions = [...byPos.values()];
  const percent = positions.reduce((s, p) => s + p.cents, 0);
  const flatCents = Math.max(0, snap.flatFeeCents);
  // Snapshot deckelt auf die Kosten (copaymentCents ≤ remedyCents) – Summe immer wie dort
  return { positions, flatCents, totalCents: Math.min(snap.copaymentCents, percent + flatCents) };
}

/** Quittungspositionen: bei genau der berechneten Zuzahlung je Position + Pauschale, sonst eine Zeile über den Betrag. */
export function copaymentReceiptLines(
  breakdown: CopaymentBreakdown | null,
  amountCents: number,
  opts: { prescriptionLabel: string; positionLabel?: (code: string) => string | null },
): { description: string; cents: number }[] {
  if (breakdown && breakdown.totalCents === amountCents && breakdown.totalCents > 0) {
    const lines = breakdown.positions.map((p) => {
      const label = opts.positionLabel?.(p.position);
      return { description: `Zuzahlung 10 % – Pos. ${p.position}${label ? ` ${label}` : ""} (${p.units} ${p.units === 1 ? "Einheit" : "Einheiten"})`, cents: p.cents };
    });
    if (breakdown.flatCents > 0) lines.push({ description: "Zuzahlung je Verordnung (Verordnungsblattgebühr)", cents: breakdown.flatCents });
    // Rundungs-/Deckelungsrest (Summe ≠ Anteil + Pauschale) nie stillschweigend verlieren
    const diff = amountCents - lines.reduce((s, l) => s + l.cents, 0);
    if (diff !== 0 && lines.length) lines[lines.length - 1] = { ...lines[lines.length - 1], cents: lines[lines.length - 1].cents + diff };
    if (lines.length) return lines;
  }
  return [{ description: `Zuzahlung zur ${opts.prescriptionLabel}`, cents: amountCents }];
}

const eur = (c: number) => `${(c / 100).toFixed(2).replace(".", ",")} €`;

/**
 * Text der berechneten Zuzahlung für die Quittung, wenn der Betrag davon abweicht (Teil-/Restbetrag). „bereits quittiert“
 * nennt nur Beträge mit Zuzahlungsquittung (ZZ-Beleg); ein Altvermerk (vor Paket B, ohne Beleg) steht gesondert
 * (Paket-B-Nachzug, Buchhaltung).
 */
export function copaymentExpectedNote(breakdown: CopaymentBreakdown | null, amountCents: number, receiptsCents: number, legacyCents = 0): string | null {
  if (!breakdown || breakdown.totalCents === amountCents) return null;
  const parts = breakdown.positions.map((p) => `Pos. ${p.position}: ${eur(p.cents)}`);
  if (breakdown.flatCents) parts.push(`je Verordnung: ${eur(breakdown.flatCents)}`);
  const rest = breakdown.totalCents - receiptsCents - legacyCents - amountCents;
  return `Berechnete Zuzahlung ${eur(breakdown.totalCents)}${parts.length ? ` (${parts.join(", ")})` : ""}${receiptsCents ? `, bereits quittiert ${eur(receiptsCents)}` : ""}${legacyCents ? `, Altvermerk ${eur(legacyCents)}` : ""}${rest > 0 ? `, offen nach dieser Zahlung ${eur(rest)}` : ""}.`;
}

/** Akte: bereits erhaltene Zuzahlung, getrennt nach Quittung (ZZ-Beleg) und Altvermerk; null, wenn beides 0 */
export function copaymentCollectedLabel(receiptsCents: number, legacyCents: number): string | null {
  const parts = [receiptsCents > 0 ? `quittiert ${eur(receiptsCents)}` : null, legacyCents > 0 ? `Altvermerk ${eur(legacyCents)}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export type LegacyCopayment = {
  /** angerechneter Betrag */
  cents: number;
  /** gilt als vollständig erhalten (Betrag unbekannt) – keine Quittung mehr */
  full: boolean;
  /** Betrag stand im Vermerk (copayment_paid_cents); sonst zuletzt gespeicherter Rechenwert der Verordnung */
  amountKnown: boolean;
};

/**
 * Altvermerk „Zuzahlung erhalten“ (vor Paket B) als bereits erhaltener Betrag: copayment_paid_cents, sonst der zuletzt
 * gespeicherte Rechenwert der Verordnung (copayment_cents – nicht zwingend der Stand beim Vermerk). Ohne Betrag und ohne
 * Rechenwert > 0 gilt der Vermerk als vollständig erhalten (`full`): so entsteht keine Quittung über bereits Erhaltenes
 * (Paket-B-Nachzug: copayment_cents = 0 bewusst wie „unbekannt“).
 */
export function legacyCopayment(vo: { copaymentPaidAt: Date | string | null; copaymentPaidCents: number | null; copaymentCents: number | null }): LegacyCopayment | null {
  if (!vo.copaymentPaidAt) return null;
  if (vo.copaymentPaidCents !== null) return { cents: vo.copaymentPaidCents, full: false, amountKnown: true };
  if (vo.copaymentCents === null || vo.copaymentCents <= 0) return { cents: 0, full: true, amountKnown: false };
  return { cents: vo.copaymentCents, full: false, amountKnown: false };
}

/** Hinweis auf der Zuzahlungsquittung zum angerechneten Altvermerk */
export function legacyCopaymentNote(legacy: LegacyCopayment): string {
  return legacy.amountKnown
    ? `Früher als „Zuzahlung erhalten“ vermerkt: ${eur(legacy.cents)} – angerechnet (ohne Beleg in PodoHero).`
    : `Früher als „Zuzahlung erhalten“ ohne Betrag vermerkt – angerechnet mit der berechneten Zuzahlung ${eur(legacy.cents)} (ohne Beleg in PodoHero).`;
}

/**
 * Formular „Zuzahlung erhalten“ in der Akte: ohne Preis (manuell), solange nichts als erledigt gilt (ein voller Altvermerk
 * setzt openCents auf 0); mit Berechnung nur bei offenem Betrag.
 */
export function copaymentFormVisible(due: { manual: boolean; openCents: number | null }): boolean {
  return due.manual ? due.openCents !== 0 : (due.openCents ?? 0) > 0;
}
