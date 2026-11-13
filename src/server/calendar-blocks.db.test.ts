/**
 * Kalender-Sperrzeiten gegen eine echte DB (RLS aktiv, erfundene Daten): Mandantentrennung und Org-Trigger,
 * Rechte, Konflikt bei Terminanlage/Verschieben, freie Zeiten / Online-Buchung / KI-Telefon, Serien-Ausnahmen.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { AuthContext } from "@/lib/auth/session";
import type { Permission } from "@/lib/auth/permissions";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";
import { addDaysIso } from "@/lib/calendar-grid";
import { berlinToUtc } from "@/lib/format";

// Montag 2031-05-05 (MESZ, UTC+2)
const MON = "2031-05-05";
const NOW = new Date("2031-05-01T06:00:00Z");

(TEST_DB ? describe : describe.skip)("Kalender-Sperrzeiten (DB)", () => {
  const f = fixtures(TEST_DB!);
  let bl: typeof import("./calendar-blocks");
  let ap: typeof import("./appointments");
  let cb: typeof import("./calendar-board");
  let pb: typeof import("./portal-booking");
  let voice: typeof import("./voice");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    bl = await import("./calendar-blocks");
    ap = await import("./appointments");
    cb = await import("./calendar-board");
    pb = await import("./portal-booking");
    voice = await import("./voice");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const authFor = (org: string, user: string, perms: Permission[], o: { role?: string; support?: boolean } = {}) =>
    ({
      organization: { id: org, state: "BE" },
      user: { id: user },
      role: o.role ?? "therapist",
      support: o.support ? { grantId: "g", scope: "write", expiresAt: new Date() } : null,
      can: (p: Permission) => perms.includes(p),
    }) as unknown as AuthContext;
  const THERAPIST: Permission[] = ["appointments.read", "appointments.write"];
  const OWNER: Permission[] = ["appointments.read", "appointments.write", "users.manage"];

  async function setup(settings: Record<string, unknown> = { opening: { from: "08:00", to: "16:00" } }) {
    const org = await f.org({ settings });
    const a = await f.user();
    const b = await f.user();
    const rec = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'owner'), ($1,$3,'therapist'), ($1,$4,'reception')", [org, a, b, rec]);
    return { org, a, b, rec, owner: authFor(org, a, OWNER, { role: "owner" }), ther: authFor(org, b, THERAPIST) };
  }
  const block = (o: Record<string, unknown> = {}) => ({
    userId: null as string | null,
    kind: "pause",
    title: "",
    startsOn: MON,
    endsOn: "",
    allDay: false,
    startTime: "12:00",
    endTime: "12:30",
    repeat: "none",
    weekdays: [] as number[],
    intervalWeeks: 1,
    note: "",
    ...o,
  });
  const ok = (r: { ok: boolean }) => {
    expect(r).toMatchObject({ ok: true });
    return (r as unknown as { id: string }).id;
  };

  it("Mandantentrennung (RLS) und Org-Trigger: Person/Ersteller:in nur aus derselben Praxis", async () => {
    const { org, a } = await setup();
    const other = await setup();
    await f.asOrg(org, (c) => c.query("insert into calendar_blocks (organization_id, user_id, starts_on, start_time, end_time, created_by) values ($1,$2,$3,'12:00','12:30',$2)", [org, a, MON]));
    const count = (o: string) => f.asOrg(o, (c) => c.query("select count(*)::int n from calendar_blocks")).then((r) => r.rows[0].n);
    expect(await count(org)).toBe(1);
    expect(await count(other.org)).toBe(0);
    // ohne gesetzten Mandanten: nichts sichtbar
    expect((await f.pool.query("select count(*)::int n from calendar_blocks")).rows[0].n).toBe(0);
    // fremde Praxis im WITH CHECK
    await expect(f.asOrg(org, (c) => c.query("insert into calendar_blocks (organization_id, starts_on, all_day) values ($1,$2,true)", [other.org, MON]))).rejects.toThrow();
    // Person einer anderen Praxis
    await expect(f.asOrg(org, (c) => c.query("insert into calendar_blocks (organization_id, user_id, starts_on, all_day) values ($1,$2,$3,true)", [org, other.a, MON]))).rejects.toThrow(/gehört nicht zu dieser Praxis/);
    // ungültige Werte (CHECK)
    await expect(f.asOrg(org, (c) => c.query("insert into calendar_blocks (organization_id, starts_on, start_time, end_time) values ($1,$2,'13:00','12:00')", [org, MON]))).rejects.toThrow();
    await expect(f.asOrg(org, (c) => c.query("insert into calendar_blocks (organization_id, starts_on, all_day, repeat) values ($1,$2,true,'weekly')", [org, MON]))).rejects.toThrow();
    // App-Funktion sieht fremde Sperrzeit nicht
    const [foreign] = (await f.asOrg(org, (c) => c.query("select id from calendar_blocks where organization_id = $1", [org]))).rows;
    expect(await bl.getBlock(other.owner, foreign.id)).toBeNull();
    expect(await bl.deleteBlock(other.owner, foreign.id)).toMatchObject({ ok: false });
    expect(await count(org)).toBe(1);
  });

  it("Rechte: eigene mit appointments.write; andere/ganze Praxis nur mit users.manage; Support nur lesen; Audit", async () => {
    const { org, a, b, rec, owner, ther } = await setup();
    const own = ok(await bl.createBlock(ther, block({ userId: b })));
    expect(await bl.createBlock(ther, block({ userId: a }))).toMatchObject({ ok: false, error: expect.stringMatching(/Team verwalten/) });
    expect(await bl.createBlock(ther, block({ userId: null }))).toMatchObject({ ok: false });
    // Empfang hat keinen eigenen Kalender → als Ziel unzulässig
    expect(await bl.createBlock(owner, block({ userId: rec }))).toMatchObject({ ok: false, error: expect.stringMatching(/Behandler:in/) });
    const praxis = ok(await bl.createBlock(owner, block({ userId: null, kind: "reinigung", startTime: "17:00", endTime: "18:00" })));
    ok(await bl.createBlock(owner, block({ userId: b, kind: "schulung" })));
    // Therapeut:in darf Praxis-Sperrzeit weder ändern noch löschen, eigene schon
    expect(await bl.updateBlock(ther, praxis, block({ userId: null }))).toMatchObject({ ok: false });
    expect(await bl.deleteBlock(ther, praxis)).toMatchObject({ ok: false });
    expect(await bl.updateBlock(ther, own, block({ userId: b, startTime: "12:15", endTime: "12:45" }))).toMatchObject({ ok: true });
    // eigene Sperrzeit nicht an andere Person „weitergeben“
    expect(await bl.updateBlock(ther, own, block({ userId: a }))).toMatchObject({ ok: false });
    // Support-Modus und fehlendes Schreibrecht: Ablehnung in der Serverschicht
    await expect(bl.createBlock(authFor(org, a, OWNER, { support: true }), block({ userId: null }))).rejects.toThrow();
    await expect(bl.createBlock(authFor(org, b, ["appointments.read"]), block({ userId: b }))).rejects.toThrow();
    expect(bl.canManageBlocksFor(authFor(org, a, OWNER, { support: true }), a)).toBe(false);
    // Lesen klappt mit Leserecht
    expect((await bl.getBlock(authFor(org, rec, ["appointments.read"]), praxis))?.kind).toBe("reinigung");
    const audit = await f.asOrg(org, (c) => c.query("select action, meta from audit_log where organization_id = $1 and entity = 'calendar_block' order by id", [org]));
    expect(audit.rows.map((r) => r.action)).toEqual(["calendar_block.create", "calendar_block.create", "calendar_block.create", "calendar_block.update"]);
    expect(audit.rows[1].meta).toMatchObject({ target: "praxis", kind: "reinigung" });
  });

  it("Terminanlage und Verschieben: Konflikt „Pause 12:00–12:30“, bewusst trotzdem möglich", async () => {
    const { org, b, owner } = await setup();
    ok(await bl.createBlock(owner, block({ userId: b, repeat: "daily", startsOn: MON })));
    ok(await bl.createBlock(owner, block({ userId: null, kind: "wartung", allDay: true, startTime: "", endTime: "", startsOn: "2031-05-07" })));
    const input = (start: Date, o: Record<string, unknown> = {}) => ({
      patientId: null, therapistId: b, occurrences: [start], durationMin: 30, source: "phone" as const, title: "Behandlung", notes: null, homeVisit: false, serviceIds: [], allowConflict: false, ...o,
    });
    // Di 06.05. 12:15 Berlin = 10:15 UTC
    const res = await ap.createInternalAppointments(org, input(new Date("2031-05-06T10:15:00Z")));
    expect(res).toMatchObject({ ok: false, conflict: true, clashes: [], absentDays: [] });
    expect(res.ok || !("conflict" in res) || !res.conflict ? "" : ap.conflictMessage(res)).toContain("Pause 12:00–12:30");
    // direkt nach der Pause frei
    expect((await ap.createInternalAppointments(org, input(new Date("2031-05-06T10:30:00Z")))).ok).toBe(true);
    // ganze Praxis: Wartung ganztägig am Mi
    const wed = await ap.createInternalAppointments(org, input(new Date("2031-05-07T07:00:00Z")));
    expect(wed.ok || !("conflict" in wed) || !wed.conflict ? "" : ap.conflictMessage(wed)).toContain("Wartung (ganztägig)");
    // Serie über mehrere Tage: Datum wird genannt
    const series = await ap.createInternalAppointments(org, input(new Date("2031-05-05T10:00:00Z"), { occurrences: [new Date("2031-05-05T10:00:00Z"), new Date("2031-05-12T10:00:00Z")] }));
    expect(series.ok || !("conflict" in series) || !series.conflict ? "" : ap.conflictMessage(series)).toMatch(/Pause 12:00–12:30 \(05\.05\.\), Pause 12:00–12:30 \(12\.05\.\)/);
    // trotzdem eintragen
    const forced = await ap.createInternalAppointments(org, input(new Date("2031-05-06T10:15:00Z"), { allowConflict: true }));
    expect(forced.ok).toBe(true);
    // Verschieben in die Pause → Konflikt, mit Bestätigung möglich
    const id = forced.ok ? forced.ids[0] : "";
    const auth = authFor(org, b, THERAPIST);
    const mv = await ap.rescheduleAppointment(auth, id, { startsAt: new Date("2031-05-08T10:00:00Z"), durationMin: 30, therapistId: b, allowConflict: false });
    expect(mv).toMatchObject({ ok: false, conflict: true, error: expect.stringContaining("Pause 12:00–12:30") });
    expect((await ap.rescheduleAppointment(auth, id, { startsAt: new Date("2031-05-08T10:00:00Z"), durationMin: 30, therapistId: b, allowConflict: true })).ok).toBe(true);
    // Belegungsprüfung im Formular nennt die Sperrzeit (nicht „außerhalb der Arbeitszeit“)
    const st = await cb.slotStatus(auth, { therapistId: b, dateIso: "2031-05-09", time: "12:00", durationMin: 30 });
    expect(st).toMatchObject({ blocks: ["Pause 12:00–12:30"], outsideHours: false });
  });

  it("Ziehen im Kalender (moveAppointment): Ablegen in einer Pause meldet Konflikt, mit Bestätigung möglich", async () => {
    const { org, b, owner } = await setup();
    ok(await bl.createBlock(owner, block({ userId: b, repeat: "daily", startsOn: MON })));
    const made = await ap.createInternalAppointments(org, {
      patientId: null, therapistId: b, occurrences: [new Date("2031-05-06T07:00:00Z")], durationMin: 30, source: "phone", title: "Behandlung", notes: null, homeVisit: false, serviceIds: [], allowConflict: false,
    });
    expect(made.ok).toBe(true);
    const id = made.ok ? made.ids[0] : "";
    const auth = authFor(org, b, THERAPIST);
    const move = (allowConflict: boolean) =>
      ap.moveAppointment(auth, {
        id,
        startsAt: "2031-05-06T10:00:00.000Z", // 12:00 Berlin
        durationMin: 30,
        therapistId: b,
        allowConflict,
        expectedStartsAt: "2031-05-06T07:00:00.000Z",
        expectedDurationMin: 30,
        expectedTherapistId: b,
      });
    expect(await move(false)).toMatchObject({ ok: false, conflict: true, error: expect.stringContaining("Pause 12:00–12:30") });
    expect(await move(true)).toMatchObject({ ok: true });
  });

  it("freie Zeiten, Online-Buchung und KI-Telefon bieten in Sperrzeiten nichts an", async () => {
    const { org, a, b, owner } = await setup({ opening: { from: "08:00", to: "16:00" }, onlineBooking: { enabled: true, leadHours: 0 } });
    // nur b arbeitet: Mo–Fr 11:00–13:30
    await f.asOrg(org, (c) => c.query("insert into working_hours (organization_id, user_id, weekday, start_time, end_time) select $1,$2,d,'11:00','13:30' from generate_series(1,5) d", [org, b]));
    await f.asOrg(org, (c) => c.query("insert into absences (organization_id, user_id, starts_on, ends_on) values ($1,$2,'2031-05-01','2031-05-31')", [org, a]));
    ok(await bl.createBlock(owner, block({ userId: b, repeat: "weekly", weekdays: [1, 2], startsOn: MON })));
    ok(await bl.createBlock(owner, block({ userId: null, kind: "schulung", startTime: "11:00", endTime: "11:30", startsOn: "2031-05-06" })));
    const found = await cb.searchFreeSlots(owner, { fromIso: MON, durationMin: 30, therapistId: b, limit: 20, now: NOW });
    const mon = found!.filter((s) => s.dateIso === MON).map((s) => s.time);
    expect(mon).toEqual(["11:00", "11:15", "11:30", "12:30", "12:45", "13:00"]);
    const tue = found!.filter((s) => s.dateIso === "2031-05-06").map((s) => s.time);
    expect(tue).toEqual(["11:30", "12:30", "12:45", "13:00"]);
    // Online-/Portal-Buchung (Team-Fenster)
    const o = { id: org, state: "BE", settings: { opening: { from: "08:00", to: "16:00" }, onlineBooking: { enabled: true, leadHours: 0 } } };
    const portal = await pb.portalFreeSlots(o, { durationMin: 30, now: NOW, onlyDay: "2031-05-06" });
    const times = portal.flatMap((d) => d.slots.map((s) => s.toISOString()));
    expect(times).not.toContain("2031-05-06T10:00:00.000Z"); // 12:00 Pause
    expect(times).not.toContain("2031-05-06T09:00:00.000Z"); // 11:00 Schulung (ganze Praxis)
    expect(times).toContain("2031-05-06T10:30:00.000Z"); // 12:30 frei
    // KI-Telefon
    const v = await voice.findVoiceSlots(org, o, { fromIso: "2031-05-06", toIso: "2031-05-06", durationMin: 30, limit: 50, perDay: 50, earliest: NOW });
    expect(v.map((s) => s.toISOString())).not.toContain("2031-05-06T10:00:00.000Z");
    expect(v.map((s) => s.toISOString())).toContain("2031-05-06T10:30:00.000Z");
    // ohne Behandler:innen: Öffnungszeiten minus Sperrzeiten der ganzen Praxis
    const empty = await setup();
    await f.pool.query("delete from memberships where organization_id = $1", [empty.org]);
    await f.asOrg(empty.org, (c) => c.query("insert into calendar_blocks (organization_id, starts_on, start_time, end_time) values ($1,'2031-05-06','08:00','15:00')", [empty.org]));
    const v2 = await voice.findVoiceSlots(empty.org, { state: "BE", settings: { opening: { from: "08:00", to: "16:00" } } }, { fromIso: "2031-05-06", toIso: "2031-05-06", durationMin: 30, limit: 50, perDay: 50, earliest: NOW });
    expect(v2.map((s) => s.toISOString())).toEqual(["2031-05-06T13:00:00.000Z", "2031-05-06T13:30:00.000Z"]);
  });

  it("Serie: nur dieses Vorkommen ändern/löschen (Ausnahme) oder ganze Serie", async () => {
    const { org, b, owner } = await setup();
    const id = ok(await bl.createBlock(owner, block({ userId: b, repeat: "weekly", weekdays: [1], startsOn: MON, endsOn: "2031-06-30" })));
    const dates = async () =>
      (await cb.calendarBoard(owner, MON, "2031-05-26")).blocks.filter((o) => o.userId === b).map((o) => `${o.dateIso} ${o.startMin}`);
    expect(await dates()).toEqual([`${MON} 720`, "2031-05-12 720", "2031-05-19 720", "2031-05-26 720"]);
    // 12.05. nur dieses Vorkommen auf 13:00–13:30
    const single = ok(await bl.updateBlock(owner, id, block({ userId: b, startsOn: "2031-05-12", startTime: "13:00", endTime: "13:30" }), "occurrence", "2031-05-12"));
    expect(single).not.toBe(id);
    expect(await dates()).toEqual([`${MON} 720`, "2031-05-12 780", "2031-05-19 720", "2031-05-26 720"]);
    // 19.05. löschen
    expect(await bl.deleteBlock(owner, id, "occurrence", "2031-05-19")).toEqual({ ok: true });
    expect(await dates()).toEqual([`${MON} 720`, "2031-05-12 780", "2031-05-26 720"]);
    expect((await bl.getBlock(owner, id))?.exceptions.sort()).toEqual(["2031-05-12", "2031-05-19"]);
    // nicht vorhandenes Vorkommen
    expect(await bl.deleteBlock(owner, id, "occurrence", "2031-05-20")).toMatchObject({ ok: false });
    // ganze Serie ändern (Ausnahmen bleiben), dann löschen
    expect(await bl.updateBlock(owner, id, block({ userId: b, repeat: "weekly", weekdays: [1], startsOn: MON, startTime: "12:30", endTime: "13:00" }), "series")).toMatchObject({ ok: true });
    expect(await dates()).toEqual([`${MON} 750`, "2031-05-12 780", "2031-05-26 750"]);
    expect(await bl.deleteBlock(owner, id, "series")).toEqual({ ok: true });
    expect(await dates()).toEqual(["2031-05-12 780"]);
    const audit = await f.asOrg(org, (c) => c.query("select meta->>'scope' s from audit_log where organization_id = $1 and action like 'calendar_block.%' and action <> 'calendar_block.create' order by id", [org]));
    expect(audit.rows.map((r) => r.s)).toEqual(["occurrence", "occurrence", "series", "series"]);
    const metas = await f.asOrg(org, (c) => c.query("select meta from audit_log where organization_id = $1 and action = 'calendar_block.delete' order by id", [org]));
    expect(metas.rows[0].meta).toMatchObject({ oldRepeat: "weekly", oldUserId: b, oldTarget: "person" });
  });

  it("Konfliktprüfung bei Serienterminen über mehr als 400 Tage, auch mit vielen Regeln schnell", async () => {
    const { org, b, owner } = await setup();
    // drei tägliche Pausen-Regeln (Person + ganze Praxis), Beginn weit vorher
    ok(await bl.createBlock(owner, block({ userId: b, repeat: "daily", startsOn: "2030-01-01", startTime: "12:00", endTime: "12:30" })));
    ok(await bl.createBlock(owner, block({ userId: null, repeat: "daily", startsOn: "2030-01-01", kind: "reinigung", startTime: "07:00", endTime: "07:30" })));
    ok(await bl.createBlock(owner, block({ userId: b, repeat: "daily", startsOn: "2030-01-01", kind: "schulung", startTime: "16:00", endTime: "17:00" })));
    // Termin „alle 6 Wochen × 12“ um 12:15 Berlin: letztes Vorkommen 462 Tage nach dem ersten
    // je Vorkommen 12:15 Berliner Zeit (über Zeitumstellungen hinweg)
    const occurrences = Array.from({ length: 12 }, (_, i) => berlinToUtc(addDaysIso(MON, i * 42), "12:15"));
    const t0 = Date.now();
    const res = await ap.createInternalAppointments(org, {
      patientId: null, therapistId: b, occurrences, durationMin: 30, source: "phone", title: "Behandlung", notes: null, homeVisit: false, serviceIds: [], allowConflict: false,
    });
    const ms = Date.now() - t0;
    expect(res).toMatchObject({ ok: false, conflict: true });
    const blocks = res.ok || !("conflict" in res) || !res.conflict ? [] : res.blocks;
    // jedes der 12 Vorkommen kollidiert mit der Pause – auch das letzte (> 400 Tage)
    expect(new Set(blocks.filter((x) => x.label === "Pause").map((x) => x.dateIso)).size).toBe(12);
    expect(blocks.some((x) => x.dateIso >= "2032-08-01")).toBe(true);
    expect(ms).toBeLessThan(1500);
    // mehrtägiger Zeitraum: auch Tag 4 wird geprüft (keine feste Tagesgrenze)
    ok(await bl.createBlock(owner, block({ userId: null, kind: "wartung", allDay: true, startTime: "", endTime: "", startsOn: "2031-05-11" })));
    const { withOrg } = await import("@/db");
    const long = await withOrg(org, (tx) => bl.blockClashesInTx(tx, org, b, [{ start: berlinToUtc("2031-05-08", "18:00"), end: berlinToUtc("2031-05-11", "09:00") }]));
    expect(long.some((x) => x.label === "Wartung" && x.dateIso === "2031-05-11")).toBe(true);
  });

  it("KI-Antwortvorschläge (replyFacts): Sperrzeiten der ganzen Praxis werden nicht angeboten", async () => {
    const { org, owner } = await setup();
    const rc = await import("./reply-context");
    const tomorrow = new Date(Date.now() + 86400_000).toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
    expect((await rc.replyFacts(org, null)).facts.join(" ")).toMatch(/Freie Termine/);
    ok(await bl.createBlock(owner, block({ userId: null, kind: "wartung", repeat: "daily", allDay: true, startTime: "", endTime: "", startsOn: tomorrow })));
    expect((await rc.replyFacts(org, null)).facts.join(" ")).toMatch(/keine freien Termine/);
  });

  it("replyFacts über die Zeitumstellung (28.03.2026 23:30 Berlin): 29.03. wird nicht übersprungen, Praxis-Sperrzeit abgezogen", async () => {
    // täglich 08:00–12:00 geöffnet (auch So)
    const week = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, from: "08:00", to: "12:00" }));
    const { org, owner } = await setup({ practiceHours: week });
    const rc = await import("./reply-context");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-03-28T22:30:00Z")); // Sa 23:30 MEZ; in 24 h ist es bereits Mo 00:30 MESZ
      const before = (await rc.replyFacts(org, null, { days: 1 })).facts.join(" ");
      expect(before).toContain("Sonntag, 29. März um 08:00 Uhr");
      ok(await bl.createBlock(owner, block({ userId: null, kind: "reinigung", startsOn: "2026-03-29", startTime: "08:00", endTime: "09:00" })));
      const after = (await rc.replyFacts(org, null, { days: 1 })).facts.join(" ");
      expect(after).not.toContain("29. März um 08:");
      expect(after).toContain("Sonntag, 29. März um 09:00 Uhr");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Grenzen: verständliche Meldung bei zu vielen Ausnahmen und zu vielen aktiven Sperrzeiten; inaktive Person bleibt", async () => {
    const { org, b, owner } = await setup();
    const id = ok(await bl.createBlock(owner, block({ userId: b, repeat: "daily", startsOn: "2031-01-01" })));
    // 500 Ausnahmen direkt setzen (Werktage ab 2031-01-01)
    await f.asOrg(org, (c) =>
      c.query("update calendar_blocks set exceptions = (select array_agg(d::date) from (select d from generate_series('2031-01-01'::date, '2033-12-31'::date, '1 day') d where extract(isodow from d) <= 5 limit 500) x) where id = $1", [id]),
    );
    expect(await bl.deleteBlock(owner, id, "occurrence", "2034-01-02")).toMatchObject({ ok: false, error: expect.stringMatching(/zu viele/) });
    // 500 aktive Regeln → keine weitere
    await f.asOrg(org, (c) => c.query("insert into calendar_blocks (organization_id, starts_on, all_day) select $1, '2035-01-01'::date + g, true from generate_series(1, 499) g", [org]));
    expect(await bl.createBlock(owner, block({ userId: null, startsOn: "2036-01-01" }))).toMatchObject({ ok: false, error: expect.stringMatching(/500 aktive/) });
    // vergangene Einzel-Sperrzeiten zählen nicht
    await f.asOrg(org, (c) => c.query("update calendar_blocks set starts_on = '2020-01-01' where organization_id = $1 and repeat = 'none' and all_day", [org]));
    ok(await bl.createBlock(owner, block({ userId: null, startsOn: "2036-01-01" })));
    // vergangene Sperrzeit per „ganze Serie“ wieder in die Zukunft legen zählt wie Anlegen (Grenze nicht umgehbar)
    const past = (await f.asOrg(org, (c) => c.query("select id from calendar_blocks where organization_id = $1 and starts_on = '2020-01-01' limit 1", [org]))).rows[0].id as string;
    await f.asOrg(org, (c) => c.query("update calendar_blocks set starts_on = '2035-06-01' where organization_id = $1 and starts_on = '2020-01-01' and id <> $2", [org, past]));
    expect(await bl.updateBlock(owner, past, block({ userId: null, startsOn: "2037-01-01" }))).toMatchObject({ ok: false, error: expect.stringMatching(/500 aktive/) });
    // in der Vergangenheit ändern bleibt möglich
    expect(await bl.updateBlock(owner, past, block({ userId: null, startsOn: "2020-01-02" }))).toMatchObject({ ok: true });
    // Person nicht mehr aktiv: Ändern mit derselben Person bleibt möglich (kein stilles Umhängen nötig)
    await f.pool.query("update memberships set active = false where organization_id = $1 and user_id = $2", [org, b]);
    expect(await bl.updateBlock(owner, id, block({ userId: b, repeat: "daily", startsOn: "2031-01-01", startTime: "12:05", endTime: "12:35" }))).toMatchObject({ ok: true });
  });
});
