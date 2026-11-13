/**
 * Wer bekommt beim Klick auf „Nächste Mail senden“ welche Mail? Rein und testbar.
 * Gesendet wird nur, wenn: E-Mail vorhanden und gültig, nicht auf der Sperrliste, Einwilligung dokumentiert
 * (§ 7 Abs. 2 Nr. 2 UWG – serverseitig erzwungen, auch für Kampagnen), Status nicht beendet,
 * Sequenz nicht abgeschlossen und der Abstand zur vorigen Mail abgelaufen ist. Dazu Obergrenzen je Klick und je 24 h.
 */
import { MAX_PER_CLICK, MAX_PER_DAY, NO_CONSENT, SEQUENCE_STEPS, STOP_STATUSES, STATUS_LABEL, isLeadStatus } from "./constants";

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

export type LeadForSend = {
  id: string;
  email: string | null;
  status: string;
  step: number;
  lastSentAt: Date | null;
  /** dokumentierte Einwilligung (sales_leads.consent_at) – ohne sie wird nie gesendet */
  consentAt: Date | null;
};

export type Delays = { delay2Days: number; delay3Days: number };

export type Eligibility = { ok: true; step: number } | { ok: false; reason: string; dueAt?: Date };

export const normalizeEmail = (v: string) => v.trim().toLowerCase();

/** Abstand (Tage) vor Schritt `step` (2 oder 3). */
export const delayBefore = (step: number, d: Delays) => (step === 2 ? d.delay2Days : step === 3 ? d.delay3Days : 0);

export function eligibility(lead: LeadForSend, opts: { now: Date; delays: Delays; suppressed: ReadonlySet<string> }): Eligibility {
  const email = lead.email?.trim() ?? "";
  if (!email || !EMAIL_RE.test(email)) return { ok: false, reason: "Keine gültige E-Mail-Adresse" };
  if (opts.suppressed.has(normalizeEmail(email))) return { ok: false, reason: "Auf der Sperrliste (abgemeldet)" };
  if (!lead.consentAt) return { ok: false, reason: NO_CONSENT };
  if (!isLeadStatus(lead.status)) return { ok: false, reason: "Unbekannter Status" };
  if (STOP_STATUSES.includes(lead.status)) return { ok: false, reason: `Status „${STATUS_LABEL[lead.status]}“ – Sequenz beendet` };
  if (lead.step >= SEQUENCE_STEPS) return { ok: false, reason: "Alle 3 Mails versendet" };
  const next = Math.max(0, lead.step) + 1;
  if (next > 1) {
    if (!lead.lastSentAt) return { ok: false, reason: "Zeitpunkt der letzten Mail fehlt" };
    const dueAt = new Date(lead.lastSentAt.getTime() + delayBefore(next, opts.delays) * 86_400_000);
    if (opts.now < dueAt) return { ok: false, reason: `Mail ${next} erst ab ${dueAt.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" })} fällig`, dueAt };
  }
  return { ok: true, step: next };
}

export type Plan<L extends LeadForSend> = {
  send: { lead: L; step: number }[];
  skipped: { lead: L; reason: string }[];
  /** Restkontingent in den letzten 24 h vor diesem Klick */
  dayLeft: number;
  /** wegen Obergrenze (Klick/Tag) zurückgestellt */
  capped: number;
};

/**
 * Plant einen Klick: Reihenfolge wie ausgewählt, doppelte IDs nur einmal, höchstens MAX_PER_CLICK und
 * höchstens das restliche Tageskontingent (sentLast24h = erfolgreiche Sends der letzten 24 h).
 */
export function planBatch<L extends LeadForSend>(
  leads: L[],
  opts: { now: Date; delays: Delays; suppressed: ReadonlySet<string>; sentLast24h: number; maxPerClick?: number; maxPerDay?: number },
): Plan<L> {
  const maxClick = opts.maxPerClick ?? MAX_PER_CLICK;
  const dayLeft = Math.max(0, (opts.maxPerDay ?? MAX_PER_DAY) - opts.sentLast24h);
  const limit = Math.min(maxClick, dayLeft);
  const seen = new Set<string>();
  const seenEmail = new Set<string>();
  const out: Plan<L> = { send: [], skipped: [], dayLeft, capped: 0 };
  for (const lead of leads) {
    if (seen.has(lead.id)) continue;
    seen.add(lead.id);
    const e = eligibility(lead, opts);
    if (!e.ok) {
      out.skipped.push({ lead, reason: e.reason });
      continue;
    }
    const key = normalizeEmail(lead.email!);
    if (seenEmail.has(key)) {
      out.skipped.push({ lead, reason: "Gleiche E-Mail-Adresse wie ein anderer ausgewählter Eintrag" });
      continue;
    }
    seenEmail.add(key);
    if (out.send.length >= limit) {
      out.capped++;
      out.skipped.push({ lead, reason: dayLeft <= out.send.length ? `Tageslimit (${opts.maxPerDay ?? MAX_PER_DAY} in 24 h) erreicht` : `Höchstens ${maxClick} je Klick` });
      continue;
    }
    out.send.push({ lead, step: e.step });
  }
  return out;
}
