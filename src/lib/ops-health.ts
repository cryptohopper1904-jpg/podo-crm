/**
 * Bewertung der Betriebs-Prüfungen für /api/health/deep (reine Logik, ohne Ein-/Ausgabe).
 * Ergebnisse enthalten nur Zustände, Zeiten und Zähler – keine Personendaten, keine Fehlermeldungen der DB.
 */

export type CheckStatus = "ok" | "warn" | "fail" | "skipped";
export type CheckResult = { status: CheckStatus; hint?: string } & Record<string, string | number | boolean | null | undefined>;

/** Grenzwerte: Backup täglich (+2 h Toleranz), Cron alle 15 min (3 verpasste Läufe), täglicher Cron (+2 h Toleranz). */
export const MAX_AGE_SECONDS = {
  backup: 26 * 3600,
  cron: 45 * 60,
  dailyCron: 26 * 3600,
} as const;

/** Bewertet einen Zeitstempel (Unix-Sekunden) aus einer Status-Datei. */
export function evaluateTimestamp(epochSeconds: number | null, maxAgeSeconds: number, nowMs = Date.now(), missingHint = "noch kein Lauf erfasst"): CheckResult {
  if (epochSeconds === null || !Number.isFinite(epochSeconds) || epochSeconds <= 0) return { status: "warn", hint: missingHint, lastAt: null };
  const ageSeconds = Math.max(0, Math.round(nowMs / 1000 - epochSeconds));
  const lastAt = new Date(epochSeconds * 1000).toISOString();
  if (ageSeconds > maxAgeSeconds) return { status: "fail", hint: "zu alt", lastAt, ageMinutes: Math.round(ageSeconds / 60) };
  return { status: "ok", lastAt, ageMinutes: Math.round(ageSeconds / 60) };
}

/** Liest „1731000000“ (ggf. mit Zeilenumbruch) aus einer Status-Datei. */
export function parseEpoch(text: string | null): number | null {
  if (text === null) return null;
  const n = Number(text.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Migrationsstand: angewendet (DB) vs. erwartet (drizzle/meta/_journal.json im Image). */
export function evaluateMigrations(applied: { count: number; latestWhen: number | null } | null, journal: { count: number; latestWhen: number | null; latestTag: string | null } | null): CheckResult {
  if (!journal) return { status: "warn", hint: "Migrations-Journal nicht gefunden" };
  if (!applied) return { status: "warn", hint: "Migrationstabelle nicht lesbar (Rechte? migrate erneut ausführen)", expected: journal.count };
  const base = { applied: applied.count, expected: journal.count, latest: journal.latestTag };
  if (applied.latestWhen !== null && journal.latestWhen !== null && applied.latestWhen >= journal.latestWhen && applied.count >= journal.count) return { status: "ok", ...base };
  return { status: "fail", hint: "Datenbank ist nicht auf dem Stand des Codes", ...base };
}

export function overallStatus(checks: Record<string, CheckResult>): "ok" | "warn" | "fail" {
  const s = Object.values(checks).map((c) => c.status);
  if (s.includes("fail")) return "fail";
  if (s.includes("warn")) return "warn";
  return "ok";
}

/**
 * Kalender-Abo (iCal-Import, Cron alle 5 min): Alter des letzten ERFOLGREICHEN Abrufs über alle aktiven Abos.
 * Keine Abos → ok. Einzelne veraltete Abos (z. B. Adresse zurückgesetzt) → warn; alle veraltet → fail (Cron läuft nicht).
 */
export function evaluateCalendarFeeds(h: { active: number; stale: number; failing: number; oldestSuccess: Date | null }, nowMs = Date.now()): CheckResult {
  if (h.active === 0) return { status: "ok", active: 0 };
  const oldestAgeMinutes = h.oldestSuccess ? Math.round((nowMs - h.oldestSuccess.getTime()) / 60000) : null;
  const base = { active: h.active, stale: h.stale, failing: h.failing, oldestAgeMinutes };
  if (h.stale >= h.active) return { status: "fail", hint: "kein Kalender-Abo in den letzten 30 min erfolgreich abgerufen", ...base };
  if (h.stale > 0 || h.failing > 0) return { status: "warn", hint: "einzelne Kalender-Abos veraltet oder fehlerhaft", ...base };
  return { status: "ok", ...base };
}
