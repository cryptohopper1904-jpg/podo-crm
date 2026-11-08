/**
 * Strukturierte JSON-Logs (eine Zeile je Ereignis) ohne Gesundheits- oder Personendaten.
 *
 *   log.info("cron.reminders.done", { sent: 3, skipped: 1 });
 *   log.error("cron.reminders.failed", { error: e });
 *
 * Regeln: Nur einfache Werte (Zahl, Boolean, kurze Zeichenkette); verdächtige Schlüssel (Name, E-Mail,
 * Telefon, Befund, Token …) werden geschwärzt, Zeichenketten gekürzt und auf E-Mail-Adressen,
 * Telefonnummern/lange Ziffernfolgen und Query-Strings gefiltert. Fehler werden auf Name + gekürzte,
 * gefilterte Meldung reduziert (keine Stacktraces mit Variableninhalten, keine `detail`-Felder von Postgres).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogValue = string | number | boolean | null | undefined | Error | unknown;

const MAX_STRING = 300;

/** Schlüssel, deren Werte nie geloggt werden (Teilstring, ohne Groß-/Kleinschreibung). */
const SENSITIVE_KEY =
  /name|mail|phone|telefon|mobile|address|adresse|street|strasse|birth|geburt|dob|insur|versich|iban|patient|befund|finding|diagnos|anamnes|note|notiz|text|body|message_body|subject|content|token|secret|password|passwort|cookie|authorization|session|signature|^ip$|ipaddr|ip_addr|clientip|client_ip|useragent|user_agent/i;

/** Unkritische Schlüssel, die trotz Muster erlaubt sind (z. B. „route“, „event“). */
const ALLOWED_KEY = new Set(["event", "route", "routePath", "routeType", "method", "status", "digest", "errorName", "durationMs", "count", "kind", "level"]);

/** Entfernt typische personenbezogene Muster aus einer Zeichenkette und kürzt sie. */
export function scrubText(input: string, max = MAX_STRING): string {
  let s = input
    // Query-Strings (Tokens in Links)
    .replace(/\?[^\s"'<>]*/g, "?[…]")
    // E-Mail-Adressen
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    // IBAN
    .replace(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/g, "[iban]")
    // Postgres-Details „Key (spalte)=(wert)“
    .replace(/=\([^)]*\)/g, "=([…])")
    // Telefonnummern, Versichertennummern, Datumsangaben, lange Ziffernfolgen
    .replace(/\+?\d[\d\s/().-]{5,}\d/g, "[zahl]")
    // Pfadsegmente nach /portal/, /anamnese/, /api/calendar/ (Einmal-Tokens)
    .replace(/\/(portal|anamnese|calendar)\/[^\s/"']+/gi, "/$1/[token]");
  if (s.length > max) s = `${s.slice(0, max)}…`;
  return s;
}

export function errorSummary(err: unknown): { errorName: string; errorMessage: string; digest?: string } {
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const digest = typeof err === "object" && err !== null && "digest" in err ? String((err as { digest: unknown }).digest).slice(0, 64) : undefined;
  return { errorName: scrubText(name, 60), errorMessage: scrubText(message, 200), ...(digest ? { digest } : {}) };
}

/** Bereinigt Felder für ein Log-Ereignis. */
export function sanitizeFields(fields: Record<string, LogValue>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value instanceof Error || key === "error" || key === "err") {
      Object.assign(out, errorSummary(value));
      continue;
    }
    if (!ALLOWED_KEY.has(key) && SENSITIVE_KEY.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (value === null || typeof value === "boolean") out[key] = value;
    else if (typeof value === "number") out[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === "string") out[key] = scrubText(value);
    else out[key] = "[object]"; // keine verschachtelten Objekte – könnten Personendaten enthalten
  }
  return out;
}

export function formatLog(level: LogLevel, event: string, fields: Record<string, LogValue> = {}): string {
  return JSON.stringify({ ts: new Date().toISOString(), level, event: scrubText(event, 100), ...sanitizeFields(fields) });
}

function write(level: LogLevel, event: string, fields?: Record<string, LogValue>) {
  const line = formatLog(level, event, fields);
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, fields?: Record<string, LogValue>) => {
    if (process.env.LOG_LEVEL === "debug") write("debug", event, fields);
  },
  info: (event: string, fields?: Record<string, LogValue>) => write("info", event, fields),
  warn: (event: string, fields?: Record<string, LogValue>) => write("warn", event, fields),
  error: (event: string, fields?: Record<string, LogValue>) => write("error", event, fields),
};
