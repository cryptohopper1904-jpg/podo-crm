/**
 * Kalender: Termin per Ziehen verschieben (moveAppointment → rescheduleAppointment) und Kalenderfarben je Behandler:in.
 * Echte DB, erfundene Daten.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Termin ziehen und Kalenderfarben (DB)", () => {
  const f = fixtures(TEST_DB!);
  let ap: typeof import("./appointments");
  let colors: typeof import("./therapist-colors");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    ap = await import("./appointments");
    colors = await import("./therapist-colors");
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
  const authOf = (org: string, user: string, o: { can?: (p: string) => boolean; support?: unknown } = {}) =>
    ({ organization: { id: org, name: "T", state: "BB" }, user: { id: user, name: "Test" }, can: o.can ?? (() => true), support: o.support ?? null, role: "owner" }) as never;
  const appt = (org: string, therapist: string | null, start: Date, minutes = 30, status = "planned") =>
    f.asOrg(org, async (c) =>
      (
        await c.query("insert into appointments (organization_id, therapist_id, starts_at, ends_at, status, source, title) values ($1,$2,$3,$4,$5,'phone','Behandlung') returning id", [
          org,
          therapist,
          start,
          new Date(start.getTime() + minutes * 60_000),
          status,
        ])
      ).rows[0].id as string,
    );
  const row = async (org: string, id: string) =>
    (await f.asOrg(org, (c) => c.query("select starts_at, ends_at, therapist_id from appointments where id = $1", [id]))).rows[0] as { starts_at: Date; ends_at: Date; therapist_id: string };
  const move = (id: string, startsAt: Date, durationMin: number, therapistId: string, allowConflict = false) => ({ id, startsAt: startsAt.toISOString(), durationMin, therapistId, allowConflict });

  it("verschiebt Zeit und Behandler:in (Spaltenwechsel) und protokolliert; Rückgängig über dieselbe Logik", async () => {
    const org = await f.org();
    const a = await member(org, "owner");
    const b = await member(org);
    const auth = authOf(org, a);
    const start = new Date("2032-03-02T09:00:00Z");
    const id = await appt(org, a, start, 40);
    const to = new Date("2032-03-04T13:30:00Z");
    expect(await ap.moveAppointment(auth, move(id, to, 40, b))).toEqual({ ok: true });
    expect(await row(org, id)).toMatchObject({ starts_at: to, ends_at: new Date(to.getTime() + 40 * 60_000), therapist_id: b });
    const log = await f.asOrg(org, (c) => c.query("select meta from audit_log where organization_id = $1 and action = 'appointment.reschedule' and entity_id = $2", [org, id]));
    expect(log.rows[0].meta).toMatchObject({ therapistChanged: true, durationMin: 40 });
    // Rückgängig = alte Werte über dieselbe Aktion
    expect(await ap.moveAppointment(auth, move(id, start, 40, a))).toEqual({ ok: true });
    expect(await row(org, id)).toMatchObject({ starts_at: start, therapist_id: a });
    // Dauer ändern (unterer Rand)
    expect(await ap.moveAppointment(auth, move(id, start, 75, a))).toEqual({ ok: true });
    expect((await row(org, id)).ends_at).toEqual(new Date(start.getTime() + 75 * 60_000));
  });

  it("Überschneidung: Meldung mit belegter Zeit, erst nach Bestätigung (allowConflict) verschoben", async () => {
    const org = await f.org();
    const a = await member(org);
    const auth = authOf(org, a);
    const id = await appt(org, a, new Date("2032-03-09T08:00:00Z"));
    await appt(org, a, new Date("2032-03-10T09:00:00Z"), 60);
    const to = new Date("2032-03-10T09:30:00Z");
    const res = await ap.moveAppointment(auth, move(id, to, 30, a));
    expect(res).toMatchObject({ ok: false, conflict: true, error: expect.stringContaining("10:00–11:00 Uhr") });
    expect((await row(org, id)).starts_at).toEqual(new Date("2032-03-09T08:00:00Z"));
    expect(await ap.moveAppointment(auth, move(id, to, 30, a, true))).toEqual({ ok: true });
    expect((await row(org, id)).starts_at).toEqual(to);
  });

  it("Abwesenheit der Ziel-Behandler:in: Rückfrage, danach möglich", async () => {
    const org = await f.org();
    const a = await member(org);
    const b = await member(org);
    await f.asOrg(org, (c) => c.query("insert into absences (organization_id, user_id, starts_on, ends_on, kind) values ($1,$2,'2032-03-16','2032-03-16','vacation')", [org, b]));
    const auth = authOf(org, a);
    const id = await appt(org, a, new Date("2032-03-16T08:00:00Z"));
    expect(await ap.moveAppointment(auth, move(id, new Date("2032-03-16T08:00:00Z"), 30, b))).toMatchObject({ ok: false, conflict: true, error: expect.stringMatching(/abwesend – nicht verfügbar \(16\.03\.2032\)/) });
    expect(await ap.moveAppointment(auth, move(id, new Date("2032-03-16T08:00:00Z"), 30, b, true))).toEqual({ ok: true });
  });

  it("abgerechnet, abgesagt: nicht verschiebbar; ungültige Angaben abgelehnt", async () => {
    const org = await f.org();
    const a = await member(org);
    const auth = authOf(org, a);
    const billed = await appt(org, a, new Date("2032-03-23T08:00:00Z"));
    await f.asOrg(org, async (c) => {
      const inv = (await c.query("insert into invoices (organization_id, status) values ($1,'draft') returning id", [org])).rows[0].id;
      await c.query("insert into invoice_lines (organization_id, invoice_id, appointment_id, description, unit_price_cents, total_cents, vat_rate, position) values ($1,$2,$3,'Behandlung',4500,4500,0,1)", [org, inv, billed]);
      await c.query("update invoices set status='issued', number='T-DND-1', issued_at=current_date, due_at=current_date + 14, total_cents=4500, net_cents=4500 where id=$1", [inv]);
    });
    expect(await ap.billedAppointmentIds(auth, [billed])).toEqual(new Set([billed]));
    expect(await ap.moveAppointment(auth, move(billed, new Date("2032-03-24T08:00:00Z"), 30, a))).toMatchObject({ ok: false, error: expect.stringMatching(/abgerechnet/) });
    const cancelled = await appt(org, a, new Date("2032-03-23T10:00:00Z"), 30, "cancelled");
    expect(await ap.moveAppointment(auth, move(cancelled, new Date("2032-03-24T10:00:00Z"), 30, a))).toMatchObject({ ok: false, error: expect.stringMatching(/Abgesagte/) });
    expect(await ap.billedAppointmentIds(auth, [cancelled])).toEqual(new Set());
    // ungültig: Datum, Dauer, IDs
    const ok = await appt(org, a, new Date("2032-03-23T12:00:00Z"));
    expect(await ap.moveAppointment(auth, { ...move(ok, new Date("2032-03-24T12:00:00Z"), 30, a), startsAt: "morgen" })).toMatchObject({ ok: false });
    expect(await ap.moveAppointment(auth, move(ok, new Date("2032-03-24T12:00:00Z"), 600, a))).toMatchObject({ ok: false, error: expect.stringMatching(/Dauer/) });
    expect(await ap.moveAppointment(auth, { ...move(ok, new Date("2032-03-24T12:00:00Z"), 30, a), id: "x" })).toMatchObject({ ok: false });
    expect(await ap.moveAppointment(auth, null)).toMatchObject({ ok: false });
  });

  it("fremde Praxis: Termin nicht gefunden, nichts geändert; ohne appointments.write: verboten", async () => {
    const orgA = await f.org();
    const orgB = await f.org();
    const a = await member(orgA);
    const b = await member(orgB);
    const start = new Date("2032-03-30T08:00:00Z");
    const id = await appt(orgA, a, start);
    expect(await ap.moveAppointment(authOf(orgB, b), move(id, new Date("2032-03-31T08:00:00Z"), 30, b))).toMatchObject({ ok: false, error: "Termin nicht gefunden." });
    // fremde Behandler:in in der eigenen Praxis als Ziel
    expect(await ap.moveAppointment(authOf(orgA, a), move(id, new Date("2032-03-31T08:00:00Z"), 30, b))).toMatchObject({ ok: false, error: expect.stringMatching(/Behandler:in nicht gefunden/) });
    const readOnly = authOf(orgA, a, { can: (p) => p.endsWith(".read") });
    await expect(ap.moveAppointment(readOnly, move(id, new Date("2032-03-31T08:00:00Z"), 30, a))).rejects.toThrow(/Berechtigung/);
    expect((await row(orgA, id)).starts_at).toEqual(start);
  });

  it("Kalenderfarbe: eigene Farbe ja, andere nur mit Teamverwaltung, nie im Support-Modus", async () => {
    const org = await f.org();
    const owner = await member(org, "owner");
    const ther = await member(org);
    const reception = await member(org, "reception");
    const colorOf = async (u: string) => (await f.pool.query("select color from memberships where organization_id = $1 and user_id = $2", [org, u])).rows[0].color;

    // Standard: automatisch nach Eintritt
    const auto = await colors.teamColors(authOf(org, owner));
    expect([auto.get(owner), auto.get(ther)]).toEqual(["teal", "blue"]);

    const self = authOf(org, ther, { can: (p) => p !== "users.manage" });
    expect(await colors.setTherapistColor(self, ther, "rose")).toEqual({ ok: true });
    expect(await colorOf(ther)).toBe("rose");
    await expect(colors.setTherapistColor(self, owner, "green")).rejects.toThrow(/Berechtigung/);
    expect(await colorOf(owner)).toBeNull();

    const admin = authOf(org, owner);
    expect(await colors.setTherapistColor(admin, owner, "green")).toEqual({ ok: true });
    expect(await colors.setTherapistColor(admin, ther, null)).toEqual({ ok: true }); // zurück auf automatisch
    expect(await colorOf(ther)).toBeNull();
    expect((await colors.teamColors(admin)).get(ther)).toBe("teal"); // nächste freie (green ist vergeben)
    expect(await colors.setTherapistColor(admin, ther, "#ff0000")).toMatchObject({ ok: false, error: "Unbekannte Farbe." });
    // Empfang hat keine Kalenderspalte; fremde Praxis wirkt nicht
    expect(await colors.setTherapistColor(admin, reception, "blue")).toMatchObject({ ok: false });
    const other = await f.org();
    const stranger = await member(other, "owner");
    expect(await colors.setTherapistColor(authOf(other, stranger), ther, "cyan")).toMatchObject({ ok: false });
    expect(await colorOf(ther)).toBeNull();
    await expect(colors.setTherapistColor(authOf(org, owner, { support: { scope: "write" } }), owner, "blue")).rejects.toThrow();
    expect(await colorOf(owner)).toBe("green");
    const log = await f.asOrg(org, (c) => c.query("select count(*)::int n from audit_log where organization_id = $1 and action = 'member.calendar_color'", [org]));
    expect(log.rows[0].n).toBe(3);
  });
});
