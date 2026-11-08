import type { Instrumentation } from "next";

/**
 * Server-Fehler: immer als strukturierte JSON-Logzeile (ohne Personendaten), optional zusätzlich an
 * Sentry (SENTRY_DSN) bzw. einen generischen Webhook (ERROR_WEBHOOK_URL). Gefiltert wird in
 * src/lib/error-report.ts: nur Route-Muster, Methode, Fehlername, gekürzte Meldung, Digest.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  try {
    const { buildErrorReport, errorReportingEnabled, sendErrorReport } = await import("./lib/error-report");
    const { log } = await import("./lib/log");
    const report = buildErrorReport(err, request, context);
    log.error("request.error", { route: report.route, method: report.method, routeType: report.routeType, errorName: report.errorName, digest: report.digest });
    if (errorReportingEnabled()) await sendErrorReport(report);
  } catch {
    // Fehler-Reporting darf nie selbst einen Fehler auslösen
  }
};
