/**
 * Aktionscodes (SaaS-Testphase des Plattform-Betreibers) – reine, testbare Regeln.
 * Nicht zu verwechseln mit den Gutscheinen der Praxis für Patient:innen (/gutscheine).
 *
 * - Code: 4–32 Zeichen, nur A–Z, 0–9 und „-“ (nicht am Anfang/Ende). Eingaben werden normalisiert
 *   (Groß-/Kleinschreibung egal, Leerzeichen entfernt). Gleiches Format prüft die DB (CHECK, 0040).
 * - Testphase: neues Ende = max(bisheriges Ende, jetzt + Testtage) – ein Code verkürzt nie eine laufende Testphase.
 * - Je Praxis höchstens EIN Code (unique in promo_redemptions), nicht bei laufendem bezahlten Abo.
 * - Fehlermeldung nach außen immer gleich (PROMO_INVALID): kein Hinweis, ob ein Code existiert, abgelaufen oder aufgebraucht ist.
 */
import { randomInt } from "node:crypto";
import { dateDe, moneyShort } from "./format";
import { FEATURE_LABELS, FEATURES, FREE_MAX_PATIENTS, isPaidPlan, PAID_PLANS, PLANS, seatSummary, type PaidPlan } from "./plans";

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
 * Testphase (Nur-Lesen), im Kostenlos-Tarif und nach beendetem Abo. Nicht bei laufendem Abo und nicht für interne Praxen.
 * „Laufendes Abo“ = Stripe-Abo-ID gesetzt und Status nicht „canceled“ (auch z. B. „none“ während einer SEPA-Zahlung)
 * oder ein vom Betreiber aktiv gesetzter bezahlter Tarif. null = erlaubt, sonst Grund (betrifft nur die eigene Praxis).
 */
export function promoRedemptionProblem(org: PromoOrg): string | null {
  if (org.plan === "internal") return "Interne Praxen brauchen keinen Aktionscode.";
  const stripeRunning = !!org.stripeSubscriptionId && org.subscriptionStatus !== "canceled";
  const manualPaid = isPaidPlan(org.plan) && ["active", "past_due", "paused"].includes(org.subscriptionStatus);
  if (stripeRunning || manualPaid) return "Bei einem laufenden Abo kann kein Aktionscode eingelöst werden.";
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

/** Laufzeit als Text – immer in Tagen (verbindlich), bei vollen 30-Tage-Blöcken mit Monaten als Orientierung: „90 Tage (ca. 3 Monate)“ */
export function trialDaysLabel(days: number): string {
  if (days % 30 === 0 && days >= 60) return `${days} Tage (ca. ${days / 30} Monate)`;
  if (days === 365) return "365 Tage (ca. 1 Jahr)";
  return days === 1 ? "1 Tag" : `${days} Tage`;
}

/** Format der Zufallscodes aus generatePromoCode() mit Standard-Präfix – alles andere gilt als selbst gewählt */
export const isGeneratedPromoCode = (code: string) => new RegExp(`^PODO-[${ALPHABET}]{4}-[${ALPHABET}]{4}$`).test(code);

/** Mindestlänge selbst gewählter Codes (Zufallscodes aus generatePromoCode sind länger) */
export const PROMO_OWN_MIN_LENGTH = 6;

/**
 * Regeln für selbst gewählte (nicht zufällig erzeugte) Codes: mindestens 6 Zeichen und begrenzt –
 * Höchstzahl Einlösungen ODER Ablaufdatum Pflicht (leicht zu erratende Codes dürfen nicht unbegrenzt gelten).
 */
export function ownCodeProblem(code: string, maxRedemptions: number | null, validUntil: Date | null): string | null {
  if (code.length < PROMO_OWN_MIN_LENGTH) return `Selbst gewählte Codes brauchen mindestens ${PROMO_OWN_MIN_LENGTH} Zeichen.`;
  if (maxRedemptions === null && !validUntil) return "Selbst gewählte Codes brauchen eine Höchstzahl an Einlösungen oder ein Ablaufdatum.";
  return null;
}

/**
 * Ende des Tages `yyyy-mm-dd` (23:59:59) in Europe/Berlin als Zeitpunkt – mit Sommer-/Winterzeit.
 * null bei ungültigem Datum.
 */
export function endOfDayBerlin(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  for (const off of ["+02:00", "+01:00"]) {
    const d = new Date(`${ymd}T23:59:59${off}`);
    if (Number.isNaN(d.getTime())) return null;
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    if (`${p.year}-${p.month}-${p.day}` === ymd && p.hour === "23" && p.minute === "59") return d;
  }
  return null;
}

/** Günstigster bezahlter Tarif (netto/Monat, aus plans.ts) */
export const cheapestPaidCents = () => Math.min(...PAID_PLANS.map((p) => PLANS[p].priceCents));

/** Was der kostenlose Tarif nicht enthält, z. B. „Patientenportal, KI-Telefonagent und Praxis-Website“ (aus plans.ts) */
function freeMissing(): string {
  const missing = FEATURES.filter((f) => !PLANS.free.features.includes(f)).map((f) => FEATURE_LABELS[f]);
  return missing.length > 1 ? `${missing.slice(0, -1).join(", ")} und ${missing[missing.length - 1]}` : (missing[0] ?? "");
}

/**
 * Aktionsbedingungen (Aktionsseite, id="bedingungen"). Preise und Umfang des kostenlosen Tarifs aus plans.ts.
 * `validUntil`/`limited` aus lookupPromoCode – keine Angabe, wie viele Einlösungen übrig sind.
 */
export function promoTermsText(o: { validUntil: Date | null; limited: boolean }): string {
  const until = o.validUntil ? `bis ${dateDe(o.validUntil)}` : "bis auf Widerruf";
  const missing = freeMissing();
  return [
    "Aktionsbedingungen: Nur für Unternehmer:innen (Praxen).",
    `Einlösbar ${until}${o.limited ? ", nur in begrenzter Anzahl" : ""}.`,
    "Je Praxis ein Aktionscode, nicht bei einem laufenden bezahlten Abo.",
    "Eine längere laufende Testphase wird nicht verkürzt.",
    "Keine Barauszahlung, nicht mit anderen Aktionen kombinierbar.",
    "Die Testphase endet automatisch, es wird nichts berechnet und kein Abo abgeschlossen.",
    `Danach können Sie einen Tarif buchen (ab ${moneyShort(cheapestPaidCents())} netto/Monat zzgl. USt.) oder in den kostenlosen Tarif wechseln (höchstens ${FREE_MAX_PATIENTS} Patient:innen einschließlich archivierter, ${seatSummary("free")}${missing ? `, ohne ${missing}` : ""}).`,
    `Praxen, die den Code im kostenlosen Tarif eingelöst haben, kehren danach automatisch in diesen zurück (spätestens in der folgenden Nacht, sofern höchstens ${FREE_MAX_PATIENTS} Patient:innen einschließlich archivierter; weitere Nutzerzugänge außer der Steuerberatung werden dabei deaktiviert).`,
    "Ohne Wahl bleibt die Praxis nur lesbar, alle Daten bleiben exportierbar.",
    "Es gelten die AGB.",
  ].join(" ");
}

/** Abo-Seite, Kostenlos-Tarif vor dem Einlösen (Rückkehr umgesetzt in returnPromoTrialToFree, src/server/billing.ts) */
export const PROMO_FREE_RETURN_NOTE_BEFORE = `Ihre Praxis nutzt den kostenlosen Tarif. Mit dem Code wechselt sie in die Testphase. Danach kehrt sie automatisch in den kostenlosen Tarif zurück (spätestens in der folgenden Nacht), wenn sie höchstens ${FREE_MAX_PATIENTS} Patient:innen (einschließlich archivierter) hat – sonst ist sie bis zur Buchung eines Tarifs nur lesbar. Weitere Personen werden dann deaktiviert (die Steuerberatung bleibt). Sofort geht es jederzeit mit „Kostenlos weiter nutzen“.`;
/** Abo-Seite, während einer aus dem Kostenlos-Tarif begonnenen Code-Testphase */
export const PROMO_FREE_RETURN_NOTE = `Nach dem Ende der Testphase kehrt die Praxis automatisch in den kostenlosen Tarif zurück (spätestens in der folgenden Nacht), wenn sie höchstens ${FREE_MAX_PATIENTS} Patient:innen (einschließlich archivierter) hat (sonst nur lesbar bis zur Buchung eines Tarifs). Weitere Personen werden dann deaktiviert (die Steuerberatung bleibt). Sofort geht es jederzeit mit „Kostenlos weiter nutzen“.`;
