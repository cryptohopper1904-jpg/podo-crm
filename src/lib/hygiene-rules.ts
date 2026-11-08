/**
 * Hygiene-Regeln ohne Datenbank (testbar): Chargen-Verwendbarkeit, Fristen-Ampel,
 * Chargennummern-Vorschlag, Bestellliste. Siehe docs/PLAN.md 3.1 und 4.12 (Ideen 6/7), 14.2.
 */

export const DEVICE_KINDS = ["sterilizer", "thermo_disinfector", "drill", "ultrasonic", "sealer", "other"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export const DEVICE_KIND_LABELS: Record<DeviceKind, string> = {
  sterilizer: "Sterilisator (Autoklav)",
  thermo_disinfector: "Thermodesinfektor",
  drill: "Fräse/Behandlungseinheit",
  ultrasonic: "Ultraschallbad",
  sealer: "Siegelgerät",
  other: "Sonstiges",
};

export const DEVICE_EVENT_KINDS = ["maintenance", "validation", "electrical_check", "malfunction", "briefing"] as const;
export type DeviceEventKind = (typeof DEVICE_EVENT_KINDS)[number];
export const DEVICE_EVENT_LABELS: Record<DeviceEventKind, string> = {
  maintenance: "Wartung",
  validation: "Validierung",
  electrical_check: "Elektrische Prüfung (DGUV V3)",
  malfunction: "Störung",
  briefing: "Einweisung",
};

/** Welche Gerätefrist ein Gerätebuch-Eintrag fortschreibt. */
export const DEADLINE_BY_EVENT: Partial<Record<DeviceEventKind, DeadlineField>> = {
  maintenance: "nextMaintenanceAt",
  validation: "nextValidationAt",
  electrical_check: "nextElectricalCheckAt",
};

export const DEADLINE_FIELDS = ["nextMaintenanceAt", "nextValidationAt", "nextElectricalCheckAt"] as const;
export type DeadlineField = (typeof DEADLINE_FIELDS)[number];
export const DEADLINE_LABELS: Record<DeadlineField, string> = {
  nextMaintenanceAt: "Wartung",
  nextValidationAt: "Validierung",
  nextElectricalCheckAt: "Elektrische Prüfung",
};

export const BATCH_RESULTS = ["pending", "released", "rejected"] as const;
export type BatchResult = (typeof BATCH_RESULTS)[number];
export const BATCH_RESULT_LABELS: Record<BatchResult, string> = {
  pending: "wartet auf Freigabe",
  released: "freigegeben",
  rejected: "gesperrt",
};

/** Rollen, die eine Charge freigeben oder sperren dürfen (nicht Azubis). */
export const BATCH_RELEASE_ROLES = ["owner", "therapist"] as const;

export type BatchUnusableReason = "unknown" | "rejected" | "pending" | "expired";
export type BatchCheck = { ok: true; reason: null } | { ok: false; reason: BatchUnusableReason };

export const BATCH_REASON_TEXT: Record<BatchUnusableReason, string> = {
  unknown: "Unbekannte Charge – bitte Etikett prüfen.",
  rejected: "Charge ist GESPERRT – Sterilgut nicht verwenden!",
  pending: "Charge ist noch nicht freigegeben.",
  expired: "Lagerfrist der Charge ist abgelaufen – neu aufbereiten.",
};

/** Normalisiert eine eingegebene/gescannte Chargennummer (Leerzeichen, Groß-/Kleinschreibung). */
export function normalizeBatchCode(code: string): string {
  return code.trim().replace(/\s+/g, "").toUpperCase();
}

/** Verwendbarkeit einer Charge zum Behandlungstag (ISO-Datum, Berlin). */
export function batchUsability(
  batch: { result: string; expiresAt: string | null } | null | undefined,
  todayIso: string,
): BatchCheck {
  if (!batch) return { ok: false, reason: "unknown" };
  if (batch.result === "rejected") return { ok: false, reason: "rejected" };
  if (batch.result !== "released") return { ok: false, reason: "pending" };
  // Verwendbar bis einschließlich Ablaufdatum
  if (batch.expiresAt && batch.expiresAt < todayIso) return { ok: false, reason: "expired" };
  return { ok: true, reason: null };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Tage von a bis b (ISO-Daten, kalendertäglich, ohne Zeitzonen-Effekte). */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

export function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(Date.UTC(+dateIso.slice(0, 4), +dateIso.slice(5, 7) - 1, +dateIso.slice(8, 10) + days));
  return d.toISOString().slice(0, 10);
}

export function addMonthsIso(dateIso: string, months: number): string {
  const y = +dateIso.slice(0, 4);
  const m = +dateIso.slice(5, 7) - 1 + months;
  const day = +dateIso.slice(8, 10);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last))).toISOString().slice(0, 10);
}

export const DEADLINE_WARN_DAYS = 30;
export type DeadlineStatus = { status: "none" | "overdue" | "soon" | "ok"; daysLeft: number | null };

/** Ampel für eine Frist: überfällig (rot), innerhalb von `warnDays` (gelb), sonst grün. */
export function deadlineStatus(dateIso: string | null | undefined, todayIso: string, warnDays = DEADLINE_WARN_DAYS): DeadlineStatus {
  if (!dateIso || !ISO.test(dateIso)) return { status: "none", daysLeft: null };
  const daysLeft = daysBetween(todayIso, dateIso);
  if (daysLeft < 0) return { status: "overdue", daysLeft };
  if (daysLeft <= warnDays) return { status: "soon", daysLeft };
  return { status: "ok", daysLeft };
}

/** Schlechteste Ampel mehrerer Fristen (für die Geräteliste). */
export function worstDeadline(statuses: DeadlineStatus[]): DeadlineStatus["status"] {
  const order = ["overdue", "soon", "ok", "none"] as const;
  for (const s of order) if (statuses.some((x) => x.status === s)) return s;
  return "none";
}

/** Vorschlag `ST-YYYYMMDD-NN`: nächste freie laufende Nummer des Tages. */
export function suggestBatchCode(dateIso: string, existingCodes: string[]): string {
  const prefix = `ST-${dateIso.replaceAll("-", "")}-`;
  let max = 0;
  for (const c of existingCodes) {
    const n = normalizeBatchCode(c);
    if (!n.startsWith(prefix)) continue;
    const num = Number(n.slice(prefix.length));
    if (Number.isInteger(num) && num > max) max = num;
  }
  return `${prefix}${String(max + 1).padStart(2, "0")}`;
}

/** Nachbestellen, sobald der Mindestbestand erreicht oder unterschritten ist. */
export function needsReorder(m: { stock: number; minStock: number }): boolean {
  return m.minStock > 0 && m.stock <= m.minStock;
}

/** Bestellvorschlag: auf das Doppelte des Mindestbestands auffüllen. */
export function suggestedOrderQty(m: { stock: number; minStock: number }): number {
  return Math.max(0, m.minStock * 2 - m.stock);
}

/** Nur http(s)-Links zulassen (kein javascript: o. Ä. in href). */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

// ───────────── Hygiene-Checkliste ─────────────

export type HygieneChecklist = { daily: string[]; weekly: string[] };

export const DEFAULT_HYGIENE_CHECKLIST: HygieneChecklist = {
  daily: [
    "Flächendesinfektion Behandlungsplatz nach jedem Kunden",
    "Instrumente aufbereitet (Reinigung, Desinfektion, Sterilisation)",
    "Händedesinfektionsmittel und Handschuhe aufgefüllt",
    "Absaugung/Fräse gereinigt, Filter geprüft",
    "Sterilisator: Tagesprüfung (Vakuumtest/Bowie-Dick) dokumentiert",
  ],
  weekly: [
    "Ultraschallbad: Lösung gewechselt, Becken gereinigt",
    "Wasserführende Systeme gespült",
    "Abfall/Spitzabwurf geleert und ersetzt",
    "Sterilgutlager: Lagerfristen geprüft",
  ],
};

/** Liest die Checkliste aus organizations.settings (robust gegen alte/kaputte Werte). */
export function readChecklist(settings: Record<string, unknown> | null | undefined): HygieneChecklist {
  const raw = (settings ?? {}).hygieneChecklist as Partial<HygieneChecklist> | undefined;
  const clean = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().slice(0, 200)) : null;
  const daily = clean(raw?.daily);
  const weekly = clean(raw?.weekly);
  if (!daily && !weekly) return DEFAULT_HYGIENE_CHECKLIST;
  return { daily: daily ?? [], weekly: weekly ?? [] };
}

/** Eine Zeile pro Punkt, max. 30 Punkte. */
export function parseChecklistLines(text: string): string[] {
  return Array.from(new Set(text.split(/\r?\n/).map((l) => l.trim().slice(0, 200)).filter(Boolean))).slice(0, 30);
}

/** Montag der ISO-Woche zu einem Datum. */
export function weekStartIso(dateIso: string): string {
  const d = new Date(`${dateIso}T12:00:00Z`);
  const wd = (d.getUTCDay() + 6) % 7; // 0 = Montag
  return addDaysIso(dateIso, -wd);
}

/** Aufgabentitel einer erledigten Checklisten-Position (dient zugleich der Dublettenprüfung). */
export function checklistTaskTitle(interval: "daily" | "weekly", item: string, todayIso: string): { title: string; period: string } {
  const period = interval === "daily" ? todayIso : weekStartIso(todayIso);
  const label = interval === "daily" ? "Tages-Check" : "Wochen-Check";
  return { title: `${label} ${period}: ${item}`, period };
}

/** Titel der Fristen-Aufgabe je Gerät und Frist (stabil → Dublettenprüfung per Titel). */
export function deadlineTaskTitle(field: DeadlineField, deviceName: string): string {
  return `Frist ${DEADLINE_LABELS[field]}: ${deviceName}`;
}
