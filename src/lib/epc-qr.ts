/**
 * GiroCode / EPC-QR-Code (EPC069-12, Version 002) für Überweisungen – reine Funktionen ohne Server-Importe.
 *
 * Aufbau (Zeilen, getrennt durch LF):
 *   1 BCD · 2 002 · 3 1 (UTF-8) · 4 SCT · 5 BIC (optional) · 6 Name (≤ 70) · 7 IBAN · 8 EUR<Betrag>
 *   9 Purpose (leer) · 10 strukturierte Referenz (leer) · 11 Verwendungszweck (≤ 140) · [12 Hinweis, entfällt]
 * Gesamtlänge höchstens 331 Byte. Fehlerkorrektur des QR-Codes: Stufe M.
 */

/** IBAN-Länge je SEPA-Land (EPC-Liste); andere Länder sind für SEPA-Überweisungen nicht zulässig. */
const IBAN_LENGTH: Record<string, number> = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27, GB: 22, GI: 23,
  GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28,
  PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27, VA: 22,
};

export const normalizeIban = (iban: string) => iban.replace(/[\s-]/g, "").toUpperCase();

/** Prüft Format, Länge (SEPA-Land) und Prüfziffer (ISO 13616, mod 97). */
export function isValidIban(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  const len = IBAN_LENGTH[iban.slice(0, 2)];
  if (!len || iban.length !== len) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of rearranged) {
    const v = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

export const normalizeBic = (bic: string) => bic.replace(/\s/g, "").toUpperCase();
export const isValidBic = (raw: string | null | undefined) => !!raw && /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(normalizeBic(raw));

/** Betrag im EPC-Format „EUR12.30“ (Punkt, zwei Nachkommastellen, 0,01 € bis 999.999.999,99 €). */
export function epcAmount(cents: number): string {
  if (!Number.isInteger(cents) || cents < 1 || cents > 99_999_999_999) throw new RangeError("Betrag außerhalb des EPC-Bereichs");
  return `EUR${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** Zeilenumbrüche/Steuerzeichen entfernen, Leerraum zusammenfassen, auf max Zeichen kürzen. */
const clean = (s: string, max: number) =>
  [...[...s].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c)).join("").replace(/\s+/g, " ").trim()].slice(0, max).join("").trim();

export type EpcInput = { name: string; iban: string; bic?: string | null; amountCents: number; remittance: string };

/** EPC-Nutzdaten oder null, wenn eine Pflichtangabe fehlt/ungültig ist. */
export function epcPayload(input: EpcInput): string | null {
  const name = clean(input.name, 70);
  if (!name || !isValidIban(input.iban)) return null;
  if (!Number.isInteger(input.amountCents) || input.amountCents < 1 || input.amountCents > 99_999_999_999) return null;
  const bic = input.bic && isValidBic(input.bic) ? normalizeBic(input.bic) : "";
  const lines = ["BCD", "002", "1", "SCT", bic, name, normalizeIban(input.iban), epcAmount(input.amountCents), "", "", clean(input.remittance, 140)];
  const out = lines.join("\n");
  // Grenze laut Spezifikation (Bytes, UTF-8)
  return new TextEncoder().encode(out).length <= 331 ? out : null;
}

type PayInvoice = { kind: string; status: string; number: string | null; totalCents: number; paidCents: number };
type PayOrg = { name: string; legalName: string | null; accountHolder?: string | null; iban: string | null; bic?: string | null };

/**
 * GiroCode für eine Rechnung – nur wenn per Überweisung noch etwas zu zahlen ist:
 * ausgestellte bzw. teilbezahlte Rechnung (keine Quittung/Anzahlung/Storno), offener Betrag > 0, gültige IBAN.
 */
export function invoicePaymentQr(inv: PayInvoice, o: PayOrg): string | null {
  if (inv.kind === "receipt" || inv.kind === "deposit" || inv.kind === "credit_note") return null;
  if (inv.status !== "issued" && inv.status !== "partially_paid") return null;
  const open = inv.totalCents - inv.paidCents;
  if (open <= 0 || !inv.number) return null;
  return epcPayload({
    name: o.accountHolder?.trim() || o.legalName?.trim() || o.name,
    iban: o.iban ?? "",
    bic: o.bic,
    amountCents: open,
    remittance: `Rechnung ${inv.number}`,
  });
}
