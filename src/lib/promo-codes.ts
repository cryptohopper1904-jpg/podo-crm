/**
 * Aktionscodes (SaaS-Testphase des Plattform-Betreibers) – reine, testbare Regeln.
 * Nicht zu verwechseln mit den Gutscheinen der Praxis für Patient:innen (/gutscheine).
 *
 * - Code: 4–32 Zeichen, nur A–Z, 0–9 und „-“ (nicht am Anfang/Ende). Eingaben werden normalisiert
 *   (Groß-/Kleinschreibung egal, Leerzeichen entfernt). Gleiches Format prüft die DB (CHECK, 0034).
 * - Testphase: neues Ende = max(bisheriges Ende, jetzt + Testtage) – ein Code verkürzt nie eine laufende Testphase.
 * - Je Praxis höchstens EIN Code (unique in promo_redemptions), nicht bei laufendem bezahlten Abo.
 * - Fehlermeldung nach außen immer gleich (PROMO_INVALID): kein Hinweis, ob ein Code existiert, abgelaufen oder aufgebraucht ist.
 */
import { randomInt } from "node:crypto";
import { isPaidPlan, PAID_PLANS, type PaidPlan } from "./plans";

export const PROMO_INVALID = "Code ungültig oder abgelaufen.";
export const PROMO_CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,30}[A-Z0-9]$/;
export const PROMO_MAX_TRIAL_DAYS = 365;
/** Vorschlag in der Konsole: 3 Monate */
export const PROMO_DEFAULT_TRIAL_DAYS = 90;
/** Tarife, deren Umfang ein Code während der Testphase gewähren kann (null = Testphase mit allen Funktionen) */
export const PROMO_GRANT_PLANS: readonly PaidPlan[] = PAID_PLANS;

const DAY = 86_400_000;

/** Normalisiert eine Eingabe („ podo-herbst 26 “ → „PODO-HERBST26“); null, wenn kein gültiges Format. */
export function normalizePromoCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const v = input.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
  if (v.length > 32) return null;
  return PROMO_CODE_RE.test(v) ? v : null;
}

/** Ohne leicht verwechselbare Zeichen (0/O, 1/I/L) */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Zufälliger Code, z. B. „PODO-7KQ4-M2XH“ (ca. 40 bit Zufall – Raten ist bei Rate-Limit aussichtslos). */
export function generatePromoCode(prefix = "PODO", rnd: (max: number) => number = randomInt): string {
  const part = () => Array.from({ length: 4 }, () => ALPHABET[rnd(ALPHABET.length)]).join("");
  const p = normalizePromoCode(prefix) ? prefix.toUpperCase() : "PODO";
  return `${p}-${part()}-${part()}`.slice(0, 32);
}

/** Neues Ende der Testphase: max(bisheriges Ende, jetzt + Tage). */
export function promoTrialEnd(current: Date | null, now: Date, days: number): Date {
  if (!Number.isInteger(days) || days < 1 || days > PROMO_MAX_TRIAL_DAYS) throw new Error("Testtage ungültig");
  const target = now.getTime() + days * DAY;
  return new Date(Math.max(current?.getTime() ?? 0, target));
}

export type PromoCodeState = { active: boolean; validUntil: Date | null; maxRedemptions: number | null; redemptions: number };

/** Kann der Code jetzt eingelöst werden? (aktiv, nicht abgelaufen, Obergrenze nicht erreicht) */
export function promoCodeUsable(c: PromoCodeState, now: Date): boolean {
  if (!c.active) return false;
  if (c.validUntil && c.validUntil.getTime() <= now.getTime()) return false;
  if (c.maxRedemptions !== null && c.redemptions >= c.maxRedemptions) return false;
  return true;
}

export type PromoOrg = { plan: string; subscriptionStatus: string; stripeSubscriptionId?: string | null };

/**
 * Darf diese Praxis (später, auf der Abo-Seite) einen Code einlösen? Erlaubt in der Testphase, nach Ablauf der
 * Testphase (Nur-Lesen), im Kostenlos-Tarif und nach beendetem Abo. Nicht bei laufendem bezahlten Abo und nicht
 * für interne Praxen. null = erlaubt, sonst Grund (bezieht sich nur auf die eigene Praxis, nicht auf den Code).
 */
export function promoRedemptionProblem(org: PromoOrg): string | null {
  if (org.plan === "internal") return "Interne Praxen brauchen keinen Aktionscode.";
  const running = ["active", "past_due", "paused"].includes(org.subscriptionStatus) || (org.subscriptionStatus === "trialing" && !!org.stripeSubscriptionId);
  if (running && org.plan !== "free") return "Bei einem laufenden Abo kann kein Aktionscode eingelöst werden.";
  return null;
}

/** Praxis hat (inzwischen) ein bezahltes Abo – „umgewandelt“ in der Auswertung. */
export const isPayingOrg = (org: { plan: string; subscriptionStatus: string }) => org.subscriptionStatus === "active" && isPaidPlan(org.plan);

/** Registrierungslink mit Code */
export function promoSignupUrl(publicUrl: string | undefined, code: string): string {
  const base = (publicUrl ?? "").replace(/\/+$/, "");
  return `${base}/einrichtung?code=${encodeURIComponent(code)}`;
}

/** Kurzer Aktionslink (öffentliche Landing-Seite) */
export function promoLandingUrl(publicUrl: string | undefined, code: string): string {
  const base = (publicUrl ?? "").replace(/\/+$/, "");
  return `${base}/aktion/${encodeURIComponent(code)}`;
}

/** „3 Monate“ / „45 Tage“ / „1 Jahr“ für Texte */
export function trialDaysLabel(days: number): string {
  if (days === 365) return "1 Jahr";
  if (days % 30 === 0 && days >= 60) return `${days / 30} Monate`;
  if (days === 30) return "1 Monat";
  return `${days} Tage`;
}
