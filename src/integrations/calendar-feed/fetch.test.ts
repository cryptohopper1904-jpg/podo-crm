/** Abruf der privaten iCal-Adresse: SSRF-Schutz, Limits, bedingte Abfrage – ohne echtes Netz. */
import { describe, expect, it, vi } from "vitest";
import type { Resolver } from "../net-guard";
import { CalendarFeedError, feedUrlHint, fetchIcs, normalizeFeedUrl } from "./fetch";

const SECRET_URL = "https://calendar.google.com/calendar/ical/praxis%40example.org/private-0123456789abcdef0123456789abcdef/basic.ics";
const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
const publicDns: Resolver = async () => [{ address: "142.250.185.78" }];
const privateDns: Resolver = async () => [{ address: "10.0.0.5" }];

const ok = (body = ICS, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { "content-type": "text/calendar", ...headers } });

describe("Kalender-Abo: Abruf", () => {
  it("lädt per https mit Accept-Header, liefert ETag/Last-Modified und folgt nie automatisch Weiterleitungen", async () => {
    const f = vi.fn(async () => ok(ICS, { etag: '"abc"', "last-modified": "Mon, 09 Nov 2026 10:00:00 GMT" }));
    const r = await fetchIcs(SECRET_URL, { fetchImpl: f, resolver: publicDns });
    expect(r).toEqual({ status: "ok", body: ICS, etag: '"abc"', lastModified: "Mon, 09 Nov 2026 10:00:00 GMT" });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).Accept).toContain("text/calendar");
  });

  it("bedingte Abfrage: If-None-Match/If-Modified-Since, 304 → not_modified", async () => {
    const f = vi.fn(async () => new Response(null, { status: 304 }));
    const r = await fetchIcs(SECRET_URL, { etag: '"abc"', lastModified: "Mon, 09 Nov 2026 10:00:00 GMT", fetchImpl: f, resolver: publicDns });
    expect(r).toEqual({ status: "not_modified" });
    const headers = (f.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers["If-None-Match"]).toBe('"abc"');
    expect(headers["If-Modified-Since"]).toBe("Mon, 09 Nov 2026 10:00:00 GMT");
  });

  it("net-guard: http, localhost, private IP-Literale, private DNS-Auflösung und fremde Ports werden abgelehnt", async () => {
    const f = vi.fn(async () => ok());
    for (const url of ["http://calendar.google.com/x.ics", "https://localhost/x.ics", "https://127.0.0.1/x.ics", "https://[::1]/x.ics", "https://169.254.169.254/latest", "https://calendar.google.com:8443/x.ics", "https://user:pw@calendar.google.com/x.ics", "ftp://x.example/a.ics"]) {
      await expect(fetchIcs(url, { fetchImpl: f, resolver: publicDns }), url).rejects.toBeInstanceOf(CalendarFeedError);
    }
    await expect(fetchIcs(SECRET_URL, { fetchImpl: f, resolver: privateDns })).rejects.toThrow(/nicht erlaubt/);
    expect(f).not.toHaveBeenCalled();
  });

  it("Weiterleitung auf eine private Adresse wird abgelehnt, auf eine öffentliche befolgt (max. 3)", async () => {
    const resolver: Resolver = async (h) => [{ address: h === "intern.example.org" ? "192.168.1.10" : "142.250.185.78" }];
    const toPrivate = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://intern.example.org/x.ics" } }));
    await expect(fetchIcs(SECRET_URL, { fetchImpl: toPrivate, resolver })).rejects.toThrow(/nicht erlaubt/);
    expect(toPrivate).toHaveBeenCalledTimes(1);

    let n = 0;
    const once = vi.fn(async () => (n++ === 0 ? new Response(null, { status: 301, headers: { location: "/neu.ics" } }) : ok()));
    expect((await fetchIcs(SECRET_URL, { fetchImpl: once, resolver })).status).toBe("ok");
    expect((once.mock.calls[1] as unknown as [string])[0]).toBe("https://calendar.google.com/neu.ics");

    const loop = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://calendar.google.com/loop.ics" } }));
    await expect(fetchIcs(SECRET_URL, { fetchImpl: loop, resolver })).rejects.toThrow(/Weiterleitungen/);
    expect(loop).toHaveBeenCalledTimes(4);
  });

  it("Größenlimit (Content-Length und gestreamt), Zeitlimit, Nicht-iCal, HTTP-Fehler – ohne die URL preiszugeben", async () => {
    const big = vi.fn(async () => ok("x", { "content-length": String(6 * 1024 * 1024) }));
    await expect(fetchIcs(SECRET_URL, { fetchImpl: big, resolver: publicDns })).rejects.toThrow(/5 MB/);
    const streamed = vi.fn(async () => ok("BEGIN:VCALENDAR\r\n" + "X".repeat(2000)));
    await expect(fetchIcs(SECRET_URL, { fetchImpl: streamed, resolver: publicDns, maxBytes: 1000 })).rejects.toThrow(/5 MB/);

    const hang = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    await expect(fetchIcs(SECRET_URL, { fetchImpl: hang, resolver: publicDns, timeoutMs: 20 })).rejects.toThrow(/Zeitüberschreitung/);

    const html = vi.fn(async () => ok("<html>Login</html>"));
    await expect(fetchIcs(SECRET_URL, { fetchImpl: html, resolver: publicDns })).rejects.toThrow(/keine iCal-Datei/);

    const gone = vi.fn(async () => new Response("nope", { status: 404 }));
    const err = await fetchIcs(SECRET_URL, { fetchImpl: gone, resolver: publicDns }).catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/zurückgesetzt/);
    expect(String((err as Error).message)).not.toContain("private-");
  });

  it("webcal:// wird als https gelesen; Anzeige-Hinweis enthält kein Geheimnis", () => {
    expect(normalizeFeedUrl("webcal://p01-caldav.icloud.com/published/2/abc")).toBe("https://p01-caldav.icloud.com/published/2/abc");
    expect(feedUrlHint(SECRET_URL)).toBe("calendar.google.com/…/basic.ics");
    expect(feedUrlHint("https://app.docal.io/ics/0123456789abcdef0123")).toBe("app.docal.io/…");
  });
});
