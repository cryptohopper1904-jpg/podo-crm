/**
 * Kalender: „Nicht da“/„Absagen“ und „Rückgängig“ (changeAppointmentStatus) sowie der Cron-Nachlauf für
 * Wartelisten-Angebote (runPendingWaitlistOffers). Echte DB, erfundene Daten.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { berlinDateIso, berlinToUtc } from "@/lib/format";
import type { MessagingPort } from "@/integrations/types";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

/** Werktag (Di–Do) mindestens `minDays` Tage in der Zukunft (Berliner Datum) */
function futureWeekday(minDays: number) {
  let t = Date.now() + minDays * 86400_000;
  for (;;) {
    const iso = berlinDateIso(new Date(t));
    const wd = new Date(`${iso}T12:00:00Z`).getUTCDay();
    if (wd >= 2 && wd <= 4) return iso;
    t += 86400_000;
  }
}

(TEST_DB ? describe : describe.skip)("Terminstatus mit Rückgängig (DB)", () => {
  const f = fixtures(TEST_DB!);
  let cs: typeof import("./calendar-status");
  let wl: typeof import("./waitlist");
  const sent: { to: string; body: string }[] = [];
  const port = {
    provider: "email_imap",
    isMock: true,
    async send(m: { to: string; body: string }) {
      sent.push({ to: m.to, body: m.body });
      return { externalId: `mock-${sent.length}` };
    },
    parseInbound: () => [],
  } as unknown as MessagingPort;
  const deps = { getPort: async () => port, baseUrl: "https://praxis.test" };
  const tokenFor = (to: string) => sent.filter((m) => m.to === to).pop()!.body.match(/\/portal\/angebot\/([A-Za-z0-9_-]+)/)![1];

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    cs = await import("./calendar-status");
    wl = await import("./waitlist");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const member = async (org: string, role = "therapist") => {
    const u = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,$3)", [org, u, role]);
    return u;
  };
  const authOf = (org: string, user: string, can: (p: string) => boolean = () => true) =>
    ({ organization: { id: org, name: "T", state: "BB" }, user: { id: user, name: "Test" }, can, support: null, role: "owner" }) as never;
  const appt = (org: string, o: { therapist?: string | null; patient?: string | null; start: Date; minutes?: number; status?: string; source?: string }) =>
    f.asOrg(org, async (c) =>
      (
        await c.query("insert into appointments (organization_id, therapist_id, patient_id, starts_at, ends_at, status, source, title) values ($1,$2,$3,$4,$5,$6,$7,'Behandlung') returning id", [
          org,
          o.therapist ?? null,
          o.patient ?? null,
          o.start,
          new Date(o.start.getTime() + (o.minutes ?? 30) * 60_000),
          o.status ?? "planned",
          o.source ?? "phone",
        ])
      ).rows[0].id as string,
    );
  const activeIn = async (org: string, start: Date, minutes: number) =>
    (
      await f.asOrg(org, (c) =>
        c.query("select count(*)::int n from appointments where organization_id = $1 and status <> 'cancelled' and starts_at < $3 and ends_at > $2", [org, start, new Date(start.getTime() + minutes * 60_000)]),
      )
    ).rows[0].n as number;
  const offerLinks = async (org: string, id: string) =>
    (await f.asOrg(org, (c) => c.query("select patient_id, revoked_at from patient_links where organization_id = $1 and appointment_id = $2 and purpose = 'waitlist_offer' order by created_at", [org, id]))).rows as {
      patient_id: string;
      revoked_at: Date | null;
    }[];
  const statusOf = async (org: string, id: string) => (await f.asOrg(org, (c) => c.query("select status from appointments where id = $1", [id]))).rows[0]?.status as string;
  /** Wartelisten-Eintrag (ohne Wünsche) einer Person mit E-Mail-Einwilligung */
  const waiting = async (org: string, email: string) => {
    const p = await f.patient(org, { firstName: "Wartend", email, preferredChannel: "email" });
    await f.consent(org, p, "email_reminders");
    await f.asOrg(org, (c) => c.query("insert into waitlist (organization_id, patient_id, created_at) values ($1,$2, now() - interval '3 days')", [org, p]));
    return p;
  };

  it("Absage → Rückgängig stellt den alten Status her; Protokoll mit vorherigem Status", async () => {
    const org = await f.org();
    const u = await member(org, "owner");
    const auth = authOf(org, u);
    const id = await appt(org, { therapist: u, start: new Date("2031-04-08T08:00:00Z"), status: "confirmed" });
    expect(await cs.changeAppointmentStatus(auth, { id, status: "cancelled" })).toMatchObject({ ok: true, prev: "confirmed" });
    expect(await statusOf(org, id)).toBe("cancelled");
    expect(await cs.changeAppointmentStatus(auth, { id, status: "confirmed", expected: "cancelled" })).toMatchObject({ ok: true, prev: "cancelled" });
    expect(await statusOf(org, id)).toBe("confirmed");
    const log = await f.asOrg(org, (c) => c.query("select meta from audit_log where organization_id = $1 and action = 'appointment.status' and entity_id = $2 order by id", [org, id]));
    expect(log.rows.map((r) => r.meta)).toEqual([
      { status: "cancelled", from: "confirmed", waitlist: "pending" },
      { status: "confirmed", from: "cancelled", undo: true },
    ]);
    // „Nicht da“ und zurück
    expect(await cs.changeAppointmentStatus(auth, { id, status: "no_show" })).toMatchObject({ ok: true, prev: "confirmed" });
    expect(await cs.changeAppointmentStatus(auth, { id, status: "confirmed", expected: "no_show" })).toMatchObject({ ok: true });
  });

  it("falsches `expected` und nicht erlaubte Übergänge werden abgelehnt", async () => {
    const org = await f.org();
    const u = await member(org, "owner");
    const auth = authOf(org, u);
    const id = await appt(org, { therapist: u, start: new Date("2031-04-09T08:00:00Z") });
    await cs.changeAppointmentStatus(auth, { id, status: "no_show" });
    expect(await cs.changeAppointmentStatus(auth, { id, status: "planned", expected: "cancelled" })).toEqual({ ok: false, error: cs.STALE_STATUS_MSG });
    expect(await statusOf(org, id)).toBe("no_show");
    // Wiederherstellen nur als Rückgängig (mit expected)
    expect(await cs.changeAppointmentStatus(auth, { id, status: "planned" })).toEqual({ ok: false, error: cs.NOT_ALLOWED_MSG });
    // „erledigt“ gibt es hier nicht; abgesagt → nicht erschienen auch nicht
    expect(await cs.changeAppointmentStatus(auth, { id, status: "done", expected: "no_show" })).toEqual({ ok: false, error: cs.NOT_ALLOWED_MSG });
    const done = await appt(org, { therapist: u, start: new Date("2031-04-09T10:00:00Z"), status: "done" });
    expect(await cs.changeAppointmentStatus(auth, { id: done, status: "cancelled" })).toEqual({ ok: false, error: cs.NOT_ALLOWED_MSG });
    expect(await statusOf(org, done)).toBe("done");
    expect(cs.statusChangeAllowed("planned", "cancelled")).toBe(true);
    expect(cs.statusChangeAllowed("cancelled", "planned")).toBe(false);
    expect(cs.statusChangeAllowed("cancelled", "planned", "cancelled")).toBe(true);
    expect(cs.statusChangeAllowed("done", "cancelled")).toBe(false);
  });

  it("abgerechnete und Doctolib-/externe Termine werden nicht abgesagt", async () => {
    const org = await f.org();
    const u = await member(org, "owner");
    const auth = authOf(org, u);
    const billed = await appt(org, { therapist: u, start: new Date("2031-04-10T08:00:00Z") });
    await f.asOrg(org, async (c) => {
      const inv = (await c.query("insert into invoices (organization_id, status) values ($1,'draft') returning id", [org])).rows[0].id;
      await c.query("insert into invoice_lines (organization_id, invoice_id, appointment_id, description, unit_price_cents, total_cents, vat_rate, position) values ($1,$2,$3,'Behandlung',4500,4500,0,1)", [org, inv, billed]);
      await c.query("update invoices set status='issued', number='T-ST-1', issued_at=current_date, due_at=current_date + 14, total_cents=4500, net_cents=4500 where id=$1", [inv]);
    });
    expect(await cs.changeAppointmentStatus(auth, { id: billed, status: "cancelled" })).toEqual({ ok: false, error: cs.BILLED_MSG });
    expect(await statusOf(org, billed)).toBe("planned");
    const doc = await appt(org, { therapist: u, start: new Date("2031-04-10T10:00:00Z"), source: "doctolib" });
    expect(await cs.changeAppointmentStatus(auth, { id: doc, status: "cancelled" })).toEqual({ ok: false, error: cs.EXTERNAL_MSG });
    // abgesagter externer Termin (z. B. Abgleich) lässt sich hier nicht wiederherstellen
    const ext = await appt(org, { therapist: u, start: new Date("2031-04-10T12:00:00Z"), source: "extern", status: "cancelled" });
    expect(await cs.changeAppointmentStatus(auth, { id: ext, status: "planned", expected: "cancelled" })).toEqual({ ok: false, error: cs.EXTERNAL_MSG });
  });

  it("fremde Praxis → nicht gefunden; ohne Schreibrecht → verboten", async () => {
    const org = await f.org();
    const other = await f.org();
    const u = await member(org, "owner");
    const v = await member(other, "owner");
    const id = await appt(org, { therapist: u, start: new Date("2031-04-11T08:00:00Z") });
    expect(await cs.changeAppointmentStatus(authOf(other, v), { id, status: "cancelled" })).toEqual({ ok: false, error: "Termin nicht gefunden." });
    await expect(cs.changeAppointmentStatus(authOf(org, u, (p) => p !== "appointments.write"), { id, status: "cancelled" })).rejects.toThrow();
    expect(await statusOf(org, id)).toBe("planned");
  });

  it("Absage → Warteliste nimmt an → Rückgängig abgelehnt, genau ein aktiver Termin im Slot", async () => {
    const org = await f.org();
    const u = await member(org, "owner");
    const auth = authOf(org, u);
    const start = berlinToUtc(futureWeekday(4), "10:00");
    const owner = await f.patient(org, { firstName: "Absagend" });
    await waiting(org, "nachruecker@example.org");
    const id = await appt(org, { therapist: u, patient: owner, start, minutes: 40 });
    expect((await cs.changeAppointmentStatus(auth, { id, status: "cancelled" })).ok).toBe(true);
    expect((await wl.offerFreedSlot(org, id, deps)).offered).toBe(1);
    expect((await wl.acceptOffer(tokenFor("nachruecker@example.org"))).ok).toBe(true);
    expect(await cs.changeAppointmentStatus(auth, { id, status: "planned", expected: "cancelled" })).toEqual({ ok: false, error: cs.SLOT_TAKEN_MSG });
    expect(await statusOf(org, id)).toBe("cancelled");
    const active = await f.asOrg(org, (c) =>
      c.query("select count(*)::int n from appointments where organization_id = $1 and status <> 'cancelled' and starts_at < $3 and ends_at > $2", [org, start, new Date(start.getTime() + 40 * 60_000)]),
    );
    expect(active.rows[0].n).toBe(1);
  });

  it("Rückgängig widerruft offene Wartelisten-Angebote des Termins", async () => {
    const org = await f.org();
    const u = await member(org, "owner");
    const auth = authOf(org, u);
    const start = berlinToUtc(futureWeekday(5), "11:00");
    const owner = await f.patient(org, { firstName: "Absagend" });
    await waiting(org, "angebot@example.org");
    const id = await appt(org, { therapist: u, patient: owner, start });
    await cs.changeAppointmentStatus(auth, { id, status: "cancelled" });
    expect((await wl.offerFreedSlot(org, id, deps)).offered).toBe(1);
    expect((await cs.changeAppointmentStatus(auth, { id, status: "planned", expected: "cancelled" })).ok).toBe(true);
    const links = await f.asOrg(org, (c) => c.query("select revoked_at from patient_links where organization_id = $1 and appointment_id = $2 and purpose = 'waitlist_offer'", [org, id]));
    expect(links.rows.length).toBe(1);
    expect(links.rows[0].revoked_at).not.toBeNull();
    expect((await wl.acceptOffer(tokenFor("angebot@example.org"))).ok).toBe(false);
    expect(await statusOf(org, id)).toBe("planned");
  });

  it("Cron-Nachlauf: verschickt genau ein Angebot für ausstehende Absagen, ältere/zurückgenommene nicht", async () => {
    const org = await f.org();
    const u = await member(org, "owner");
    const auth = authOf(org, u);
    const day = futureWeekday(6);
    const owner = await f.patient(org, { firstName: "Absagend" });
    await waiting(org, "cron@example.org");
    const id = await appt(org, { therapist: u, patient: owner, start: berlinToUtc(day, "09:00") });
    await cs.changeAppointmentStatus(auth, { id, status: "cancelled" });
    // noch in der Frist für „Rückgängig“: nichts
    expect(await cs.runPendingWaitlistOffers({ organizationIds: [org], deps })).toEqual({ checked: 0, offered: 0, failed: 0 });
    const later = new Date(Date.now() + 60_000);
    expect(await cs.runPendingWaitlistOffers({ organizationIds: [org], deps, now: later })).toEqual({ checked: 1, offered: 1, failed: 0 });
    expect(await cs.runPendingWaitlistOffers({ organizationIds: [org], deps, now: new Date(later.getTime() + 60_000) })).toEqual({ checked: 0, offered: 0, failed: 0 });
    const logs = await f.asOrg(org, (c) => c.query("select count(*)::int n from reminder_log where organization_id = $1 and appointment_id = $2 and kind = 'waitlist_offer'", [org, id]));
    expect(logs.rows[0].n).toBe(1);
    // zurückgenommene Absage und Absage ohne Markierung (vor dieser Version) lösen nichts aus
    const undone = await appt(org, { therapist: u, patient: owner, start: berlinToUtc(day, "13:00") });
    await cs.changeAppointmentStatus(auth, { id: undone, status: "cancelled" });
    await cs.changeAppointmentStatus(auth, { id: undone, status: "planned", expected: "cancelled" });
    const old = await appt(org, { therapist: u, patient: owner, start: berlinToUtc(day, "15:00"), status: "cancelled" });
    await f.asOrg(org, (c) => c.query("insert into audit_log (organization_id, action, entity, entity_id, meta) values ($1,'appointment.status','appointment',$2,'{\"status\":\"cancelled\"}')", [org, old]));
    expect(await cs.runPendingWaitlistOffers({ organizationIds: [org], deps, now: new Date(Date.now() + 120_000) })).toEqual({ checked: 0, offered: 0, failed: 0 });
  });

  it("Rückgängig gegen inzwischen gebuchte Zeit: Online-Buchung bzw. Nachrücker ohne Behandler:in → abgelehnt; direkt anschließend → erlaubt", async () => {
    const org = await f.org();
    const u = await member(org, "owner");
    const auth = authOf(org, u);
    const start = new Date("2031-05-06T08:00:00Z");
    const id = await appt(org, { therapist: u, start });
    await cs.changeAppointmentStatus(auth, { id, status: "cancelled" });
    const online = await appt(org, { therapist: null, start: new Date(start.getTime() + 10 * 60_000), source: "online" });
    expect(await cs.changeAppointmentStatus(auth, { id, status: "planned", expected: "cancelled" })).toEqual({ ok: false, error: cs.SLOT_TAKEN_MSG });
    // „nicht erschienen“ der anderen Buchung zählt weiter als belegt (nur „abgesagt“ gibt die Zeit frei)
    await f.asOrg(org, (c) => c.query("update appointments set status = 'no_show' where id = $1", [online]));
    expect((await cs.changeAppointmentStatus(auth, { id, status: "planned", expected: "cancelled" })).ok).toBe(false);
    await f.asOrg(org, (c) => c.query("update appointments set status = 'cancelled' where id = $1", [online]));
    // direkt anschließender Termin derselben Behandler:in (09:30) überschneidet nicht
    await appt(org, { therapist: u, start: new Date(start.getTime() + 30 * 60_000) });
    expect((await cs.changeAppointmentStatus(auth, { id, status: "planned", expected: "cancelled" })).ok).toBe(true);
  });

  it("Nachrücker ohne Behandler:in (ursprüngliche Person ohne eigenen Kalender) → Rückgängig abgelehnt", async () => {
    const org = await f.org();
    const u = await member(org, "owner");
    const rec = await member(org, "reception");
    const auth = authOf(org, u);
    const start = berlinToUtc(futureWeekday(4), "14:00");
    const owner = await f.patient(org, { firstName: "Absagend" });
    await waiting(org, "ohne-zuordnung@example.org");
    const id = await appt(org, { therapist: rec, patient: owner, start });
    await cs.changeAppointmentStatus(auth, { id, status: "cancelled" });
    expect((await wl.offerFreedSlot(org, id, deps)).offered).toBe(1);
    const acc = await wl.acceptOffer(tokenFor("ohne-zuordnung@example.org"));
    expect(acc.ok).toBe(true);
    const t = await f.asOrg(org, (c) => c.query("select therapist_id from appointments where id = $1", [acc.ok ? acc.appointmentId : null]));
    expect(t.rows[0].therapist_id).toBeNull();
    expect(await cs.changeAppointmentStatus(auth, { id, status: "planned", expected: "cancelled" })).toEqual({ ok: false, error: cs.SLOT_TAKEN_MSG });
    expect(await activeIn(org, start, 30)).toBe(1);
  });

  it("parallel: Rückgängig und Annahme des Angebots → genau ein aktiver Termin", async () => {
    for (let i = 0; i < 3; i++) {
      const org = await f.org();
      const u = await member(org, "owner");
      const auth = authOf(org, u);
      const start = berlinToUtc(futureWeekday(5 + i), "15:00");
      const owner = await f.patient(org, { firstName: "Absagend" });
      const email = `parallel${i}@example.org`;
      await waiting(org, email);
      const id = await appt(org, { therapist: u, patient: owner, start });
      await cs.changeAppointmentStatus(auth, { id, status: "cancelled" });
      expect((await wl.offerFreedSlot(org, id, deps)).offered).toBe(1);
      const [undo, acc] = await Promise.all([cs.changeAppointmentStatus(auth, { id, status: "planned", expected: "cancelled" }), wl.acceptOffer(tokenFor(email))]);
      expect(undo.ok !== acc.ok).toBe(true);
      expect(await activeIn(org, start, 30)).toBe(1);
    }
  });

  it("after() und Cron gleichzeitig: nur eine Angebotswelle", async () => {
    const org = await f.org();
    const u = await member(org, "owner");
    const auth = authOf(org, u);
    const start = berlinToUtc(futureWeekday(4), "16:00");
    const owner = await f.patient(org, { firstName: "Absagend" });
    for (const e of ["welle1@example.org", "welle2@example.org", "welle3@example.org"]) await waiting(org, e);
    const id = await appt(org, { therapist: u, patient: owner, start });
    const r = await cs.changeAppointmentStatus(auth, { id, status: "cancelled" });
    if (!r.ok) throw new Error(r.error);
    await Promise.all([
      cs.offerAfterCancel(org, id, { cancelledAt: r.changedAt, deps }),
      cs.runPendingWaitlistOffers({ organizationIds: [org], deps, now: new Date(Date.now() + 60_000) }),
      cs.offerAfterCancel(org, id, { cancelledAt: r.changedAt, deps }),
    ]);
    expect((await offerLinks(org, id)).length).toBe(3);
    // später nachgetragene Person: eine zweite (verspätete) Welle derselben Absage gibt es nicht
    await waiting(org, "welle4@example.org");
    expect((await cs.offerAfterCancel(org, id, { cancelledAt: r.changedAt, deps }))?.skipped).toBe("already_offered");
    expect((await offerLinks(org, id)).length).toBe(3);
  });

  it("erneute Absage nach Rückgängig: widerrufene Personen wieder berücksichtigt; alter Timer wirkt nicht", async () => {
    const org = await f.org();
    const u = await member(org, "owner");
    const auth = authOf(org, u);
    const start = berlinToUtc(futureWeekday(6), "08:00");
    const owner = await f.patient(org, { firstName: "Absagend" });
    const p = await waiting(org, "nochmal@example.org");
    const id = await appt(org, { therapist: u, patient: owner, start });
    const first = await cs.changeAppointmentStatus(auth, { id, status: "cancelled" });
    if (!first.ok) throw new Error(first.error);
    expect((await cs.offerAfterCancel(org, id, { cancelledAt: first.changedAt, deps }))?.offered).toBe(1);
    await cs.changeAppointmentStatus(auth, { id, status: "planned", expected: "cancelled" });
    const second = await cs.changeAppointmentStatus(auth, { id, status: "cancelled" });
    if (!second.ok) throw new Error(second.error);
    // Timer der ersten Absage: nichts (die zweite hat ihre eigene Frist)
    expect((await cs.offerAfterCancel(org, id, { cancelledAt: first.changedAt, deps }))?.skipped).toBe("superseded");
    expect((await offerLinks(org, id)).length).toBe(1);
    // vor Ablauf der Frist der zweiten Absage: Cron tut nichts
    expect((await cs.runPendingWaitlistOffers({ organizationIds: [org], deps })).checked).toBe(0);
    expect((await cs.offerAfterCancel(org, id, { cancelledAt: second.changedAt, deps }))?.offered).toBe(1);
    const links = await offerLinks(org, id);
    expect(links.map((l) => [l.patient_id, l.revoked_at === null])).toEqual([
      [p, false],
      [p, true],
    ]);
  });
  // ───────────── Nebenläufigkeit, Fehlerpfade und Grenzen (Review #87) ─────────────

  /** Backends, die direkt von einem der `pids` blockiert werden (warten auf eine Sperre) */
  const blockedBy = async (pids: number[]) =>
    (await f.pool.query("select pid from pg_stat_activity where wait_event_type = 'Lock' and pg_blocking_pids(pid) && $1::int[]", [pids])).rows.map((r) => r.pid as number);
  /** Wartet, bis `check` etwas liefert oder `settled` true ist (höchstens 5 s) */
  async function waitFor<T>(check: () => Promise<T[]>, settled: () => boolean = () => false): Promise<T[]> {
    for (let i = 0; i < 250; i++) {
      const r = await check();
      if (r.length || settled()) return r;
      await new Promise((res) => setTimeout(res, 20));
    }
    return [];
  }
  const throwing = async (): Promise<never> => {
    throw new Error("Testfehler: Angebot");
  };
  const auditCount = async (org: string, action: string, id: string) =>
    (await f.asOrg(org, (c) => c.query("select count(*)::int n from audit_log where organization_id = $1 and action = $2 and entity_id = $3", [org, action, id]))).rows[0].n as number;
  /** `n` abgesagte Termine mit „pending“-Protokoll zum Zeitpunkt `at` (Protokoll-Zeit = updated_at), direkt per SQL */
  const pendingCancellations = (org: string, n: number, at: Date) =>
    f.asOrg(org, async (c) => {
      const ids = (
        await c.query(
          "insert into appointments (organization_id, starts_at, ends_at, status, source, title, updated_at) select $1, timestamptz '2031-06-02 08:00Z' + g * interval '1 hour', timestamptz '2031-06-02 08:30Z' + g * interval '1 hour', 'cancelled', 'phone', 'Behandlung', $2 from generate_series(1, $3) g returning id",
          [org, at, n],
        )
      ).rows.map((r) => r.id as string);
      await c.query(
        "insert into audit_log (organization_id, action, entity, entity_id, meta, at) select $1, 'appointment.status', 'appointment', i::text, '{\"status\":\"cancelled\",\"from\":\"planned\",\"waitlist\":\"pending\"}', $2 from unnest($3::uuid[]) i",
        [org, at, ids],
      );
      return ids;
    });

  it("Race: Rückgängig, während offerFreedSlot die Links anlegt → neue Links widerrufen, nichts verschickt", async () => {
    const org = await f.org();
    const u = await member(org, "owner");
    const auth = authOf(org, u);
    const start = berlinToUtc(futureWeekday(5), "12:00");
    const owner = await f.patient(org, { firstName: "Absagend" });
    const p = await waiting(org, "race@example.org");
    const id = await appt(org, { therapist: u, patient: owner, start });
    expect((await cs.changeAppointmentStatus(auth, { id, status: "cancelled" })).ok).toBe(true);
    // zweite Transaktion hält einen (noch nicht committeten) aktiven Link derselben Person → der Link-Insert in
    // offerFreedSlot wartet (Unique-Index „ein aktives Angebot je Person“), nachdem der Termin gelesen wurde
    const blocker = await f.pool.connect();
    let undoSettled = false;
    let releaseSend!: () => void;
    const undoFinished = new Promise<void>((r) => (releaseSend = r));
    try {
      await blocker.query("begin");
      const blockerPid = (await blocker.query("select pg_backend_pid() pid")).rows[0].pid as number;
      await blocker.query("insert into patient_links (organization_id, patient_id, purpose, token_hash, expires_at, appointment_id) values ($1,$2,'waitlist_offer',$3, now() + interval '1 day', $4)", [org, p, `blk-${id}`, id]);
      // Versand erst nach dem Rückgängig → prüft, dass ein inzwischen widerrufener Link nicht mehr verschickt wird
      const offer = wl.offerFreedSlot(org, id, { ...deps, getPort: async () => (await undoFinished, port) });
      const [offerPid] = await waitFor(() => blockedBy([blockerPid]));
      expect(offerPid).toBeDefined();
      const undo = cs.changeAppointmentStatus(auth, { id, status: "planned", expected: "cancelled" }).finally(() => {
        undoSettled = true;
        releaseSend();
      });
      // Rückgängig muss auf die Terminzeile warten (for update in offerFreedSlot) – ohne Sperre liefe es hier durch
      const waitingUndo = await waitFor(() => blockedBy([offerPid]), () => undoSettled);
      expect(undoSettled).toBe(false);
      expect(waitingUndo.length).toBe(1);
      await blocker.query("rollback");
      const [o, r] = await Promise.all([offer, undo]);
      expect(r.ok).toBe(true);
      expect(o.offered).toBe(0);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
    }
    expect(await statusOf(org, id)).toBe("planned");
    const links = await offerLinks(org, id);
    expect(links.length).toBe(1);
    expect(links[0].revoked_at).not.toBeNull();
    expect(sent.some((m) => m.to === "race@example.org")).toBe(false);
    const rl = await f.asOrg(org, (c) => c.query("select status, revoked_at from reminder_log where organization_id = $1 and appointment_id = $2 and kind = 'waitlist_offer'", [org, id]));
    expect(rl.rows.length).toBe(1);
    expect(rl.rows[0].status).toBe("skipped");
    expect(rl.rows[0].revoked_at).not.toBeNull();
  });

  it("Rückgängig nach dem Versand: Versandnachweis „sent“ bleibt, Widerruf steht in revoked_at", async () => {
    const org = await f.org();
    const u = await member(org, "owner");
    const auth = authOf(org, u);
    const owner = await f.patient(org, { firstName: "Absagend" });
    await waiting(org, "nachweis@example.org");
    const id = await appt(org, { therapist: u, patient: owner, start: berlinToUtc(futureWeekday(6), "12:00") });
    await cs.changeAppointmentStatus(auth, { id, status: "cancelled" });
    expect((await wl.offerFreedSlot(org, id, deps)).offered).toBe(1);
    expect((await cs.changeAppointmentStatus(auth, { id, status: "planned", expected: "cancelled" })).ok).toBe(true);
    const rl = await f.asOrg(org, (c) => c.query("select status, detail, revoked_at from reminder_log where organization_id = $1 and appointment_id = $2", [org, id]));
    expect(rl.rows.length).toBe(1);
    expect(rl.rows[0].status).toBe("sent");
    expect(rl.rows[0].detail).toMatch(/Testmodus/);
    expect(rl.rows[0].revoked_at).not.toBeNull();
  });

  it("Rückgängig wartet auf die Buchungssperre: Online-Buchung ohne Zeilensperre gewinnt → Rückgängig abgelehnt", async () => {
    const org = await f.org();
    const u = await member(org, "owner");
    const auth = authOf(org, u);
    const start = new Date("2031-05-13T08:00:00Z");
    const id = await appt(org, { therapist: u, start });
    await cs.changeAppointmentStatus(auth, { id, status: "cancelled" });
    // wie /buchen: Buchungssperre, Überschneidung prüfen, anlegen – berührt die abgesagte Terminzeile nicht
    const booking = await f.pool.connect();
    let settled = false;
    try {
      await booking.query("begin");
      await booking.query("select set_config('app.org_id', $1, true)", [org]);
      const pid = (await booking.query("select pg_backend_pid() pid")).rows[0].pid as number;
      await booking.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`book:${org}`]);
      await booking.query("insert into appointments (organization_id, starts_at, ends_at, status, source, title) values ($1,$2,$3,'planned','online','Online')", [org, start, new Date(start.getTime() + 30 * 60_000)]);
      const undo = cs.changeAppointmentStatus(auth, { id, status: "planned", expected: "cancelled" }).finally(() => (settled = true));
      const blocked = await waitFor(() => blockedBy([pid]), () => settled);
      expect(settled).toBe(false);
      expect(blocked.length).toBe(1);
      await booking.query("commit");
      expect(await undo).toEqual({ ok: false, error: cs.SLOT_TAKEN_MSG });
    } finally {
      await booking.query("rollback").catch(() => undefined);
      booking.release();
    }
    expect(await activeIn(org, start, 30)).toBe(1);
    expect(await statusOf(org, id)).toBe("cancelled");
  });

  it("Rate-Limit: Absage/Rückgängig-Schleife → höchstens 2 Angebote je Person und Termin in 24 h", async () => {
    const org = await f.org();
    const u = await member(org, "owner");
    const auth = authOf(org, u);
    const owner = await f.patient(org, { firstName: "Absagend" });
    const p = await waiting(org, "schleife@example.org");
    const id = await appt(org, { therapist: u, patient: owner, start: berlinToUtc(futureWeekday(7), "09:00") });
    for (let i = 0; i < 2; i++) {
      await cs.changeAppointmentStatus(auth, { id, status: "cancelled" });
      expect((await wl.offerFreedSlot(org, id, deps)).offered).toBe(1);
      expect((await cs.changeAppointmentStatus(auth, { id, status: "planned", expected: "cancelled" })).ok).toBe(true);
    }
    const q = await waiting(org, "neu-dazu@example.org");
    await cs.changeAppointmentStatus(auth, { id, status: "cancelled" });
    expect((await wl.offerFreedSlot(org, id, deps)).offered).toBe(1);
    const links = await offerLinks(org, id);
    expect(links.filter((l) => l.patient_id === p).length).toBe(2);
    expect(links.filter((l) => l.patient_id === q).length).toBe(1);
    // nach 24 h wieder möglich
    await cs.changeAppointmentStatus(auth, { id, status: "planned", expected: "cancelled" });
    await cs.changeAppointmentStatus(auth, { id, status: "cancelled" });
    const later = new Date(Date.now() + 25 * 3600_000);
    expect((await wl.offerFreedSlot(org, id, { ...deps, now: later })).offered).toBe(2);
  });

  it("N3: Angebot wirft → kein „geprüft“, Cron holt nach", async () => {
    const org = await f.org();
    const u = await member(org, "owner");
    const auth = authOf(org, u);
    const owner = await f.patient(org, { firstName: "Absagend" });
    await waiting(org, "nachholen@example.org");
    const id = await appt(org, { therapist: u, patient: owner, start: berlinToUtc(futureWeekday(5), "13:00") });
    const r = await cs.changeAppointmentStatus(auth, { id, status: "cancelled" });
    if (!r.ok) throw new Error(r.error);
    expect(await cs.offerAfterCancel(org, id, { cancelledAt: r.changedAt, deps, offer: throwing })).toBeNull();
    expect(await auditCount(org, "waitlist.offer_checked", id)).toBe(0);
    expect(await auditCount(org, "waitlist.offer_failed", id)).toBe(1);
    expect(await cs.runPendingWaitlistOffers({ organizationIds: [org], deps, now: new Date(Date.now() + 60_000) })).toEqual({ checked: 1, offered: 1, failed: 0 });
    expect(await auditCount(org, "waitlist.offer_checked", id)).toBe(1);
  });

  it("Cron: nach 3 Fehlschlägen für eine Absage „geprüft“ mit Fehlervermerk, keine weiteren Versuche", async () => {
    const org = await f.org();
    const u = await member(org, "owner");
    const auth = authOf(org, u);
    const owner = await f.patient(org, { firstName: "Absagend" });
    await waiting(org, "aufgeben@example.org");
    const id = await appt(org, { therapist: u, patient: owner, start: berlinToUtc(futureWeekday(5), "17:00") });
    await cs.changeAppointmentStatus(auth, { id, status: "cancelled" });
    const later = new Date(Date.now() + 60_000);
    for (let i = 0; i < 3; i++) {
      expect(await cs.runPendingWaitlistOffers({ organizationIds: [org], deps, now: later, offer: throwing })).toEqual({ checked: 1, offered: 0, failed: 1 });
    }
    const checked = await f.asOrg(org, (c) => c.query("select meta from audit_log where organization_id = $1 and action = 'waitlist.offer_checked' and entity_id = $2", [org, id]));
    expect(checked.rows.map((x) => x.meta)).toEqual([expect.objectContaining({ skipped: "failed", failures: 3, error: expect.stringContaining("Testfehler") })]);
    expect(await cs.runPendingWaitlistOffers({ organizationIds: [org], deps, now: later })).toEqual({ checked: 0, offered: 0, failed: 0 });
    // Sicherheitsnetz: 3 Fehlschläge ohne Vermerk „geprüft“ (z. B. Schreiben scheiterte) → ebenfalls kein Versuch mehr
    const [other] = await pendingCancellations(org, 1, new Date(Date.now() - 3600_000));
    for (let i = 0; i < 3; i++) await f.asOrg(org, (c) => c.query("insert into audit_log (organization_id, action, entity, entity_id) values ($1,'waitlist.offer_failed','appointment',$2)", [org, other]));
    expect((await cs.runPendingWaitlistOffers({ organizationIds: [org], deps, offer: throwing })).checked).toBe(0);
  });

  it("Cron: ältere „pending“-Absage greift nach Rückgängig + erneuter Absage nicht (Protokoll-Zeit = updated_at)", async () => {
    const org = await f.org();
    const u = await member(org, "owner");
    const auth = authOf(org, u);
    const owner = await f.patient(org, { firstName: "Absagend" });
    await waiting(org, "alt@example.org");
    const id = await appt(org, { therapist: u, patient: owner, start: berlinToUtc(futureWeekday(6), "16:00") });
    // frühere Absage vor 1 h (Frist längst vorbei), inzwischen zurückgenommen …
    await f.asOrg(org, (c) =>
      c.query("insert into audit_log (organization_id, action, entity, entity_id, meta, at) values ($1,'appointment.status','appointment',$2,'{\"status\":\"cancelled\",\"from\":\"planned\",\"waitlist\":\"pending\"}', now() - interval '1 hour')", [org, id]),
    );
    // … und eben erneut abgesagt: diese Absage ist noch in der Frist für „Rückgängig“
    await cs.changeAppointmentStatus(auth, { id, status: "cancelled" });
    expect(await cs.runPendingWaitlistOffers({ organizationIds: [org], deps })).toEqual({ checked: 0, offered: 0, failed: 0 });
    expect((await offerLinks(org, id)).length).toBe(0);
  });

  it("Cron: höchstens 50 je Lauf, älteste zuerst, Praxen-Startposition wechselt je Lauf", async () => {
    const a = await f.org();
    const b = await f.org();
    const [first, second] = [a, b].sort();
    const now = new Date();
    const slot = 15 * 60_000;
    // Lauf 1 in einem Takt, in dem die erste Praxis (nach id) beginnt; Lauf 2 im nächsten Takt
    const idx = Math.floor(now.getTime() / slot);
    const t0 = new Date((idx % 2 ? idx + 1 : idx) * slot + 60_000);
    expect(cs.rotateOrgs([first, second], t0)[0]).toBe(first);
    await pendingCancellations(first, 99, new Date(now.getTime() - 3600_000));
    const [oldest] = await pendingCancellations(first, 1, new Date(now.getTime() - 3 * 3600_000));
    const [late] = await pendingCancellations(second, 1, new Date(now.getTime() - 3600_000));
    const calls: string[] = [];
    const record = async (_org: string, id: string) => {
      calls.push(id);
      return { offered: 0, manual: 0, skipped: "no_entries" };
    };
    const r1 = await cs.runPendingWaitlistOffers({ organizationIds: [a, b], deps, now: t0, offer: record });
    expect(r1.checked).toBe(cs.PENDING_MAX_PER_RUN);
    expect(calls[0]).toBe(oldest);
    expect(calls).not.toContain(late);
    const r2 = await cs.runPendingWaitlistOffers({ organizationIds: [a, b], deps, now: new Date(t0.getTime() + slot), offer: record });
    expect(r2.checked).toBe(cs.PENDING_MAX_PER_RUN);
    // ohne Rotation käme die zweite Praxis bei 100 ausstehenden Absagen der ersten in beiden Läufen nicht dran
    expect(calls).toContain(late);
    expect(new Set(calls).size).toBe(100);
    expect(cs.rotateOrgs([1, 2, 3], new Date(0))).toEqual([1, 2, 3]);
    expect(cs.rotateOrgs([1, 2, 3], new Date(slot))).toEqual([2, 3, 1]);
  });

  it("Cron: Fehler einer Praxis stoppen die anderen nicht", async () => {
    const bad = await f.org();
    const good = await f.org();
    const at = new Date(Date.now() - 3600_000);
    const [badId] = await pendingCancellations(bad, 1, at);
    const [goodId] = await pendingCancellations(good, 1, at);
    const offer = async (org: string) => {
      if (org === bad) throw new Error("Testfehler: Praxis");
      return { offered: 1, manual: 0 };
    };
    expect(await cs.runPendingWaitlistOffers({ organizationIds: [bad, good], deps, offer })).toEqual({ checked: 2, offered: 1, failed: 1 });
    expect(await auditCount(good, "waitlist.offer_checked", goodId)).toBe(1);
    expect(await auditCount(bad, "waitlist.offer_checked", badId)).toBe(0);
  });
});
