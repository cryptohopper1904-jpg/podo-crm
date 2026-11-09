/**
 * Kalender-Abo (DB): idempotenter Abgleich (anlegen/ändern/absagen), lokale Änderungen werden nicht überschrieben,
 * Überschneidungen, nie automatische Zuordnung, Mandantentrennung, Cron-Auswahl. Erfundene Daten.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { Resolver } from "@/integrations/net-guard";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const NOW = new Date("2026-11-09T07:00:00Z");
const URL_ = "https://calendar.google.com/calendar/ical/praxis%40example.org/private-feedfeedfeedfeedfeedfeedfeedfeed/basic.ics";
const publicDns: Resolver = async () => [{ address: "142.250.185.78" }];

const vevent = (uid: string, start: string, end: string, summary: string, extra: string[] = []) =>
  ["BEGIN:VEVENT", `UID:${uid}`, `DTSTART;TZID=Europe/Berlin:${start}`, `DTEND;TZID=Europe/Berlin:${end}`, `SUMMARY:${summary}`, ...extra, "END:VEVENT"];
const cal = (...events: string[][]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:Doctolib", ...events.flat(), "END:VCALENDAR"].join("\r\n");

const A = (start = "20261110T093000", end = "20261110T101500") => vevent("a@google.com", start, end, "Erika Musterfrau - Podologische Komplexbehandlung", ["DESCRIPTION:Gebucht über Doctolib", "LOCATION:Praxis Mitte"]);
const B = (extra: string[] = []) => vevent("b@google.com", "20261112T140000", "20261112T143000", "[Doctolib] Max M.", extra);
const SERIES = vevent("s@google.com", "20261111T080000", "20261111T083000", "Spangenkontrolle", ["RRULE:FREQ=WEEKLY;COUNT=2"]);
const ALLDAY = ["BEGIN:VEVENT", "UID:allday@google.com", "DTSTART;VALUE=DATE:20261120", "DTEND;VALUE=DATE:20261121", "SUMMARY:Urlaub", "END:VEVENT"];
const CANCELLED_NEW = vevent("c@google.com", "20261113T080000", "20261113T083000", "Abgesagt", ["STATUS:CANCELLED"]);

(TEST_DB ? describe : describe.skip)("Kalender-Abo (DB)", () => {
  const f = fixtures(TEST_DB!);
  let feeds: typeof import("./calendar-feeds");
  let secrets: typeof import("@/lib/secrets");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.APP_ENCRYPTION_KEY ??= "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
    feeds = await import("./calendar-feeds");
    secrets = await import("@/lib/secrets");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  async function setup() {
    const org = await f.org();
    const therapist = await f.user();
    const id = crypto.randomUUID();
    await f.asOrg(org, (c) =>
      c.query("insert into calendar_feeds (id, organization_id, label, url_enc, url_hint, therapist_id, source) values ($1,$2,'Doctolib',$3,'calendar.google.com/…/basic.ics',$4,'doctolib')", [
        id,
        org,
        secrets.encryptSecret(URL_, `${org}:calendar_feed:${id}`),
        therapist,
      ]),
    );
    return { org, therapist, id };
  }

  const server = (state: { body: string; etag?: string }) =>
    vi.fn(async (_url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (state.etag && h["If-None-Match"] === state.etag) return new Response(null, { status: 304 });
      return new Response(state.body, { status: 200, headers: state.etag ? { etag: state.etag } : {} });
    });

  const rows = (org: string) =>
    f.asOrg(org, async (c) =>
      (
        await c.query(
          `select a.id, a.title, a.status, a.source, a.patient_id, a.therapist_id, a.starts_at, a.ends_at, a.notes, m.event_key, m.conflict
             from calendar_feed_events m left join appointments a on a.id = m.appointment_id
            where m.organization_id = $1 order by m.event_key`,
          [org],
        )
      ).rows,
    );

  it("legt Termine an, nie mit Kund:in verknüpft; wiederholter Abruf ändert nichts (auch per ETag)", async () => {
    const { org, id, therapist } = await setup();
    await f.patient(org, { lastName: "Musterfrau", firstName: "Erika" });
    const state = { body: cal(A(), B(), SERIES, ALLDAY, CANCELLED_NEW), etag: '"v1"' };
    const fetchImpl = server(state);
    const r1 = await feeds.syncCalendarFeed(org, id, { fetchImpl, resolver: publicDns, now: NOW });
    expect(r1).toMatchObject({ notModified: false, created: 4, updated: 0, cancelled: 0, allDaySkipped: 1 });
    const list = await rows(org);
    expect(list).toHaveLength(4);
    expect(list.every((r) => r.patient_id === null && r.therapist_id === therapist && r.source === "doctolib" && r.status === "planned")).toBe(true);
    const a = list.find((r) => r.event_key === "a@google.com")!;
    expect(a.title).toBe("Erika Musterfrau - Podologische Komplexbehandlung");
    expect(a.notes).toBe("Ort: Praxis Mitte\nGebucht über Doctolib");
    expect(new Date(a.starts_at).toISOString()).toBe("2026-11-10T08:30:00.000Z");

    const r2 = await feeds.syncCalendarFeed(org, id, { fetchImpl, resolver: publicDns, now: NOW });
    expect(r2).toMatchObject({ notModified: true, created: 0 });
    state.etag = '"v2"';
    const r3 = await feeds.syncCalendarFeed(org, id, { fetchImpl, resolver: publicDns, now: NOW });
    expect(r3).toMatchObject({ notModified: false, created: 0, updated: 0, cancelled: 0, unchanged: 4 });
    expect(await rows(org)).toHaveLength(4);

    const [feed] = await f.asOrg(org, async (c) => (await c.query("select etag, last_sync_at, last_error, url_enc from calendar_feeds where id = $1", [id])).rows);
    expect(feed.etag).toBe('"v2"');
    expect(feed.last_error).toBeNull();
    expect(feed.url_enc).not.toContain("calendar.google.com");
  });

  it("übernimmt Verschiebung und Absage, sagt gelöschte Ereignisse ab (nie löschen) und stellt wieder her", async () => {
    const { org, id } = await setup();
    const state = { body: cal(A(), B(), SERIES) };
    const fetchImpl = server(state);
    await feeds.syncCalendarFeed(org, id, { fetchImpl, resolver: publicDns, now: NOW });

    state.body = cal(A("20261110T110000", "20261110T114500"), B(["STATUS:CANCELLED"]));
    const r = await feeds.syncCalendarFeed(org, id, { fetchImpl, resolver: publicDns, now: NOW });
    expect(r).toMatchObject({ created: 0, updated: 1, cancelled: 3 });
    const list = await rows(org);
    expect(list).toHaveLength(4);
    const by = (k: string) => list.find((x) => x.event_key.startsWith(k))!;
    expect(new Date(by("a@").starts_at).toISOString()).toBe("2026-11-10T10:00:00.000Z");
    expect(by("a@").status).toBe("planned");
    expect(by("b@").status).toBe("cancelled");
    expect(list.filter((x) => x.event_key.startsWith("s@")).every((x) => x.status === "cancelled")).toBe(true);

    // Ereignis taucht wieder auf → Termin wird reaktiviert
    state.body = cal(A("20261110T110000", "20261110T114500"), B(), SERIES);
    const back = await feeds.syncCalendarFeed(org, id, { fetchImpl, resolver: publicDns, now: NOW });
    expect(back).toMatchObject({ created: 0, updated: 3 });
    expect((await rows(org)).every((x) => x.status === "planned")).toBe(true);
  });

  it("in PodoHero geänderte Termine werden nicht überschrieben und nicht abgesagt (Konfliktkennzeichen); Zuordnung und „erledigt“ sind kein Konflikt", async () => {
    const { org, id } = await setup();
    const state = { body: cal(A(), B()) };
    const fetchImpl = server(state);
    await feeds.syncCalendarFeed(org, id, { fetchImpl, resolver: publicDns, now: NOW });
    const before = await rows(org);
    const a = before.find((x) => x.event_key === "a@google.com")!;
    const b = before.find((x) => x.event_key === "b@google.com")!;
    await f.asOrg(org, (c) => c.query("update appointments set starts_at = starts_at + interval '15 minutes', updated_at = now() where id = $1", [a.id]));
    const patient = await f.patient(org);
    const auth = { organization: { id: org }, user: { id: crypto.randomUUID() }, can: () => true } as unknown as Parameters<typeof feeds.assignFeedAppointmentPatient>[0];
    expect(await feeds.assignFeedAppointmentPatient(auth, b.id, patient)).toBe(true);

    state.body = cal(A("20261110T120000", "20261110T123000"), B(["DESCRIPTION:neu"]));
    const r = await feeds.syncCalendarFeed(org, id, { fetchImpl, resolver: publicDns, now: NOW });
    expect(r).toMatchObject({ updated: 1, localChanges: 1 });
    const after = await rows(org);
    const a2 = after.find((x) => x.id === a.id)!;
    expect(new Date(a2.starts_at).toISOString()).toBe("2026-11-10T08:45:00.000Z"); // lokale Änderung bleibt
    expect(a2.conflict).toBe("local_change");
    const b2 = after.find((x) => x.id === b.id)!;
    expect(b2.patient_id).toBe(patient); // manuelle Zuordnung bleibt
    expect(b2.notes).toBe("neu");

    // aus dem Kalender gelöscht: lokal geänderter Termin bleibt bestehen
    state.body = cal(B(["DESCRIPTION:neu"]));
    await feeds.syncCalendarFeed(org, id, { fetchImpl, resolver: publicDns, now: NOW });
    expect((await rows(org)).find((x) => x.id === a.id)!.status).toBe("planned");

    // „erledigt“ ist normaler Ablauf: kein Konflikt, solange der Kalender unverändert bleibt
    await f.asOrg(org, (c) => c.query("update appointments set status = 'done' where id = $1", [b.id]));
    const r2 = await feeds.syncCalendarFeed(org, id, { fetchImpl, resolver: publicDns, now: NOW });
    expect(r2).toMatchObject({ updated: 0, cancelled: 0 });
    expect((await rows(org)).find((x) => x.id === b.id)).toMatchObject({ status: "done", conflict: null });

    // in PodoHero gelöschter Termin wird nicht neu angelegt
    await f.asOrg(org, (c) => c.query("delete from appointments where id = $1", [b.id]));
    const r3 = await feeds.syncCalendarFeed(org, id, { fetchImpl, resolver: publicDns, now: NOW });
    expect(r3).toMatchObject({ created: 0 });
    expect((await rows(org)).find((x) => x.event_key === "b@google.com")).toMatchObject({ id: null, conflict: "deleted_locally" });
  });

  it("kennzeichnet Überschneidungen mit PodoHero-Terminen derselben Behandler:in", async () => {
    const { org, id, therapist } = await setup();
    const other = await f.user();
    await f.asOrg(org, (c) =>
      c.query(
        "insert into appointments (organization_id, therapist_id, starts_at, ends_at, title) values ($1,$2,'2026-11-10T08:00:00Z','2026-11-10T09:00:00Z','Praxis-Termin'), ($1,$3,'2026-11-12T13:00:00Z','2026-11-12T14:00:00Z','andere Behandlerin')",
        [org, therapist, other],
      ),
    );
    const fetchImpl = server({ body: cal(A(), B()) });
    const r = await feeds.syncCalendarFeed(org, id, { fetchImpl, resolver: publicDns, now: NOW });
    expect(r).toMatchObject({ created: 2, overlaps: 1 });
    const list = await rows(org);
    expect(list.find((x) => x.event_key === "a@google.com")!.conflict).toBe("overlap");
    expect(list.find((x) => x.event_key === "b@google.com")!.conflict).toBeNull();

    // Praxis-Termin abgesagt → Kennzeichen verschwindet beim nächsten Abgleich
    await f.asOrg(org, (c) => c.query("update appointments set status = 'cancelled' where organization_id = $1 and title = 'Praxis-Termin'", [org]));
    const r2 = await feeds.syncCalendarFeed(org, id, { fetchImpl, resolver: publicDns, now: NOW });
    expect(r2).toMatchObject({ overlaps: 0 });
    expect((await rows(org)).every((x) => x.conflict === null)).toBe(true);
  });

  it("Fehler werden ohne URL gespeichert; private Ziele werden nicht abgerufen", async () => {
    const { org, id } = await setup();
    const fetchImpl = vi.fn(async () => new Response("x"));
    const r = await feeds.syncCalendarFeed(org, id, { fetchImpl, resolver: async () => [{ address: "10.1.2.3" }], now: NOW });
    expect("error" in r && r.error).toMatch(/nicht erlaubt/);
    expect(fetchImpl).not.toHaveBeenCalled();
    const [feed] = await f.asOrg(org, async (c) => (await c.query("select last_error, last_sync_at from calendar_feeds where id = $1", [id])).rows);
    expect(feed.last_error).toMatch(/nicht erlaubt/);
    expect(feed.last_error).not.toContain("private-");
    expect(feed.last_sync_at).toBeNull();
  });

  it("Mandantentrennung: fremde Praxis sieht weder Abos noch Zuordnungen; Zuordnung zu fremdem Abo wird abgewiesen", async () => {
    const { org, id } = await setup();
    await feeds.syncCalendarFeed(org, id, { fetchImpl: server({ body: cal(A()) }), resolver: publicDns, now: NOW });
    const other = await f.org();
    const seen = await f.asOrg(other, async (c) => [
      (await c.query("select 1 from calendar_feeds where id = $1", [id])).rowCount,
      (await c.query("select 1 from calendar_feed_events where feed_id = $1", [id])).rowCount,
    ]);
    expect(seen).toEqual([0, 0]);
    await expect(
      f.asOrg(other, (c) => c.query("insert into calendar_feed_events (organization_id, feed_id, event_key, hash, applied_hash) values ($1,$2,'x','h','h')", [other, id])),
    ).rejects.toThrow();
  });

  it("Cron wählt aktive Abos (ohne gelöschte Praxen/pausierte Abos); Health-Zähler", async () => {
    const { org, id } = await setup();
    const paused = await setup();
    await f.asOrg(paused.org, (c) => c.query("update calendar_feeds set active = false where id = $1", [paused.id]));
    const deleted = await setup();
    await f.pool.query("update organizations set deletion_requested_at = now() where id = $1", [deleted.org]);

    const seen: string[] = [];
    const res = await feeds.runCalendarFeedSyncAll({
      concurrency: 2,
      sync: async (o, feedId) => {
        seen.push(feedId);
        if (feedId === id) expect(o).toBe(org);
        return { error: "Test" };
      },
    });
    expect(seen).toContain(id);
    expect(seen).not.toContain(paused.id);
    expect(seen).not.toContain(deleted.id);
    expect(res.errors).toBe(seen.length);

    const slow = await feeds.runCalendarFeedSyncAll({ timeoutMs: 10, sync: (_o, feedId) => (feedId === id ? new Promise(() => {}) : Promise.resolve({ error: "x" })) });
    expect(slow.errors).toBe(slow.feeds);

    const h = await feeds.calendarFeedHealth(30);
    expect(h.active).toBeGreaterThanOrEqual(1);
    expect(h.stale).toBeLessThanOrEqual(h.active);
  });

  it("Entfernen eines Abos sagt künftige, unveränderte Termine ab und löscht nichts", async () => {
    const { org, id } = await setup();
    await feeds.syncCalendarFeed(org, id, { fetchImpl: server({ body: cal(A(), B()) }), resolver: publicDns, now: NOW });
    const ids = (await rows(org)).map((x) => x.id);
    const auth = { organization: { id: org }, user: { id: crypto.randomUUID() }, can: () => true } as unknown as Parameters<typeof feeds.deleteCalendarFeed>[0];
    const r = await feeds.deleteCalendarFeed(auth, id, NOW);
    expect(r.cancelled).toBe(2);
    const left = await f.asOrg(org, async (c) => (await c.query("select status from appointments where id = any($1)", [ids])).rows);
    expect(left.map((x) => x.status)).toEqual(["cancelled", "cancelled"]);
  });
});
