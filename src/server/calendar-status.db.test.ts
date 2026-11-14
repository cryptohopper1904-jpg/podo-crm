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
    expect(await cs.changeAppointmentStatus(auth, { id, status: "cancelled" })).toEqual({ ok: true, prev: "confirmed" });
    expect(await statusOf(org, id)).toBe("cancelled");
    expect(await cs.changeAppointmentStatus(auth, { id, status: "confirmed", expected: "cancelled" })).toEqual({ ok: true, prev: "cancelled" });
    expect(await statusOf(org, id)).toBe("confirmed");
    const log = await f.asOrg(org, (c) => c.query("select meta from audit_log where organization_id = $1 and action = 'appointment.status' and entity_id = $2 order by id", [org, id]));
    expect(log.rows.map((r) => r.meta)).toEqual([
      { status: "cancelled", from: "confirmed", waitlist: "pending" },
      { status: "confirmed", from: "cancelled", undo: true },
    ]);
    // „Nicht da“ und zurück
    expect(await cs.changeAppointmentStatus(auth, { id, status: "no_show" })).toEqual({ ok: true, prev: "confirmed" });
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
    expect(await cs.runPendingWaitlistOffers({ organizationId: org, deps })).toEqual({ checked: 0, offered: 0 });
    const later = new Date(Date.now() + 60_000);
    expect(await cs.runPendingWaitlistOffers({ organizationId: org, deps, now: later })).toEqual({ checked: 1, offered: 1 });
    expect(await cs.runPendingWaitlistOffers({ organizationId: org, deps, now: new Date(later.getTime() + 60_000) })).toEqual({ checked: 0, offered: 0 });
    const logs = await f.asOrg(org, (c) => c.query("select count(*)::int n from reminder_log where organization_id = $1 and appointment_id = $2 and kind = 'waitlist_offer'", [org, id]));
    expect(logs.rows[0].n).toBe(1);
    // zurückgenommene Absage und Absage ohne Markierung (vor dieser Version) lösen nichts aus
    const undone = await appt(org, { therapist: u, patient: owner, start: berlinToUtc(day, "13:00") });
    await cs.changeAppointmentStatus(auth, { id: undone, status: "cancelled" });
    await cs.changeAppointmentStatus(auth, { id: undone, status: "planned", expected: "cancelled" });
    const old = await appt(org, { therapist: u, patient: owner, start: berlinToUtc(day, "15:00"), status: "cancelled" });
    await f.asOrg(org, (c) => c.query("insert into audit_log (organization_id, action, entity, entity_id, meta) values ($1,'appointment.status','appointment',$2,'{\"status\":\"cancelled\"}')", [org, old]));
    expect(await cs.runPendingWaitlistOffers({ organizationId: org, deps, now: new Date(Date.now() + 120_000) })).toEqual({ checked: 0, offered: 0 });
  });
});
