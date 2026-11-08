/** Kasse – Stückelungen und Bewegungsarten (ohne Server-Importe, auch im Browser nutzbar). */
import type { CashClosingTse } from "@/db/schema";

// ───────────────────────── Zählprotokoll ─────────────────────────
/** Stückelungen in Cent (Euro-Scheine und -Münzen) */
export const DENOMINATIONS = [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1] as const;
export const denominationLabel = (c: number) => (c >= 100 ? `${c / 100} €` : `${c} ct`);
export const isNote = (c: number) => c >= 500;

/** Prüft/normalisiert ein Zählprotokoll (nur bekannte Stückelungen, ganze Stückzahlen 0…100.000). */
export function normalizeDenominations(input: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of DENOMINATIONS) {
    const raw = input[String(d)];
    if (raw === undefined || raw === null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 100_000) throw new Error(`Ungültige Stückzahl für ${denominationLabel(d)}.`);
    if (n > 0) out[String(d)] = n;
  }
  for (const k of Object.keys(input)) if (!DENOMINATIONS.includes(Number(k) as never)) throw new Error("Unbekannte Stückelung im Zählprotokoll.");
  return out;
}

export const countedTotal = (den: Record<string, number>) => Object.entries(den).reduce((s, [c, n]) => s + Number(c) * n, 0);

// ───────────────────────── Einlagen / Entnahmen ─────────────────────────
export const MOVEMENT_KINDS = ["private_deposit", "private_withdrawal", "transit_in", "transit_out", "payout", "payin"] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];
export const MOVEMENT_LABEL: Record<MovementKind, string> = {
  private_deposit: "Privateinlage",
  private_withdrawal: "Privatentnahme",
  transit_in: "Geldtransit Bank → Kasse",
  transit_out: "Geldtransit Kasse → Bank",
  payout: "Auszahlung (Ausgabe, z. B. Porto)",
  payin: "Einzahlung (sonstige)",
};
/** Vorzeichen in der Kasse: +1 Einlage, −1 Entnahme */
export const MOVEMENT_SIGN: Record<MovementKind, 1 | -1> = {
  private_deposit: 1,
  private_withdrawal: -1,
  transit_in: 1,
  transit_out: -1,
  payout: -1,
  payin: 1,
};


// ───────────────────────── TSE-Kennzeichnung ─────────────────────────
export const tseLabel = (t: CashClosingTse, reg?: { closingRef: string; tssSerial: string | null } | null) => {
  if (t.mode !== "fiskaly")
    return `Ohne TSE – nur zulässig, wenn keine elektronische Kasse im Sinne der KassenSichV${t.testSignatures ? " (Kassenvorgänge mit Test-Signaturen, keine gültige TSE)" : ""}`;
  const serial = reg?.tssSerial ?? t.tssSerial;
  const ref = reg?.closingRef ?? t.exportRef;
  return `TSE (fiskaly)${serial ? ` – Seriennr. ${serial}` : ""}${ref ? ` – Meldung ${ref}` : t.registration === "pending" ? " – Meldung an den TSE-Dienst ausstehend" : ""}${t.testSignatures ? " – enthält Vorgänge mit Test-Signatur" : ""}`;
};

