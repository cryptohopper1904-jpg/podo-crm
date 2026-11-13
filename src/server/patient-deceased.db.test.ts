/**
 * „Patient:in verstorben“ gegen eine echte DB (RLS aktiv, erfundene Daten):
 * Markieren/Zurücknehmen mit Audit, Absage künftiger Termine nur nach Bestätigung,
 * Ausschluss aus Erinnerungen/Rückholung, keine neuen künftigen Termine.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { MessagingPort, OutboundMessage } from "@/integrations/types";
import type { AuthContext } from "@/lib/auth/session";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Patient:in verstorben (DB)", () => {
  const f = fixtures(TEST_DB!);
  let mod: typeof import("./patient-deceased");
  let rem: typeof import("./reminders");
  let ap: typeof import("./appointments");
  let core: typeof import("./portal-core");
  let ana: typeof import("./anamnesis");
  const sent: OutboundMessage[] = [];
  const port: MessagingPort = {
    provider: "sms",
    isMock: true,
    async send(m) {
      sent.push(m);
      return { externalId: `x${sent.length}` };
    },
    parseInbound: () => [],
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    mod = await import("./patient-deceased");
    rem = await import("./reminders");
    ap = await import("./appointments");
    core = await import("./portal-core");
    ana = await import("./anamnesis");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const auth = (org: string, user: string, perms: string[] = ["patients.read", "patients.write"]) =>
    ({ role: "staff", support: null, organization: { id: org }, user: { id: user }, can: (p: string) => perms.includes(p) }) as unknown as AuthContext;
  const appt = (org: string, patient: string, start: Date, status = "planned") =>
    f.asOrg(org, async (c) =>
      (
        await c.query("insert into appointments (organization_id, patient_id, starts_at, ends_at, status) values ($1,$2,$3,$4,$5) returning id", [
          org,
          patient,
          start,
          new Date(start.getTime() + 30 * 60_000),
          status,
        ])
      ).rows[0].id as string,
    );
  const q = <T = Record<string, unknown>>(org: string, sql: string, params: unknown[]) => f.asOrg(org, async (c) => (await c.query(sql, params)).rows as T[]);

  it("markieren: Termine nur nach Bestätigung absagen, Warteliste/Links erledigen, Audit; Zurücknehmen protokolliert", async () => {
    const org = await f.org();
    const user = await f.user();
    const p = await f.patient(org, { lastName: "Verstorben" });
    const future = await appt(org, p, new Date(Date.now() + 5 * 86400_000));
    const past = await appt(org, p, new Date(Date.now() - 20 * 86400_000), "done");
    await q(org, "insert into waitlist (organization_id, patient_id) values ($1,$2)", [org, p]);
    await q(org, "insert into patient_links (organization_id, patient_id, purpose, token_hash, expires_at) values ($1,$2,'portal',$3, now() + interval '30 days')", [org, p, `h-${p}`]);

    // ohne Recht: verboten
    await expect(mod.markPatientDeceased(auth(org, user, ["patients.read"]), p, { cancelFuture: true })).rejects.toThrow(/Berechtigung/);

    // künftiger Termin ohne Bestätigung → nichts geändert
    const r0 = await mod.markPatientDeceased(auth(org, user), p, { date: "", cancelFuture: false });
    expect(r0).toMatchObject({ ok: false, futureAppointments: 1 });
    expect((await mod.deceasedStatus(auth(org, user), p))?.info).toBeNull();

    // Sterbedatum in der Zukunft → abgelehnt
    expect((await mod.markPatientDeceased(auth(org, user), p, { date: "01.01.2099", cancelFuture: true })).ok).toBe(false);

    const deathIso = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10);
    const deathDe = deathIso.split("-").reverse().join(".");
    const r = await mod.markPatientDeceased(auth(org, user), p, { date: deathDe, cancelFuture: true });
    expect(r).toMatchObject({ ok: true, cancelled: [future], feedRemaining: 0, waitlistResolved: 1, linksRevoked: 1 });
    const st = await mod.deceasedStatus(auth(org, user), p);
    expect(st?.info).toMatchObject({ date: deathIso, markedBy: user });
    expect(st?.futureOwn).toBe(0);

    const statuses = await q<{ id: string; status: string }>(org, "select id, status from appointments where patient_id = $1", [p]);
    expect(statuses.find((a) => a.id === future)?.status).toBe("cancelled");
    expect(statuses.find((a) => a.id === past)?.status).toBe("done"); // Vergangenes bleibt unverändert
    expect((await q<{ n: number }>(org, "select count(*)::int n from waitlist where patient_id = $1 and resolved_at is null", [p]))[0].n).toBe(0);
    expect((await q<{ n: number }>(org, "select count(*)::int n from patient_links where patient_id = $1 and revoked_at is null", [p]))[0].n).toBe(0);
    // Akte bleibt erhalten, nicht archiviert
    expect((await q<{ archived_at: Date | null }>(org, "select archived_at from patients where id = $1", [p]))[0].archived_at).toBeNull();

    // doppelt markieren → Fehler
    expect((await mod.markPatientDeceased(auth(org, user), p, { cancelFuture: true })).ok).toBe(false);

    const marks = await q<{ meta: Record<string, unknown>; user_id: string }>(org, "select meta, user_id from audit_log where action = 'patient.deceased_mark' and entity_id = $1", [p]);
    expect(marks).toHaveLength(1);
    expect(marks[0].user_id).toBe(user);
    expect(marks[0].meta).toMatchObject({ date: deathIso, cancelledAppointments: 1, waitlistResolved: 1, linksRevoked: 1 });
    expect(JSON.stringify(marks[0].meta)).not.toContain("Verstorben");

    // Fehleingabe zurücknehmen
    expect(await mod.undoPatientDeceased(auth(org, user), p, "falsche Akte")).toEqual({ ok: true });
    expect((await mod.deceasedStatus(auth(org, user), p))?.info).toBeNull();
    const extra = (await q<{ extra: Record<string, unknown> }>(org, "select extra from patients where id = $1", [p]))[0].extra;
    expect(extra).not.toHaveProperty("deceased");
    const undo = await q<{ meta: Record<string, unknown> }>(org, "select meta from audit_log where action = 'patient.deceased_undo' and entity_id = $1", [p]);
    expect(undo).toHaveLength(1);
    expect(undo[0].meta).toMatchObject({ previousDate: deathIso, previousMarkedBy: user, reason: "falsche Akte" });
    expect(await mod.undoPatientDeceased(auth(org, user), p)).toEqual({ ok: false, error: "Die Patient:in ist nicht als verstorben markiert." });
  });

  it("Erinnerungen und Rückholung: Verstorbene werden ausgeschlossen, andere weiter angeschrieben", async () => {
    const settings = { reminders: { r24: true, recall: true } };
    const org = await f.org({ settings });
    const user = await f.user();
    const alive = await f.patient(org, { lastName: "Lebt", phoneMobile: "+49 170 4444444" });
    const dead = await f.patient(org, { lastName: "Tot", phoneMobile: "+49 170 5555555" });
    for (const p of [alive, dead]) {
      await f.consent(org, p, "sms_reminders");
      await appt(org, p, new Date(Date.now() - 200 * 86400_000), "done"); // überfällig → Rückholung fällig
    }
    expect((await mod.markPatientDeceased(auth(org, user), dead, { cancelFuture: false })).ok).toBe(true);
    // ein künftiger Termin, der z. B. aus einem Import stammt, bekommt trotzdem keine 24-h-Erinnerung
    await appt(org, dead, new Date(Date.now() + 24 * 3600_000));

    const o = { id: org, name: "Testpraxis Fuß", phone: "030 1234567", settings };
    const before = sent.length;
    const res = await rem.runRemindersForOrg(o, new Date(), { getPort: async () => port });
    expect(res.sent).toBe(1);
    expect(sent.slice(before).map((m) => m.to)).toEqual(["+49 170 4444444"]);
    const log = await rem.reminderLogFor(org);
    expect(log.map((l) => l.log.patientId)).toEqual([alive]);
    expect(log[0].log.kind).toBe("recall");
  });

  it("keine neuen künftigen Termine – vergangene (Abrechnung) bleiben möglich", async () => {
    const org = await f.org();
    const user = await f.user();
    // Behandler:in mit eigenem Kalender (nur Inhaber:in/Podolog:in sind als Behandler:in zulässig)
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'therapist')", [org, user]);
    const p = await f.patient(org);
    expect((await mod.markPatientDeceased(auth(org, user), p, { cancelFuture: false })).ok).toBe(true);
    const input = (start: Date) => ({
      patientId: p, therapistId: user, occurrences: [start], durationMin: 30, source: "phone" as const, title: "Behandlung", notes: null, homeVisit: false, serviceIds: [], allowConflict: false,
    });
    expect(await ap.createInternalAppointments(org, input(new Date(Date.now() + 7 * 86400_000)))).toEqual({ ok: false, deceased: true });
    expect((await ap.createInternalAppointments(org, input(new Date(Date.now() - 7 * 86400_000)))).ok).toBe(true);
  });

  it("Portal- und Anamnese-Link: für Verstorbene abgelehnt, nach Rücknahme wieder möglich", async () => {
    const org = await f.org();
    const user = await f.user();
    const p = await f.patient(org);
    const a = auth(org, user);
    const activeLinks = async () => (await q<{ n: number }>(org, "select count(*)::int n from patient_links where patient_id = $1 and revoked_at is null", [p]))[0].n;

    // vorher gültiger Portal-Link → beim Markieren widerrufen
    await core.createPortalLink(a, p);
    expect(await activeLinks()).toBe(1);
    expect((await mod.markPatientDeceased(a, p, { cancelFuture: false })).ok).toBe(true);
    expect(await activeLinks()).toBe(0);

    await expect(core.createPortalLink(a, p)).rejects.toThrow("Patient:in ist als verstorben markiert.");
    expect(await ana.createAnamnesisLink(a, p)).toEqual({ error: "Die Patient:in ist als verstorben markiert – kein neuer Link möglich." });
    expect(await activeLinks()).toBe(0);

    // Fehleingabe zurückgenommen → Links wieder möglich
    expect((await mod.undoPatientDeceased(a, p)).ok).toBe(true);
    await core.createPortalLink(a, p);
    expect("token" in (await ana.createAnamnesisLink(a, p))).toBe(true);
    expect(await activeLinks()).toBe(2);
  });

  it("Kontaktdaten löschen behält die Markierung „verstorben“", async () => {
    const org = await f.org();
    const user = await f.user();
    const p = await f.patient(org, { email: "x@example.org" });
    await q(org, `update patients set extra = extra || '{"no_reminders": true}'::jsonb where id = $1`, [p]);
    await q(org, "insert into treatment_records (organization_id, patient_id, author_id, treated_at, prev_hash, hash) values ($1,$2,$3, now(), null, 'h')", [org, p, user]);
    expect((await mod.markPatientDeceased(auth(org, user), p, { cancelFuture: false })).ok).toBe(true);
    const del = await import("./patient-deletion");
    const owner = { role: "owner", support: null, organization: { id: org }, user: { id: user }, can: () => true } as unknown as AuthContext;
    await del.erasePatientContact(owner, p);
    const extra = (await q<{ extra: Record<string, unknown> }>(org, "select extra from patients where id = $1", [p]))[0].extra;
    expect(Object.keys(extra)).toEqual(["deceased"]);
  });
});
