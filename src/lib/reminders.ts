/**
 * Automatische Erinnerungen & Rückholung – reine Planungsfunktionen (ohne DB/Server-Importe, testbar).
 * Der Runner (src/server/reminders.ts) lädt die Kandidaten, ruft `planReminders` auf und versendet.
 *
 * Datenschutz:
 *  - Texte enthalten KEINE medizinischen Angaben (keine Leistung, kein Befund, kein „Kontrolle der Spange“).
 *  - Versand nur mit Einwilligung für den Kanal: email_reminders → E-Mail, sms_reminders → SMS, whatsapp → WhatsApp.
 *  - Terminerinnerung/Rückholung im bestehenden Behandlungsverhältnis ist keine Werbung (§ 7 UWG) –
 *    trotzdem nur mit Erinnerungs-Einwilligung; Newsletter/Kampagnen bleiben an „marketing“ gebunden.
 */
import { berlinDateIso, dateDe, timeDe } from "./format";
import { patientStatus } from "./patient-status";

export type ReminderKind = "reminder_24h" | "recall" | "brace_check" | "waitlist_offer";
export type ReminderChannel = "email" | "sms" | "whatsapp";

export type ReminderSettings = { r24: boolean; recall: boolean; braceCheck: boolean; recallAfterWeeks: number };
export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = { r24: false, recall: false, braceCheck: false, recallAfterWeeks: 6 };

export function parseReminderSettings(raw: unknown): ReminderSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const weeks = Number(r.recallAfterWeeks);
  return {
    r24: r.r24 === true,
    recall: r.recall === true,
    braceCheck: r.braceCheck === true,
    recallAfterWeeks: Number.isInteger(weeks) && weeks >= 2 && weeks <= 104 ? weeks : DEFAULT_REMINDER_SETTINGS.recallAfterWeeks,
  };
}

/** Fenster für die 24-h-Erinnerung (Runner läuft alle 15 Minuten; Dedupe verhindert Doppelversand). */
export const R24_WINDOW = { fromHours: 20, toHours: 28 };
export const RECALL_MIN_DAYS = 30;
export const BRACE_CHECK_DAYS = 28;

const CONSENT_FOR: Record<ReminderChannel, "email_reminders" | "sms_reminders" | "whatsapp"> = {
  email: "email_reminders",
  sms: "sms_reminders",
  whatsapp: "whatsapp",
};

export type ReminderPatient = {
  id: string;
  firstName: string | null;
  email: string | null;
  phoneMobile: string | null;
  preferredChannel: string;
  /** Doctolib-Import: extra.no_reminders */
  noReminders?: boolean;
  /** als verstorben markiert (extra.deceased) → nie anschreiben */
  deceased?: boolean;
};

/** Liste der Einwilligungen (beliebige Reihenfolge) → aktuell gültiger Stand je Typ (neuester Eintrag zählt). */
export function grantedConsents(rows: { type: string; granted: boolean; recordedAt: Date | string }[]): Set<string> {
  const latest = new Map<string, { granted: boolean; at: number }>();
  for (const r of rows) {
    const at = new Date(r.recordedAt).getTime();
    const prev = latest.get(r.type);
    if (!prev || at >= prev.at) latest.set(r.type, { granted: r.granted, at });
  }
  return new Set([...latest].filter(([, v]) => v.granted).map(([k]) => k));
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const phoneOk = (p: string | null) => !!p && p.replace(/\D/g, "").length >= 7;

/** Kanal wählen: bevorzugter Kanal zuerst, dann E-Mail, SMS, WhatsApp – jeweils nur mit Einwilligung und Adresse. */
export function chooseChannel(p: ReminderPatient, consents: Set<string>): { channel: ReminderChannel; to: string } | null {
  if (p.noReminders || p.deceased) return null;
  const order: ReminderChannel[] = ["email", "sms", "whatsapp"];
  const pref = p.preferredChannel as ReminderChannel;
  const list = order.includes(pref) ? [pref, ...order.filter((c) => c !== pref)] : order;
  for (const c of list) {
    if (!consents.has(CONSENT_FOR[c])) continue;
    if (c === "email" && p.email && EMAIL_RE.test(p.email.trim())) return { channel: c, to: p.email.trim() };
    if (c !== "email" && phoneOk(p.phoneMobile)) return { channel: c, to: p.phoneMobile!.trim() };
  }
  return null;
}

export type Practice = { name: string; phone: string | null };

export function reminder24hText(practice: Practice, startsAt: Date | string) {
  const tel = practice.phone ? ` unter ${practice.phone}` : "";
  return {
    subject: `Terminerinnerung – ${practice.name}`,
    body: `Erinnerung: Ihr Termin bei ${practice.name} am ${dateDe(startsAt)} um ${timeDe(startsAt)} Uhr. Absage bitte bis 24 h vorher${tel}.`,
  };
}

/** Neutral formuliert (Rückholung und Spangen-Kontrolle identisch – keine Rückschlüsse auf die Behandlung). */
export function recallText(practice: Practice, firstName: string | null) {
  const hello = firstName ? `Guten Tag ${firstName}, ` : "Guten Tag, ";
  const tel = practice.phone ? ` unter ${practice.phone}` : "";
  return {
    subject: `Ihr nächster Termin – ${practice.name}`,
    body: `${hello}es ist wieder Zeit für Ihren nächsten Termin bei ${practice.name}. Wir freuen uns auf Ihren Anruf${tel}. Keine Erinnerungen mehr gewünscht? Eine kurze Nachricht genügt.`,
  };
}

const monthKey = (d: Date) => berlinDateIso(d).slice(0, 7);

export type ReminderCandidates = {
  now: Date;
  practice: Practice;
  settings: ReminderSettings;
  patients: Map<string, ReminderPatient>;
  consents: Map<string, Set<string>>;
  /** Termine (planned/confirmed) mit Patient */
  appointments: { id: string; patientId: string; startsAt: Date; status: string }[];
  /** letzte erledigte Behandlung je Patient (nur Datum) */
  lastVisit: Map<string, Date | null>;
  visitIntervalWeeks: Map<string, number | null>;
  /** Patienten mit künftigem Termin (planned/confirmed) – keine Rückholung nötig */
  hasUpcoming: Set<string>;
  /** zuletzt gesendete Rückholung/Spangen-Erinnerung je Patient */
  lastRecallAt: Map<string, Date>;
  lastBraceCheckAt: Map<string, Date>;
  /** aktive Spangen-Episoden mit letzter Doku */
  braceEpisodes: { id: string; patientId: string; startedAt: string; lastRecordAt: Date | null }[];
};

export type PlannedReminder = {
  kind: ReminderKind;
  dedupeKey: string;
  patientId: string;
  appointmentId: string | null;
  channel: ReminderChannel;
  to: string;
  subject: string;
  body: string;
};

export type PlanResult = { planned: PlannedReminder[]; skipped: { kind: ReminderKind; patientId: string; reason: string }[] };

export function planReminders(c: ReminderCandidates): PlanResult {
  const planned: PlannedReminder[] = [];
  const skipped: PlanResult["skipped"] = [];
  const now = c.now.getTime();
  const seen = new Set<string>();
  const push = (r: Omit<PlannedReminder, "channel" | "to">) => {
    if (seen.has(r.dedupeKey)) return;
    const p = c.patients.get(r.patientId);
    if (!p) return void skipped.push({ kind: r.kind, patientId: r.patientId, reason: "Person nicht gefunden" });
    const ch = chooseChannel(p, c.consents.get(r.patientId) ?? new Set());
    if (!ch) return void skipped.push({ kind: r.kind, patientId: r.patientId, reason: p.deceased ? "verstorben" : p.noReminders ? "keine Erinnerungen gewünscht" : "keine Einwilligung/Adresse" });
    seen.add(r.dedupeKey);
    planned.push({ ...r, ...ch });
  };

  if (c.settings.r24) {
    for (const a of c.appointments) {
      if (a.status !== "planned" && a.status !== "confirmed") continue;
      const h = (a.startsAt.getTime() - now) / 3600_000;
      if (h < R24_WINDOW.fromHours || h > R24_WINDOW.toHours) continue;
      push({ kind: "reminder_24h", dedupeKey: `r24:${a.id}`, patientId: a.patientId, appointmentId: a.id, ...reminder24hText(c.practice, a.startsAt) });
    }
  }

  const recentlyContacted = (m: Map<string, Date>, id: string, days: number) => {
    const last = m.get(id);
    return !!last && now - last.getTime() < days * 86400_000;
  };

  if (c.settings.recall) {
    for (const [pid, last] of c.lastVisit) {
      if (!last || c.hasUpcoming.has(pid)) continue;
      const status = patientStatus(last, c.visitIntervalWeeks.get(pid) ?? c.settings.recallAfterWeeks, c.now);
      if (status !== "overdue") continue;
      if (recentlyContacted(c.lastRecallAt, pid, RECALL_MIN_DAYS)) continue;
      const p = c.patients.get(pid);
      push({ kind: "recall", dedupeKey: `recall:${pid}:${monthKey(c.now)}`, patientId: pid, appointmentId: null, ...recallText(c.practice, p?.firstName ?? null) });
    }
  }

  if (c.settings.braceCheck) {
    for (const e of c.braceEpisodes) {
      if (c.hasUpcoming.has(e.patientId)) continue;
      // höchstens eine neutrale „nächster Termin“-Nachricht pro Lauf und Person
      if (planned.some((x) => x.patientId === e.patientId && x.kind !== "reminder_24h")) continue;
      const ref = e.lastRecordAt?.getTime() ?? new Date(`${e.startedAt}T12:00:00Z`).getTime();
      if (now - ref <= BRACE_CHECK_DAYS * 86400_000) continue;
      if (recentlyContacted(c.lastBraceCheckAt, e.patientId, BRACE_CHECK_DAYS)) continue;
      const p = c.patients.get(e.patientId);
      push({ kind: "brace_check", dedupeKey: `brace:${e.patientId}:${monthKey(c.now)}`, patientId: e.patientId, appointmentId: null, ...recallText(c.practice, p?.firstName ?? null) });
    }
  }
  return { planned, skipped };
}

export const REMINDER_KIND_LABEL: Record<string, string> = {
  reminder_24h: "Terminerinnerung (24 h)",
  recall: "Rückholung",
  brace_check: "Spangen-Kontrolle",
  birthday: "Geburtstag",
  waitlist_offer: "Warteliste: Terminangebot",
};

export const REMINDER_STATUS_LABEL: Record<string, string> = {
  pending: "in Versand",
  sent: "gesendet",
  skipped: "übersprungen",
  failed: "fehlgeschlagen",
};

export const CHANNEL_LABEL: Record<string, string> = { email: "E-Mail", whatsapp: "WhatsApp", sms: "SMS", phone: "Telefon", letter: "Brief", none: "–" };
