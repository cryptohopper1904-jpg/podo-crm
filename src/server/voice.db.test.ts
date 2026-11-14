/**
 * KI-Telefonagent gegen eine echte DB (RLS aktiv, erfundene Daten):
 * Slot-Vorschläge, Buchung ohne Aktenbezug + Posteingang, Absagewunsch ohne Änderung, Ende-Bericht.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const NOW = new Date("2030-03-04T05:00:00Z"); // Montag, 06:00 Berlin
const TUE_0900 = "2030-03-05T08:00:00.000Z"; // Dienstag 09:00 Berlin

(TEST_DB ? describe : describe.skip)("KI-Telefonagent (DB)", () => {
  const f = fixtures(TEST_DB!);
  let voice: typeof import("./voice");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    voice = await import("./voice");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  async function practice(settings: Record<string, unknown> = {}) {
    const org = await f.org({ settings });
    await f.asOrg(org, (c) => c.query("insert into services (organization_id, code, name, price_cents, duration_min, category) values ($1,'PK','Podologische Komplexbehandlung',6500,40,'treatment'), ($1,'HB','Hausbesuch',1500,0,'travel')", [org]));
    return org;
  }
  const ctx = (callId: string, caller: string | null = "+4915100000023") => ({ vendor: "vapi" as const, callId, caller, now: () => NOW });
  const tool = async (org: string, callId: string, name: string, args: Record<string, unknown>) =>
    (await voice.runVoiceToolCalls(org, ctx(callId), [{ toolCallId: `${callId}-${name}`, tool: name, args }]))[0].result;

  it("freie_termine: max. 3 freie Slots, belegte Zeiten ausgespart, nur buchbare Leistungen", async () => {
    const org = await practice();
    await f.asOrg(org, (c) => c.query("insert into appointments (organization_id, starts_at, ends_at, title) values ($1, '2030-03-05T07:00:00Z', '2030-03-05T08:00:00Z', 'belegt')", [org]));
    const r = await tool(org, "c-slots", "freie_termine", { von: "2030-03-05", leistung: "PK" });
    const slots = [...r.matchAll(/termin=(\S+)/g)].map((m) => m[1]);
    expect(slots).toEqual(["2030-03-05T08:00:00.000Z", "2030-03-05T08:30:00.000Z", "2030-03-05T09:00:00.000Z"]);
    expect(r).not.toMatch(/belegt/);
    expect(await tool(org, "c-slots", "freie_termine", { von: "2030-03-05", leistung: "HB" })).toMatch(/nicht gebucht werden/);
  });

  it("freie_termine: Arbeitszeiten und Abwesenheiten des Teams", async () => {
    const org = await practice();
    const u = await f.user();
    await f.asOrg(org, async (c) => {
      await c.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'therapist')", [org, u]);
      await c.query("insert into working_hours (organization_id, user_id, weekday, start_time, end_time) values ($1,$2,2,'10:00','12:00'), ($1,$2,3,'10:00','12:00')", [org, u]);
      await c.query("insert into absences (organization_id, user_id, starts_on, ends_on, kind) values ($1,$2,'2030-03-06','2030-03-06','vacation')", [org, u]);
    });
    const slots = await voice.findVoiceSlots(org, { state: "BB", settings: {} }, { fromIso: "2030-03-05", toIso: "2030-03-07", durationMin: 40, limit: 3, earliest: NOW });
    expect(slots.map((s) => s.toISOString())).toEqual(["2030-03-05T09:00:00.000Z", "2030-03-05T09:30:00.000Z"]);
  });

  it("termin_buchen: Termin OHNE Aktenbezug (auch bei gleichem Namen/Telefon), Quelle voice_agent, Posteingang, Anrufprotokoll", async () => {
    const org = await practice();
    const existing = await f.patient(org, { firstName: "Erika", lastName: "Musterfrau", phoneMobile: "+4915100000023" });
    const r = await tool(org, "call-book", "termin_buchen", { vorname: "Erika", nachname: "Musterfrau", leistung: "PK", termin: TUE_0900 });
    expect(r).toMatch(/vorgemerkt/);
    const s = await f.asOrg(org, async (c) => ({
      appts: (await c.query("select id, patient_id, source, title, status, external_id, starts_at from appointments where organization_id = $1", [org])).rows,
      services: (await c.query("select count(*)::int as n from appointment_services where organization_id = $1", [org])).rows[0].n,
      msgs: (await c.query("select patient_id, channel, subject, body, from_address from messages where organization_id = $1", [org])).rows,
      calls: (await c.query("select caller_masked, outcome, appointment_id from voice_calls where organization_id = $1", [org])).rows,
    }));
    expect(s.appts).toHaveLength(1);
    expect(s.appts[0]).toMatchObject({ patient_id: null, source: "voice_agent", title: "Telefon: Erika M.", status: "planned", external_id: "vapi:call-book" });
    expect(s.appts[0].starts_at.toISOString()).toBe(TUE_0900);
    expect(s.services).toBe(1);
    expect(s.msgs).toHaveLength(1);
    expect(s.msgs[0]).toMatchObject({ patient_id: null, channel: "phone", from_address: "+4915100000023" });
    expect(s.msgs[0].subject).toMatch(/Terminwunsch/);
    expect(s.calls).toEqual([{ caller_masked: "+49 151 ••• 23", outcome: "booked", appointment_id: s.appts[0].id }]);
    expect((await f.asOrg(org, (c) => c.query("select count(*)::int as n from appointments where patient_id = $1", [existing]))).rows[0].n).toBe(0);

    // gleicher Anruf bucht kein zweites Mal; anderer Anruf bekommt den Slot nicht
    expect(await tool(org, "call-book", "termin_buchen", { vorname: "Erika", nachname: "Musterfrau", leistung: "PK", termin: "2030-03-05T12:00:00.000Z" })).toMatch(/bereits ein Terminwunsch/);
    expect(await tool(org, "call-other", "termin_buchen", { vorname: "Max", nachname: "Muster", leistung: "PK", termin: TUE_0900 })).toMatch(/nicht mehr frei/);
    // kein angebotener Slot (außerhalb der Öffnungszeiten)
    expect(await tool(org, "call-night", "termin_buchen", { vorname: "Max", nachname: "Muster", leistung: "PK", termin: "2030-03-05T20:00:00.000Z" })).toMatch(/nicht mehr frei/);
    expect((await f.asOrg(org, (c) => c.query("select count(*)::int as n from appointments where organization_id = $1", [org]))).rows[0].n).toBe(1);
  });

  it("AppSec M-2: nach Löschantrag keine Buchung, kein Posteingang, kein Anrufprotokoll", async () => {
    const org = await practice();
    await f.pool.query("update organizations set deletion_requested_at = now() where id = $1", [org]);
    expect(await tool(org, "call-del", "termin_buchen", { vorname: "Max", nachname: "Muster", leistung: "PK", termin: TUE_0900 })).toBe("Praxis nicht gefunden.");
    expect(await tool(org, "call-del", "rueckruf", { name: "Max Muster", telefon: "+4915100000023", anliegen: "Termin" })).toBe("Praxis nicht gefunden.");
    await voice.processVoiceEvent(org, "vapi", { type: "call_ended", callId: "call-del", from: "+4915100000023", endedReason: "customer-ended-call", durationSec: 60, summary: "x", transcript: null, startedAt: null } as never);
    const n = await f.asOrg(org, async (c) => ({
      appts: (await c.query("select count(*)::int n from appointments where organization_id = $1", [org])).rows[0].n,
      msgs: (await c.query("select count(*)::int n from messages where organization_id = $1", [org])).rows[0].n,
      calls: (await c.query("select count(*)::int n from voice_calls where organization_id = $1", [org])).rows[0].n,
    }));
    expect(n).toEqual({ appts: 0, msgs: 0, calls: 0 });
  });

  it("termin_absagen ändert nichts, legt nur einen Absagewunsch an", async () => {
    const org = await practice();
    const p = await f.patient(org, { phoneMobile: "+4915100000023" });
    await f.asOrg(org, (c) => c.query("insert into appointments (organization_id, patient_id, starts_at, ends_at, status) values ($1,$2,'2030-03-06T08:00:00Z','2030-03-06T08:40:00Z','confirmed')", [org, p]));
    const r = await tool(org, "call-cancel", "termin_absagen", { datum: "2030-03-06" });
    expect(r).toMatch(/weitergegeben/);
    const s = await f.asOrg(org, async (c) => ({
      appt: (await c.query("select status from appointments where patient_id = $1", [p])).rows[0],
      msgs: (await c.query("select subject, patient_id from messages where organization_id = $1", [org])).rows,
      call: (await c.query("select outcome from voice_calls where organization_id = $1", [org])).rows[0],
    }));
    expect(s.appt.status).toBe("confirmed");
    expect(s.msgs).toEqual([{ subject: "Absagewunsch (KI-Telefon)", patient_id: null }]);
    expect(s.call.outcome).toBe("cancelled");
  });

  it("Ende-Bericht: Dauer/Zusammenfassung; Transkript nur mit Einstellung + Ansage; Ausgang bleibt erhalten; RLS", async () => {
    const end = (callId: string, transcript: string) =>
      ({ type: "call_ended", callId, from: "+4915100000023", startedAt: "2030-03-04T05:00:00Z", endedAt: null, durationSec: 95, endedReason: "customer-ended-call", summary: "Terminwunsch aufgenommen.", transcript }) as const;
    const announced = "AI: Sie sprechen mit dem KI-Assistenten der Praxis Test. Dieses Gespräch wird aufgezeichnet.\nUser: Hallo";

    const off = await practice();
    await voice.processVoiceEvent(off, "vapi", end("c-off", announced));
    const on = await practice({ voice: { storeTranscripts: true } });
    await tool(on, "c-on", "rueckruf", { name: "Erika", anliegen: "Rückfrage" });
    await voice.processVoiceEvent(on, "vapi", end("c-on", announced));
    await voice.processVoiceEvent(on, "vapi", end("c-silent", "AI: Sie sprechen mit dem KI-Assistenten der Praxis Test.\nUser: Hallo"));

    const row = async (org: string, id: string) => (await f.asOrg(org, (c) => c.query("select duration_sec, summary, transcript, outcome, caller_masked from voice_calls where organization_id = $1 and external_id = $2", [org, id]))).rows[0];
    expect(await row(off, "c-off")).toMatchObject({ duration_sec: 95, summary: "Terminwunsch aufgenommen.", transcript: null, outcome: "info", caller_masked: "+49 151 ••• 23" });
    expect(await row(on, "c-on")).toMatchObject({ transcript: announced, outcome: "callback" });
    expect((await row(on, "c-silent")).transcript).toBeNull();
    // andere Praxis sieht nichts
    expect((await f.asOrg(off, (c) => c.query("select count(*)::int as n from voice_calls where external_id = 'c-on'"))).rows[0].n).toBe(0);
  });

  it("proposeSlots (rein): je Tag höchstens 2 bei Zeiträumen, frühester Zeitpunkt beachtet", () => {
    const days = ["2030-03-05", "2030-03-06"].map((d) => ({ dateIso: d, ranges: [{ start: "08:00", end: "12:00" }] }));
    const s = voice.proposeSlots({ days, busy: [], durationMin: 30, earliest: new Date("2030-03-05T08:00:00Z"), limit: 3 });
    expect(s.map((x) => x.toISOString())).toEqual(["2030-03-05T08:00:00.000Z", "2030-03-05T08:30:00.000Z", "2030-03-06T07:00:00.000Z"]);
  });
});
