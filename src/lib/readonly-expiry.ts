/**
 * Ende des Nur-Lesen-Modus (AGB § 9 Nr. 2, AVV § 10 Nr. 2): Nach Vertragsende (Abo beendet bzw. Testphase abgelaufen)
 * bleibt die Praxis höchstens 12 Monate lesbar und exportierbar, danach wird sie gelöscht. Ablauf (Cron
 * /api/cron/nur-lesen, src/server/readonly-expiry.ts):
 *  1. Ankündigung (E-Mail an Inhaber:innen + Posteingang + Hinweisleiste) ab NOTICE_LEAD_DAYS vor dem Löschtermin.
 *  2. Automatischer Löschantrag (deletionRequestedAt, settings.deletionReason = AUTO_DELETION_REASON) ab
 *     DELETION_GRACE_DAYS vor dem Löschtermin – frühestens mit der Ankündigung. Der bestehende Löschlauf löscht erst
 *     DELETION_GRACE_DAYS nach dem Antrag; die Ankündigung liegt also immer mindestens 30 Tage vor der Löschung.
 *  3. Zweite Erinnerung REMINDER_LEAD_DAYS vor dem tatsächlichen Löschtermin (Antrag + Karenzzeit).
 * Bucht die Praxis einen Tarif (auch kostenlos), endet der Nur-Lesen-Modus – Ankündigung und automatischer Antrag
 * entfallen (stopAutoDeletion, zusätzlich prüft der Löschlauf das selbst).
 * Rein (ohne DB) – testbar; auch vom Löschlauf (scripts/purge-organizations.ts) verwendet.
 */
import { DELETION_GRACE_DAYS } from "./org-deletion";
import { accessMode, type OrgBilling } from "./plans";
import { hasRunningSubscription } from "./subscription-cancel";

export const READONLY_MAX_MONTHS = 12;
/** Grund des automatischen Löschantrags (organizations.settings.deletionReason) */
export const AUTO_DELETION_REASON = "auto_readonly_expiry";
/** Erste Ankündigung: 44 Tage vor dem Löschtermin, d. h. 14 Tage vor dem automatischen Antrag (Puffer für ausgefallene Cron-Läufe) */
export const NOTICE_LEAD_DAYS = DELETION_GRACE_DAYS + 14;
/** Zweite Erinnerung: 7 Tage vor dem tatsächlichen Löschtermin */
export const REMINDER_LEAD_DAYS = 7;

const DAY = 86_400_000;

export type ReadonlyExpiryOrg = OrgBilling & { stripeSubscriptionId: string | null };

export type ReadonlyExpiry = {
  /** Vertragsende: Ende des bezahlten Zeitraums bzw. der Testphase */
  contractEnd: Date;
  /** spätester Löschtermin: Vertragsende + 12 Monate */
  deletionAt: Date;
  /** ab hier wird der automatische Löschantrag gestellt (deletionAt − Karenzzeit) */
  requestAt: Date;
  /** ab hier wird angekündigt */
  noticeAt: Date;
};

/** Kalendermonate addieren (UTC); fällt der Tag weg (31. → Februar), gilt der letzte Tag des Monats. */
export function addMonthsUtc(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}

/**
 * Fristen, wenn die Praxis nach Vertragsende im Nur-Lesen-Modus ist – sonst null (Tarif aktiv, Testphase läuft,
 * Kostenlos/Intern, Zahlung nur überfällig oder ein Stripe-Abo läuft noch).
 */
export function readonlyExpiry(org: ReadonlyExpiryOrg, now: Date = new Date()): ReadonlyExpiry | null {
  if (org.plan === "free" || org.plan === "internal") return null;
  const access = accessMode(org, now);
  if (access.mode !== "readonly" || access.reason === "payment_overdue") return null;
  // ein (laut letztem Stand) laufendes Stripe-Abo – z. B. pausiert – ist kein Vertragsende
  if (hasRunningSubscription(org)) return null;
  const contractEnd = access.reason === "trial_expired" ? org.trialEndsAt : (org.currentPeriodEnd ?? org.trialEndsAt);
  if (!contractEnd) return null;
  const deletionAt = addMonthsUtc(contractEnd, READONLY_MAX_MONTHS);
  return {
    contractEnd,
    deletionAt,
    requestAt: new Date(deletionAt.getTime() - DELETION_GRACE_DAYS * DAY),
    noticeAt: new Date(deletionAt.getTime() - NOTICE_LEAD_DAYS * DAY),
  };
}

export type MailOutcome = "sent" | "not_configured" | "failed" | "no_recipient";

/** Zustand in organizations.settings.readonlyExpiry */
export type ReadonlyExpiryState = {
  /** angekündigter Löschtermin (ISO) */
  deletionAt: string | null;
  noticeSentAt: string | null;
  noticeMail: MailOutcome | null;
  reminderSentAt: string | null;
  reminderMail: MailOutcome | null;
};

const iso = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
const outcome = (v: unknown): MailOutcome | null => (v === "sent" || v === "not_configured" || v === "failed" || v === "no_recipient" ? v : null);

export function readonlyExpiryState(settings: Record<string, unknown> | null | undefined): ReadonlyExpiryState {
  const s = (settings?.readonlyExpiry ?? {}) as Record<string, unknown>;
  return {
    deletionAt: iso(s.deletionAt),
    noticeSentAt: iso(s.noticeSentAt),
    noticeMail: outcome(s.noticeMail),
    reminderSentAt: iso(s.reminderSentAt),
    reminderMail: outcome(s.reminderMail),
  };
}

export const isAutoDeletion = (settings: Record<string, unknown> | null | undefined) => settings?.deletionReason === AUTO_DELETION_REASON;

/**
 * Voraussichtlicher Löschtermin für Hinweise in der App: bei gestelltem Antrag dessen Fälligkeit, nach der Ankündigung
 * der angekündigte Termin, sonst der späteste Termin – frühestens 30 Tage ab jetzt (Ankündigungsfrist).
 */
export function plannedDeletionDate(
  info: ReadonlyExpiry,
  state: ReadonlyExpiryState,
  deletionRequestedAt: Date | null,
  now: Date = new Date(),
): Date {
  if (deletionRequestedAt) return new Date(deletionRequestedAt.getTime() + DELETION_GRACE_DAYS * DAY);
  const candidates = [info.deletionAt.getTime(), now.getTime() + DELETION_GRACE_DAYS * DAY];
  if (state.deletionAt) candidates.push(Date.parse(state.deletionAt));
  return new Date(Math.max(...candidates));
}
