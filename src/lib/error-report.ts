/**
 * Optionales Fehler-Reporting für Server-Fehler (über src/instrumentation.ts → onRequestError).
 * Aktiv nur, wenn SENTRY_DSN und/oder ERROR_WEBHOOK_URL gesetzt ist. Für Gesundheitsdaten gilt:
 * AVV mit dem Anbieter, EU-Region – und es verlassen den Server NUR diese Angaben:
 *   Route-Muster (z. B. /app/kunden/[id], nie der echte Pfad mit IDs/Tokens), Methode, Art (render/route/action),
 *   Fehlername, gekürzte und gefilterte Meldung, Digest, Zeitpunkt, Umgebung.
 * Keine Header, keine Cookies, keine Query-Strings, kein Request-Body, keine Stacktraces, keine Nutzer-IDs.
 */
import { errorSummary, scrubText } from "./log";

export type ErrorReport = {
  ts: string;
  env: string;
  route: string;
  method: string;
  routeType: string;
  errorName: string;
  errorMessage: string;
  digest?: string;
};

type RequestInfo = { path?: string; method?: string };
type ContextInfo = { routePath?: string; routeType?: string };

/** Route ohne Query-String; bevorzugt das Muster der Route-Datei statt des tatsächlichen Pfads. */
export function scrubRoute(routePath: string | undefined, path: string | undefined): string {
  if (routePath) return scrubText(routePath.split("?")[0], 120);
  // Fallback: echter Pfad – Query-String weg, ID-/Token-artige Segmente ersetzen
  const p = (path ?? "").split("?")[0].split("#")[0];
  return scrubText(
    p
      .split("/")
      .map((seg) => (/^[0-9a-f-]{16,}$/i.test(seg) || /\d{3,}/.test(seg) || seg.length > 24 ? "[id]" : seg))
      .join("/"),
    120,
  );
}

export function buildErrorReport(err: unknown, request: RequestInfo, context: ContextInfo): ErrorReport {
  const { errorName, errorMessage, digest } = errorSummary(err);
  return {
    ts: new Date().toISOString(),
    env: process.env.NODE_ENV ?? "unknown",
    route: scrubRoute(context.routePath, request.path),
    method: /^[A-Z]{3,7}$/.test(request.method ?? "") ? (request.method as string) : "?",
    routeType: /^[a-z-]{1,20}$/.test(context.routeType ?? "") ? (context.routeType as string) : "?",
    errorName,
    errorMessage,
    ...(digest ? { digest } : {}),
  };
}

type ParsedDsn = { endpoint: string; publicKey: string; dsn: string };

/** Sentry-DSN https://<key>@<host>/<projekt> → Envelope-Endpunkt. */
export function parseSentryDsn(dsn: string): ParsedDsn | null {
  try {
    const u = new URL(dsn);
    const project = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!u.username || !/^\d+$/.test(project.split("/").pop() ?? "") || u.protocol !== "https:") return null;
    const prefix = project.split("/").slice(0, -1).join("/");
    const id = project.split("/").pop();
    return { endpoint: `${u.protocol}//${u.host}/${prefix ? `${prefix}/` : ""}api/${id}/envelope/`, publicKey: u.username, dsn: `${u.protocol}//${u.username}@${u.host}/${project}` };
  } catch {
    return null;
  }
}

export function sentryEnvelope(report: ErrorReport, dsn: ParsedDsn): string {
  const eventId = crypto.randomUUID().replace(/-/g, "");
  const event = {
    event_id: eventId,
    timestamp: report.ts,
    platform: "node",
    level: "error",
    environment: report.env,
    release: process.env.APP_RELEASE?.slice(0, 64),
    transaction: report.route,
    exception: { values: [{ type: report.errorName, value: report.errorMessage }] },
    tags: { route: report.route, method: report.method, routeType: report.routeType, ...(report.digest ? { digest: report.digest } : {}) },
    // ausdrücklich keine Nutzer-/IP-Zuordnung
    user: { ip_address: null },
  };
  return [JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn: dsn.dsn }), JSON.stringify({ type: "event" }), JSON.stringify(event)].join("\n");
}

/** Sendet den Bericht; wirft nie (Fehler-Reporting darf die Anfrage nicht stören). */
export async function sendErrorReport(report: ErrorReport): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  const timeout = () => AbortSignal.timeout(3000);
  const dsn = process.env.SENTRY_DSN ? parseSentryDsn(process.env.SENTRY_DSN) : null;
  if (dsn) {
    tasks.push(
      fetch(dsn.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-sentry-envelope",
          "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=podocrm/1.0, sentry_key=${dsn.publicKey}`,
        },
        body: sentryEnvelope(report, dsn),
        signal: timeout(),
      }),
    );
  }
  const webhook = process.env.ERROR_WEBHOOK_URL;
  if (webhook && /^https:\/\//.test(webhook)) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.ERROR_WEBHOOK_TOKEN) headers.Authorization = `Bearer ${process.env.ERROR_WEBHOOK_TOKEN}`;
    tasks.push(fetch(webhook, { method: "POST", headers, body: JSON.stringify({ service: "podocrm", ...report }), signal: timeout() }));
  }
  await Promise.allSettled(tasks);
}

export function errorReportingEnabled(): boolean {
  return Boolean(process.env.SENTRY_DSN || process.env.ERROR_WEBHOOK_URL);
}
