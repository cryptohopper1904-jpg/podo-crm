/**
 * Ende des Nur-Lesen-Modus (AGB § 9 Nr. 2, AVV § 10 Nr. 2): Nach Vertragsende (Abo beendet bzw. Testphase abgelaufen)
 * bleibt die Praxis höchstens 12 Monate lesbar und exportierbar, danach wird sie gelöscht. Ablauf (Cron
 * /api/cron/nur-lesen, src/server/readonly-expiry.ts):
 *  1. Ankündigung (E-Mail an Inhaber:innen + Posteingang + Hinweisleiste) ab NOTICE_LEAD_DAYS vor dem Löschtermin.
 *  2. Automatischer Löschantrag (deletionRequestedAt, settings.deletionReason = AUTO_DELETION_REASON) ab
 *     DELETION_GRACE_DAYS vor dem angekündigten Löschtermin – NUR wenn die Ankündigung nachweislich in Textform
 *     zugegangen ist (noticeDeliveredAt: E-Mail versendet oder Betreiber-Vermerk aus der Plattform-Konsole). Der
 *     Löschlauf löscht erst DELETION_GRACE_DAYS nach dem Antrag und nie vor dem angekündigten Termin; der Termin liegt
 *     immer mindestens 30 Tage nach der zugegangenen Ankündigung (AGB § 9 Nr. 2: sonst verlängert sich der Nur-Lesen-Modus).
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

/**
 * Schalter für den Cron /api/cron/nur-lesen (Standard: aus). Erst einschalten, wenn der Plattform-SMTP nachweislich
 * zustellt (docs/BETRIEB.md Abschnitt 9) – ohne zugestellte Ankündigung wird ohnehin nicht automatisch gelöscht.
 */
export const readonlyExpiryEnabled = (env: Record<string, string | undefined> = process.env) => env.READONLY_EXPIRY_ENABLED === "1";

const DAY = 86_400_000;

export type ReadonlyExpiryOrg = OrgBilling & { stripeSubscriptionId: string | null };

export type ReadonlyExpiry = {
  /** Testphase abgelaufen oder Abo beendet (für den Text der Ankündigung) */
  kind: "trial" | "contract";
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
    kind: access.reason === "trial_expired" ? "trial" : "contract",
    contractEnd,
    deletionAt,
    requestAt: new Date(deletionAt.getTime() - DELETION_GRACE_DAYS * DAY),
    noticeAt: new Date(deletionAt.getTime() - NOTICE_LEAD_DAYS * DAY),
  };
}

/** „unknown“: Ankündigung beansprucht, Lauf danach abgebrochen – gilt wie „nicht versendet“ */
export type MailOutcome = "sent" | "not_configured" | "failed" | "no_recipient" | "unknown";
export const MAIL_NOT_SENT: readonly MailOutcome[] = ["not_configured", "failed", "no_recipient", "unknown"];

/** Wege einer von Hand verschickten Ankündigung in Textform (Plattform-Konsole) */
export const MANUAL_NOTICE_VIAS = { email: "E-Mail (eigenes Postfach)", letter: "Brief", fax: "Fax", other: "anderer Weg in Textform" } as const;
export type ManualNoticeVia = keyof typeof MANUAL_NOTICE_VIAS;

/** Zustand in organizations.settings.readonlyExpiry */
export type ReadonlyExpiryState = {
  /** angekündigter Löschtermin (ISO) */
  deletionAt: string | null;
  noticeSentAt: string | null;
  noticeMail: MailOutcome | null;
  reminderSentAt: string | null;
  reminderMail: MailOutcome | null;
  /** Betreiber-Vermerk: Ankündigung von Hand in Textform verschickt (Zugang am …) */
  manualNoticeAt: string | null;
  manualNoticeVia: ManualNoticeVia | null;
};

const iso = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
const outcome = (v: unknown): MailOutcome | null => (v === "sent" || (MAIL_NOT_SENT as readonly unknown[]).includes(v) ? (v as MailOutcome) : null);
const via = (v: unknown): ManualNoticeVia | null => (typeof v === "string" && Object.hasOwn(MANUAL_NOTICE_VIAS, v) ? (v as ManualNoticeVia) : null);

export function readonlyExpiryState(settings: Record<string, unknown> | null | undefined): ReadonlyExpiryState {
  const s = (settings?.readonlyExpiry ?? {}) as Record<string, unknown>;
  return {
    deletionAt: iso(s.deletionAt),
    noticeSentAt: iso(s.noticeSentAt),
    noticeMail: outcome(s.noticeMail),
    reminderSentAt: iso(s.reminderSentAt),
    reminderMail: outcome(s.reminderMail),
    manualNoticeAt: iso(s.manualNoticeAt),
    manualNoticeVia: via(s.manualNoticeVia),
  };
}

/**
 * Zugang der Ankündigung in Textform: E-Mail versendet (Zeitpunkt der Ankündigung) oder Betreiber-Vermerk (Zugang am …).
 * null = nicht nachweislich zugegangen → kein automatischer Löschantrag, keine automatische Löschung.
 */
export function noticeDeliveredAt(state: ReadonlyExpiryState): Date | null {
  const t: number[] = [];
  if (state.noticeSentAt && state.noticeMail === "sent") t.push(Date.parse(state.noticeSentAt));
  if (state.manualNoticeAt) t.push(Date.parse(state.manualNoticeAt));
  return t.length ? new Date(Math.min(...t)) : null;
}

/** Angekündigt, aber nicht nachweislich zugegangen: Betreiber muss von Hand in Textform ankündigen (Plattform-Konsole). */
export const needsManualNotice = (state: ReadonlyExpiryState) => !!state.noticeSentAt && !noticeDeliveredAt(state);

/**
 * Frühester zulässiger Löschtermin nach der Ankündigung: angekündigter Termin, aber nie vor Zugang + 30 Tagen.
 * null = Ankündigung nicht zugegangen.
 */
export function earliestAutoDeletion(state: ReadonlyExpiryState): Date | null {
  const delivered = noticeDeliveredAt(state);
  if (!delivered) return null;
  const t = [delivered.getTime() + DELETION_GRACE_DAYS * DAY];
  if (state.deletionAt) t.push(Date.parse(state.deletionAt));
  return new Date(Math.max(...t));
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
  // angekündigt, aber (noch) nicht nachweislich zugegangen: frühestens 30 Tage nach einer künftigen Ankündigung
  const earliest = earliestAutoDeletion(state);
  if (earliest) candidates.push(earliest.getTime());
  return new Date(Math.max(...candidates));
}
