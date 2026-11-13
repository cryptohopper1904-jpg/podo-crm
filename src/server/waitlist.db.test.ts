/**
 * Warteliste & Patientenportal-Buchung gegen PostgreSQL:
 *  - Absage → passende Einträge bekommen ein Angebot (nur mit Einwilligung), ohne Einwilligung → Vorschlag im Posteingang
 *  - wer zuerst annimmt, bekommt den Termin (parallel: genau eine Annahme), alle anderen „schon vergeben“
 *  - Portal-Buchung hängt an die Akte der Person, parallele Buchungen derselben Zeit → genau eine
 *  - Verschieben bis 24 h vorher (alter Termin abgesagt, neuer angelegt)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { hashPortalToken, newPortalToken } from "@/lib/portal";
import { berlinDateIso, berlinToUtc } from "@/lib/format";
import type { MessagingPort } from "@/integrations/types";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

/** nächster Werktag (Di–Do) mindestens `minDays` Tage in der Zukunft (Berliner Datum) */
function futureWeekday(minDays: number) {
  let t = Date.now() + minDays * 86400_000;
  for (;;) {
    const iso = berlinDateIso(new Date(t));
    const wd = new Date(`${iso}T12:00:00Z`).getUTCDay();
    if (wd >= 2 && wd <= 4) return iso;
    t += 86400_000;
  }
}

(TEST_DB ? describe : describe.skip)("Warteliste & Portal-Buchung (DB)", () => {
  const f = fixtures(TEST_DB!);
  let wl: typeof import("./waitlist");
  let pb: typeof import("./portal-booking");
  const sent: { to: string; body: string }[] = [];
  const port: MessagingPort = {
    provider: "email_imap",
    isMock: true,
    async send(m: { to: string; body: string }) {
      sent.push({ to: m.to, body: m.body });
      return { externalId: `mock-${sent.length}` };
    },
    parseInbound: () => [],
  } as unknown as MessagingPort;
  const deps = { getPort: async () => port, baseUrl: "https://praxis.test" };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    wl = await import("./waitlist");
    pb = await import("./portal-booking");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  async function service(org: string, code = "PK", durationMin = 40) {
    return (await f.asOrg(org, (c) => c.query("insert into services (organization_id, code, name, price_cents, duration_min, category) values ($1,$2,$3,4500,$4,'treatment') returning id", [org, code, `Leistung ${code}`, durationMin]))).rows[0].id as string;
  }
  async function appt(org: string, patientId: string | null, start: Date, min: number, status = "planned", serviceId?: string) {
    return f.asOrg(org, async (c) => {
      const id = (await c.query("insert into appointments (organization_id, patient_id, starts_at, ends_at, status, source) values ($1,$2,$3,$4,$5,'manual') returning id", [org, patientId, start, new Date(start.getTime() + min * 60_000), status])).rows[0].id as string;
      if (serviceId) await c.query("insert into appointment_services (organization_id, appointment_id, service_id) values ($1,$2,$3)", [org, id, serviceId]);
      return id;
    });
  }
  type Wish = { serviceIds?: string[]; weekdays?: number[]; dayparts?: string[] } | string | null;
  /** Wartelisten-Eintrag: Objekt → strukturierte Spalten, Text → Altbestand (Freitext in „wishes“) */
  async function waitFor(org: string, patientId: string, wish: Wish, ageDays: number) {
    const w = typeof wish === "object" && wish ? wish : {};
    await f.asOrg(org, (c) =>
      c.query(
        "insert into waitlist (organization_id, patient_id, wishes, service_ids, weekdays, dayparts, created_at) values ($1,$2,$3,$4,$5,$6, now() - ($7 || ' days')::interval)",
        [org, patientId, typeof wish === "string" ? wish : null, w.serviceIds ?? [], w.weekdays ?? [], w.dayparts ?? [], String(ageDays)],
      ),
    );
  }
  async function portalLink(org: string, patientId: string) {
    const token = newPortalToken();
    const r = await f.pool.query("insert into patient_links (organization_id, patient_id, purpose, token_hash, expires_at) values ($1,$2,'portal',$3, now() + interval '1 day') returning id, organization_id, patient_id, purpose, expires_at, revoked_at", [org, patientId, hashPortalToken(token)]);
    const l = r.rows[0];
    return { id: l.id as string, organizationId: org, patientId, purpose: "portal", expiresAt: new Date(l.expires_at), revokedAt: null };
  }
  /** Token aus der (Mock-)Nachricht an eine Adresse – das Ergebnis von offerFreedSlot enthält keine Links */
  const tokenFor = (to: string) => sent.filter((m) => m.to === to).pop()!.body.match(/\/portal\/angebot\/([A-Za-z0-9_-]+)/)![1];

  it("Absage → Angebot an passende Personen mit Einwilligung; erste Annahme gewinnt, andere „schon vergeben“", async () => {
    const org = await f.org();
    const pk = await service(org, "PK");
    const fp = await service(org, "FP");
    const day = futureWeekday(3);
    const start = berlinToUtc(day, "10:00");
    const owner = await f.patient(org, { firstName: "Absagend" });
    const a = await f.patient(org, { firstName: "Anna", email: "anna@example.org", preferredChannel: "email" });
    const b = await f.patient(org, { firstName: "Bernd", email: "bernd@example.org", preferredChannel: "email" });
    const noConsent = await f.patient(org, { firstName: "Carla", lastName: "Ohne", phoneMobile: "0151 2222222" });
    const wrongTime = await f.patient(org, { firstName: "Dora", email: "dora@example.org" });
    const wrongService = await f.patient(org, { firstName: "Emil", email: "emil@example.org" });
    for (const p of [a, b, wrongTime, wrongService]) await f.consent(org, p, "email_reminders");
    await waitFor(org, b, { dayparts: ["morning"] }, 5);
    await waitFor(org, a, { serviceIds: [pk] }, 10);
    await waitFor(org, noConsent, null, 7);
    await waitFor(org, wrongTime, { dayparts: ["evening"] }, 20);
    await waitFor(org, wrongService, { serviceIds: [fp] }, 20);
    await waitFor(org, owner, null, 30); // die absagende Person selbst bekommt kein Angebot

    const id = await appt(org, owner, start, 40, "planned", pk);
    // noch nicht abgesagt → nichts
    expect((await wl.offerFreedSlot(org, id, deps)).skipped).toBe("not_cancelled");
    await f.asOrg(org, (c) => c.query("update appointments set status='cancelled' where id=$1", [id]));
    sent.length = 0;
    const r = await wl.offerFreedSlot(org, id, deps);
    expect(r.offered).toBe(2);
    expect(r.manual).toBe(1);
    expect(r).not.toHaveProperty("urls"); // keine Tokens im Rückgabewert
    expect(sent.map((s) => s.to).sort()).toEqual(["anna@example.org", "bernd@example.org"]);
    expect(sent[0].body).toContain("https://praxis.test/portal/angebot/");
    // erneuter Aufruf: niemand doppelt
    expect((await wl.offerFreedSlot(org, id, deps)).offered).toBe(0);
    // Posteingang: Angebotsübersicht + Anruf-Vorschlag; im Verlauf kein Klartext-Link
    const inbox = (await f.asOrg(org, (c) => c.query("select subject, body, status, direction, patient_id from messages where organization_id=$1 order by received_at", [org]))).rows;
    const summary = inbox.find((m) => m.subject.startsWith("Warteliste: freier Termin"));
    expect(summary?.body).not.toContain("Carla");
    expect(summary?.body).toContain("1 passende Person(en) ohne Einwilligung");
    // Anruf-Vorschlag an der Akte – ohne Telefonnummer als Kopie
    const call = inbox.find((m) => m.subject.startsWith("Warteliste: bitte anrufen"));
    expect(call?.patient_id).toBe(noConsent);
    expect(call?.status).toBe("suggested");
    expect(call?.body).toContain("Carla Ohne");
    expect(call?.body).not.toContain("2222222");
    // Link ↔ freier Termin direkt am Link
    const links = (await f.pool.query("select appointment_id from patient_links where organization_id=$1 and purpose='waitlist_offer'", [org])).rows;
    expect(links.map((x) => x.appointment_id)).toEqual([id, id]);
    expect(inbox.filter((m) => m.direction === "outbound").every((m) => !m.body.includes("/portal/angebot/"))).toBe(true);

    // Anzeige öffnet nichts; dann parallele Annahme → genau einer gewinnt
    const [ta, tb] = ["anna@example.org", "bernd@example.org"].map(tokenFor);
    expect((await wl.loadOffer(ta)).state).toBe("valid");
    const results = await Promise.all([wl.acceptOffer(ta), wl.acceptOffer(tb)]);
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    const loser = results.find((x) => !x.ok)!;
    expect(!loser.ok && loser.state).toBe("taken");
    expect(!loser.ok && loser.error).toMatch(/schon vergeben/);
    const booked = (await f.asOrg(org, (c) => c.query("select patient_id, status, starts_at, source from appointments where organization_id=$1 and status <> 'cancelled'", [org]))).rows;
    expect(booked).toHaveLength(1);
    expect(booked[0].source).toBe("portal");
    expect([a, b]).toContain(booked[0].patient_id);
    expect(new Date(booked[0].starts_at).getTime()).toBe(start.getTime());
    // Verlierer-Link zeigt „schon vergeben“, Gewinner „angenommen“, Wartelisten-Eintrag erledigt
    const winnerToken = results[0].ok ? ta : tb;
    const loserToken = results[0].ok ? tb : ta;
    expect((await wl.loadOffer(loserToken)).state).toBe("taken");
    expect((await wl.loadOffer(winnerToken)).state).toBe("accepted");
    expect((await wl.acceptOffer(winnerToken)).ok).toBe(false);
    const open = (await f.asOrg(org, (c) => c.query("select count(*)::int n from waitlist where patient_id=$1 and resolved_at is null", [booked[0].patient_id]))).rows[0].n;
    expect(open).toBe(0);
    expect((await wl.loadOffer(newPortalToken())).state).toBe("invalid");
  });

  it("Annahme übernimmt die Behandler:in nur, wenn sie weiterhin einen eigenen Kalender hat", async () => {
    const org = await f.org();
    for (const [role, keep, hour] of [["therapist", true, "09:00"], ["reception", false, "15:00"]] as const) {
      const u = await f.user();
      await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,$3)", [org, u, role]);
      const email = `tp-${role}@example.org`;
      const p = await f.patient(org, { email, preferredChannel: "email" });
      await f.consent(org, p, "email_reminders");
      await waitFor(org, p, null, 1);
      const id = await appt(org, null, berlinToUtc(futureWeekday(5), hour), 30, "cancelled");
      await f.asOrg(org, (c) => c.query("update appointments set therapist_id = $2 where id = $1", [id, u]));
      expect((await wl.offerFreedSlot(org, id, deps)).offered).toBe(1);
      expect((await wl.acceptOffer(tokenFor(email))).ok).toBe(true);
      const [row] = (await f.asOrg(org, (c) => c.query("select therapist_id from appointments where organization_id=$1 and patient_id=$2 and status='planned'", [org, p]))).rows;
      expect(row.therapist_id).toBe(keep ? u : null);
    }
  });

  it("Praxis bucht die Zeit selbst → offenes Angebot ist „schon vergeben“", async () => {
    const org = await f.org();
    const start = berlinToUtc(futureWeekday(4), "14:00");
    const p = await f.patient(org, { email: "p@example.org", preferredChannel: "email" });
    await f.consent(org, p, "email_reminders");
    await waitFor(org, p, null, 1);
    const id = await appt(org, null, start, 30, "cancelled");
    const r = await wl.offerFreedSlot(org, id, deps);
    expect(r.offered).toBe(1);
    await appt(org, null, start, 30, "planned");
    const t = tokenFor("p@example.org");
    expect((await wl.loadOffer(t)).state).toBe("taken");
    const acc = await wl.acceptOffer(t);
    expect(!acc.ok && acc.state).toBe("taken");
  });

  it("Portal-Buchung: an die eigene Akte, parallele Buchung derselben Zeit → genau eine", async () => {
    const org = await f.org();
    const pk = await service(org, "PK", 40);
    const me = await f.patient(org, { firstName: "Ich" });
    const other = await f.patient(org, { firstName: "Andere" });
    const day = futureWeekday(5);
    const l1 = await portalLink(org, me);
    const opts = await pb.portalBookingOptions(l1);
    expect(opts?.blocked).toBeNull();
    expect(opts?.services.map((s) => s.id)).toEqual([pk]);
    expect(opts?.days.length).toBeGreaterThan(20); // ~6 Wochen Werktage
    const slot = opts!.days.find((d) => d.date === day)!.slots[40][0];
    const l2 = await portalLink(org, other);
    const res = await Promise.all([pb.bookPortalAppointment(l1, { serviceId: pk, startsAt: slot }), pb.bookPortalAppointment(l2, { serviceId: pk, startsAt: slot })]);
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    const rows = (await f.asOrg(org, (c) => c.query("select patient_id, status, source, external_id from appointments where organization_id=$1", [org]))).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("planned");
    expect(rows[0].external_id).toMatch(/^portal:/);
    expect(rows[0].source).toBe("portal");
    // nicht freigegebene Zeit / außerhalb der Öffnungszeit
    expect((await pb.bookPortalAppointment(l1, { serviceId: pk, startsAt: berlinToUtc(day, "21:00").toISOString() })).ok).toBe(false);
    const inbox = (await f.asOrg(org, (c) => c.query("select subject from messages where organization_id=$1", [org]))).rows;
    expect(inbox.map((m) => m.subject)).toContain("Neue Buchung über das Patientenportal");
  });

  it("Tageslimit und Vorlaufzeit aus den Einstellungen", async () => {
    const org = await f.org({ settings: { onlineBooking: { maxPerDay: 1, leadHours: 24 * 3 } } });
    const pk = await service(org, "PK", 30);
    const me = await f.patient(org);
    const l = await portalLink(org, me);
    const opts = (await pb.portalBookingOptions(l))!;
    const first = opts.days.flatMap((d) => d.slots[30])[0];
    expect(new Date(first).getTime()).toBeGreaterThanOrEqual(Date.now() + 72 * 3600_000 - 60_000);
    const day = opts.days.find((d) => d.slots[30].length >= 2)!;
    expect((await pb.bookPortalAppointment(l, { serviceId: pk, startsAt: day.slots[30][0] })).ok).toBe(true);
    const second = await pb.bookPortalAppointment(l, { serviceId: pk, startsAt: day.slots[30][day.slots[30].length - 1] });
    expect(second.ok).toBe(false);
  });

  it("Verschieben: bis 24 h vorher, alter Termin abgesagt, neuer mit gleichen Leistungen", async () => {
    const org = await f.org();
    const pk = await service(org, "PK", 40);
    const me = await f.patient(org);
    const l = await portalLink(org, me);
    const oldStart = berlinToUtc(futureWeekday(6), "09:00");
    const id = await appt(org, me, oldStart, 40, "confirmed", pk);
    const opts = (await pb.portalBookingOptions(l, { rescheduleId: id }))!;
    expect(opts.reschedule?.durationMin).toBe(40);
    const target = opts.days.flatMap((d) => d.slots[40]).find((s) => new Date(s).getTime() > oldStart.getTime() + 86400_000)!;
    const r = await pb.reschedulePortalAppointment(l, { appointmentId: id, startsAt: target });
    expect(r.ok).toBe(true);
    const rows = (await f.asOrg(org, (c) => c.query("select a.id, a.status, a.starts_at, (select count(*)::int from appointment_services s where s.appointment_id=a.id) n from appointments a where a.organization_id=$1 order by a.created_at", [org]))).rows;
    expect(rows.map((x) => x.status)).toEqual(["cancelled", "planned"]);
    expect(rows[1].n).toBe(1);
    // zu kurzfristig (< 24 h) → abgelehnt
    const soon = await appt(org, me, new Date(Date.now() + 5 * 3600_000), 40, "planned", pk);
    const late = await pb.reschedulePortalAppointment(l, { appointmentId: soon, startsAt: target });
    expect(late.ok).toBe(false);
    // fremder Termin → abgelehnt
    const foreign = await appt(org, await f.patient(org), berlinToUtc(futureWeekday(8), "09:00"), 40, "planned", pk);
    expect((await pb.reschedulePortalAppointment(l, { appointmentId: foreign, startsAt: target })).ok).toBe(false);
  });

  it("Regression: Ursprungstermin wird reaktiviert/verschoben → Annahme vergibt ihn nicht doppelt", async () => {
    const org = await f.org();
    const start = berlinToUtc(futureWeekday(4), "11:00");
    const p = await f.patient(org, { email: "re@example.org", preferredChannel: "email" });
    await f.consent(org, p, "email_reminders");
    await waitFor(org, p, null, 1);
    const owner = await f.patient(org);
    const id = await appt(org, owner, start, 30, "cancelled");
    expect((await wl.offerFreedSlot(org, id, deps)).offered).toBe(1);
    const t = tokenFor("re@example.org");
    // Praxis reaktiviert den abgesagten Termin, bevor jemand annimmt
    await f.asOrg(org, (c) => c.query("update appointments set status='planned' where id=$1", [id]));
    const acc = await wl.acceptOffer(t);
    expect(!acc.ok && acc.state).toBe("taken");
    const active = (await f.asOrg(org, (c) => c.query("select count(*)::int n from appointments where organization_id=$1 and status <> 'cancelled'", [org]))).rows[0].n;
    expect(active).toBe(1);
  });

  it("Regression: ohne HTTPS-Basis-URL keine Angebots-Links", async () => {
    expect(wl.offerBaseUrl("http://praxis.example.org")).toBeNull();
    expect(wl.offerBaseUrl("")).toBeNull();
    expect(wl.offerBaseUrl("https://user:pw@praxis.example.org")).toBeNull();
    expect(wl.offerBaseUrl("https://praxis.example.org/")).toBe("https://praxis.example.org");
    expect(wl.offerBaseUrl("http://localhost:3117")).toBe("http://localhost:3117");
    const org = await f.org();
    const p = await f.patient(org, { email: "x@example.org", preferredChannel: "email" });
    await f.consent(org, p, "email_reminders");
    await waitFor(org, p, null, 1);
    const id = await appt(org, null, berlinToUtc(futureWeekday(4), "15:00"), 30, "cancelled");
    expect((await wl.offerFreedSlot(org, id, { ...deps, baseUrl: "http://praxis.example.org" })).skipped).toBe("no_https_url");
    const n = (await f.pool.query("select count(*)::int n from patient_links where organization_id=$1", [org])).rows[0].n;
    expect(n).toBe(0);
  });
});
