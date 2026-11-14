import { describe, expect, it } from "vitest";
import { formatLog, sanitizeFields, scrubText } from "./log";
import { buildErrorReport, parseSentryDsn, scrubRoute, sentryEnvelope } from "./error-report";
import { evaluateMigrations, evaluateReadonlyExpiryCron, evaluateTimestamp, MAX_AGE_SECONDS, overallStatus, parseEpoch } from "./ops-health";

describe("Logs ohne Personendaten", () => {
  it("filtert E-Mail, Telefon, IBAN, Query-Strings und Token-Pfade", () => {
    const s = scrubText("Fehler für anna.muster@example.de, Tel. 0151 2345678, IBAN DE89 3704 0044 0532 0130 00, /portal/abc123token?x=1");
    expect(s).not.toMatch(/anna|example\.de|2345678|3704|abc123token|x=1/);
  });

  it("entfernt Postgres-Details und kürzt lange Meldungen", () => {
    expect(scrubText('Key (email)=(a@b.de) already exists')).toBe("Key (email)=([…]) already exists");
    expect(scrubText("x".repeat(1000)).length).toBeLessThanOrEqual(301);
  });

  it("schwärzt sensible Schlüssel, Objekte und reduziert Fehler", () => {
    const f = sanitizeFields({ patientName: "Anna", findings: "Hyperkeratose", sent: 3, skipped: 1, data: { a: 1 }, error: new Error("boom für max@x.de") });
    expect(f).toMatchObject({ patientName: "[redacted]", findings: "[redacted]", sent: 3, skipped: 1, data: "[object]", errorName: "Error" });
    expect(String(f.errorMessage)).not.toContain("max@x.de");
    const line = JSON.parse(formatLog("info", "cron.done", { count: 2 }));
    expect(line).toMatchObject({ level: "info", event: "cron.done", count: 2 });
  });
});

describe("Fehler-Reporting", () => {
  it("nutzt das Route-Muster, nie den echten Pfad mit Token/Query", () => {
    const r = buildErrorReport(Object.assign(new Error("kaputt bei 0151 1234567"), { digest: "123abc" }), { path: "/portal/geheim-token?x=1", method: "GET" }, { routePath: "/portal/[token]", routeType: "render" });
    expect(r.route).toBe("/portal/[token]");
    expect(JSON.stringify(r)).not.toMatch(/geheim|x=1|1234567/);
    expect(r.digest).toBe("123abc");
  });

  it("ersetzt ID-artige Segmente im Fallback-Pfad", () => {
    // ohne Routenmuster kein echter Pfad (Regression Review Phase 5: /kunden/42, Namenssegmente)
    expect(scrubRoute(undefined, "/kunden/3f2a1b4c-1111-2222-3333-444455556666/doku?tab=1")).toBe("/kunden/[…]");
    expect(scrubRoute(undefined, "/kunden/42")).toBe("/kunden/[…]");
    expect(scrubRoute(undefined, "/Erika-Muster/x")).toBe("[unbekannt]");
  });

  it("externer Bericht ohne Fehlermeldung – höchstens SQLSTATE (Regression Review Phase 5)", () => {
    const dbErr = Object.assign(new Error('duplicate key value violates unique constraint, Key (last_name)=(Muster) Diabetes'), { code: "23505" });
    const r = buildErrorReport(dbErr, { method: "POST" }, { routePath: "/api/x", routeType: "route" });
    expect(r.errorMessage).toBe("SQLSTATE 23505");
    expect(JSON.stringify(r)).not.toMatch(/Muster|Diabetes/);
    expect(buildErrorReport(new Error("Frau Muster hat Diabetes"), {}, { routePath: "/x" }).errorMessage).toBe("");
  });

  it("parst Sentry-DSN und baut ein Envelope ohne Nutzerdaten", () => {
    const d = parseSentryDsn("https://pub123@o1.ingest.de.sentry.io/4507");
    expect(d?.endpoint).toBe("https://o1.ingest.de.sentry.io/api/4507/envelope/");
    expect(parseSentryDsn("kein-dsn")).toBeNull();
    const env = sentryEnvelope(buildErrorReport(new Error("x"), { method: "POST" }, { routePath: "/api/x", routeType: "route" }), d!);
    const [, , event] = env.split("\n").map((l) => JSON.parse(l));
    expect(event.tags.route).toBe("/api/x");
    expect(event.user).toEqual({ ip_address: null });
    expect(event.request).toBeUndefined();
  });
});

describe("Deep-Health-Bewertung", () => {
  const now = 1_800_000_000_000;
  it("bewertet Zeitstempel", () => {
    expect(evaluateTimestamp(null, 60, now).status).toBe("warn");
    expect(evaluateTimestamp(now / 1000 - 30, 60, now).status).toBe("ok");
    expect(evaluateTimestamp(now / 1000 - 3600, 60, now).status).toBe("fail");
    expect(parseEpoch("1731000000\n")).toBe(1731000000);
    expect(parseEpoch("kaputt")).toBeNull();
  });

  it("Cron Nur-Lesen: deaktiviert → skipped (kein warn/fail); eingeschaltet ohne Datei → warn, zu alt → fail", () => {
    expect(evaluateReadonlyExpiryCron(false, null, now)).toMatchObject({ status: "skipped", hint: expect.stringMatching(/deaktiviert/) });
    expect(evaluateReadonlyExpiryCron(false, now / 1000 - 100 * 3600, now).status).toBe("skipped");
    expect(evaluateReadonlyExpiryCron(true, null, now)).toMatchObject({ status: "warn", hint: "noch kein Lauf erfasst" });
    expect(evaluateReadonlyExpiryCron(true, now / 1000 - 6 * 3600, now).status).toBe("ok");
    expect(evaluateReadonlyExpiryCron(true, now / 1000 - MAX_AGE_SECONDS.cron6h - 60, now).status).toBe("fail");
    expect(overallStatus({ a: { status: "ok" }, nurLesen: evaluateReadonlyExpiryCron(false, null, now) })).toBe("ok");
  });

  it("fehlender Zeitstempel: warn kurz nach dem ersten Start, fail nach Ablauf der Frist (nicht dauerhaft warn)", () => {
    const day = 26 * 3600;
    expect(evaluateTimestamp(null, day, now, "noch kein Lauf erfasst", now / 1000 - 3600).status).toBe("warn");
    const late = evaluateTimestamp(null, day, now, "noch kein Lauf erfasst", now / 1000 - day - 60);
    expect(late).toMatchObject({ status: "fail", hint: "seit dem Start kein erfolgreicher Lauf", lastAt: null });
    // ohne Start-Zeitstempel (z. B. alter cron-Container): weiterhin warn
    expect(evaluateTimestamp(null, day, now, "x", null).status).toBe("warn");
    // ein vorhandener Lauf-Zeitstempel geht vor
    expect(evaluateTimestamp(now / 1000 - 60, day, now, "x", now / 1000 - 10 * day).status).toBe("ok");
  });

  it("bewertet den Migrationsstand", () => {
    const journal = { count: 3, latestWhen: 300, latestTag: "0002_x" };
    expect(evaluateMigrations({ count: 3, latestWhen: 300 }, journal).status).toBe("ok");
    expect(evaluateMigrations({ count: 2, latestWhen: 200 }, journal).status).toBe("fail");
    expect(evaluateMigrations(null, journal).status).toBe("warn");
  });

  it("Gesamtstatus: fail vor warn vor ok, skipped zählt nicht", () => {
    expect(overallStatus({ a: { status: "ok" }, b: { status: "skipped" } })).toBe("ok");
    expect(overallStatus({ a: { status: "warn" }, b: { status: "ok" } })).toBe("warn");
    expect(overallStatus({ a: { status: "warn" }, b: { status: "fail" } })).toBe("fail");
  });
});
