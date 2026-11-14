/**
 * KI-Antwortvorschläge (AppSec M-1, Recht H-88-4) und Zuordnung von Online-Anfragen (Code 🟡1, AppSec L-a):
 * Schalter je Praxis (Standard aus), was an den KI-Dienst geht (Online-Anfrage ohne Name/Kontakt/Notiz/Leistung,
 * keine internen Hinweise, KIM erst nach Zuordnung), Zuordnung nimmt den Termin der Anfrage mit, AVV-Zustimmung.
 * Erfundene Daten.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const authState = vi.hoisted(() => ({ org: "", user: "", role: "owner", support: null as null | { id: string } }));
vi.mock("@/lib/auth/session", () => ({
  requireAuth: async () => ({
    organization: { id: authState.org, state: "BB", name: "Testpraxis" },
    user: { id: authState.user },
    role: authState.role,
    support: authState.support,
    can: () => true,
  }),
  requestMeta: async () => ({ ip: "198.51.100.9" }),
}));
// KI-Dienst: aufzeichnen, was gesendet würde (kein Netz)
const llm = vi.hoisted(() => ({ sent: [] as { text: string; knownNames: string[] }[] }));
vi.mock("@/server/integrations", async (orig) => ({
  ...(await orig<typeof import("@/server/integrations")>()),
  adapterFor: async (_org: string, provider: string) => {
    if (provider !== "llm") throw new Error(`unerwartet: ${provider}`);
    return {
      isMock: true,
      suggestReply: async (text: string, ctx: { knownNames?: string[] }) => {
        llm.sent.push({ text, knownNames: ctx.knownNames ?? [] });
        return "Guten Tag [NAME_1], gern bestätigen wir Ihnen den Termin.";
      },
    };
  },
}));

import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const AI_ON = { enabled: true, provider: "Beispiel-KI", country: "Frankreich", avvConfirmed: true, confidentialityConfirmed: true };

(TEST_DB ? describe : describe.skip)("KI-Antwortvorschläge und Online-Anfragen (DB)", () => {
  const f = fixtures(TEST_DB!);
  let inbox: typeof import("@/app/(app)/posteingang/actions");
  let settings: typeof import("@/app/(app)/einstellungen/actions");
  let booking: typeof import("@/app/buchen/[slug]/actions");
  let pb: typeof import("./portal-booking");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    inbox = await import("@/app/(app)/posteingang/actions");
    settings = await import("@/app/(app)/einstellungen/actions");
    booking = await import("@/app/buchen/[slug]/actions");
    pb = await import("./portal-booking");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  async function practice(extra: Record<string, unknown> = {}) {
    const org = await f.org({ settings: { onlineBooking: { enabled: true }, imprint: { owner: "Petra Test", profession: "Podologin" }, ...extra } });
    await f.pool.query("update organizations set state = 'BB', street = 'Teststraße 1', zip = '16540', city = 'Hohen Neuendorf', email = 'praxis@example.org' where id = $1", [org]);
    const user = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'owner')", [org, user]);
    const service = await f.asOrg(org, async (c) => {
      for (let wd = 1; wd <= 5; wd++) await c.query("insert into working_hours (organization_id, user_id, weekday, start_time, end_time) values ($1,$2,$3,'09:00','12:00')", [org, user, wd]);
      return (await c.query("insert into services (organization_id, code, name, price_cents, duration_min, category) values ($1,'NKS','Nagelkorrekturspange',4000,30,'cosmetic') returning id", [org])).rows[0].id as string;
    });
    Object.assign(authState, { org, user, role: "owner", support: null });
    llm.sent = [];
    return { org, user, service };
  }

  /** echte /buchen-Anfrage (Name, Telefon, E-Mail, Notiz mit Gesundheitsangabe) */
  async function onlineRequest(p: { org: string; service: string }, note = "Diabetiker, eingewachsener Nagel links") {
    const [{ slug }] = (await f.pool.query("select slug from organizations where id = $1", [p.org])).rows;
    const day = (await pb.publicBookingOptions(p.org))!.days.find((d) => (d.slots[30] ?? []).length)!;
    const r = await booking.bookAction(
      undefined,
      fd({ slug, serviceId: p.service, date: day.date, time: day.slots[30][0], firstName: "Olga", lastName: "Testfrau", phone: "0151 7654321", email: "olga.t@example.org", note, noShow: "on" }),
    );
    expect(r?.error).toBeUndefined();
    const [m] = (await f.asOrg(p.org, (c) => c.query("select id, thread_key from messages where organization_id = $1 and thread_key like 'online-request:%' order by received_at desc limit 1", [p.org]))).rows;
    return { messageId: m.id as string, appointmentId: (m.thread_key as string).slice("online-request:".length) };
  }

  const message = async (org: string, o: Record<string, unknown>) =>
    (
      await f.asOrg(org, (c) =>
        c.query(
          "insert into messages (organization_id, patient_id, channel, direction, from_address, subject, body, thread_key, status) values ($1,$2,$3,'inbound',$4,$5,$6,$7,'new') returning id",
          [org, o.patientId ?? null, o.channel ?? "email", o.from ?? null, o.subject ?? null, o.body, o.threadKey ?? null],
        ),
      )
    ).rows[0].id as string;

  it("Schalter aus (Standard): kein Versand an den KI-Dienst, klare Meldung", async () => {
    const p = await practice();
    const { messageId } = await onlineRequest(p);
    const r = await inbox.suggestReplyAction(undefined, fd({ id: messageId }));
    expect(r?.error).toMatch(/KI-Antwortvorschläge sind ausgeschaltet/);
    expect(llm.sent).toHaveLength(0);
  });

  it("Online-Anfrage: Name, Telefon, E-Mail, Notiz und Leistung verlassen den Server nicht; Vorschlag enthält den Namen wieder", async () => {
    const p = await practice({ aiReplies: AI_ON });
    const { messageId } = await onlineRequest(p);
    expect(await inbox.suggestReplyAction(undefined, fd({ id: messageId }))).toEqual({ ok: "Vorschlag erstellt – bitte prüfen und anpassen." });
    expect(llm.sent).toHaveLength(1);
    const sent = llm.sent[0].text;
    for (const secret of ["Olga", "Testfrau", "0151", "7654321", "olga.t@example.org", "Diabetiker", "Nagel", "Nagelkorrekturspange"]) expect(sent, secret).not.toContain(secret);
    expect(sent).toContain("[Notiz entfernt]");
    expect(sent).toContain("[Leistung]");
    expect(sent).toMatch(/Name: \[NAME_\d+\]/);
    const [m] = (await f.asOrg(p.org, (c) => c.query("select ai_suggestion, status from messages where id = $1", [messageId]))).rows;
    expect(m).toEqual({ ai_suggestion: "Guten Tag Olga Testfrau, gern bestätigen wir Ihnen den Termin.", status: "suggested" });
  });

  it("ältere Online-Anfrage ohne meta: Name aus der „Name:“-Zeile, mehrzeilige Notiz entfällt vollständig", async () => {
    const p = await practice({ aiReplies: AI_ON });
    const id = await message(p.org, {
      threadKey: "online-request:7a0c1f5e-2f4b-4c1e-9d3a-6b2a1c0d9e8f",
      from: "0170 1112223",
      channel: "sms",
      body: [
        "Online-Anfrage: Hühneraugenentfernung am 2031-05-06 um 09:30 Uhr.",
        "Name: Hans Peter Altmann",
        "Telefon: 0170 1112223",
        "Ausfallregelung bei der Buchung bestätigt; Datenschutzhinweise verlinkt (2031-05-01T10:00:00.000Z).",
        "Notiz: Bitte Rückruf an Frau Kowalski,",
        "Name: Kowalski – sie ist Diabetikerin",
        "Bitte Patient zuordnen (bestehend oder neu) und Termin bestätigen.",
      ].join("\n"),
    });
    expect((await inbox.suggestReplyAction(undefined, fd({ id })))?.ok).toBeTruthy();
    const sent = llm.sent[0].text;
    for (const secret of ["Hans", "Peter", "Altmann", "Kowalski", "Diabetikerin", "Hühneraugen", "0170"]) expect(sent, secret).not.toContain(secret);
    expect(sent).toContain("[Notiz entfernt]");
  });

  it("E-Mail ohne Zuordnung: Namen der zur Absenderadresse passenden Akte werden geschwärzt (ohne zuzuordnen)", async () => {
    const p = await practice({ aiReplies: AI_ON });
    await f.patient(p.org, { firstName: "Erika", lastName: "Beispielmann", email: "erika.b@example.org" });
    const id = await message(p.org, { from: "erika.b@example.org", body: "Guten Tag, hier ist Erika Beispielmann. Kann ich meinen Termin verschieben?" });
    expect((await inbox.suggestReplyAction(undefined, fd({ id })))?.ok).toBeTruthy();
    expect(llm.sent[0].text).not.toMatch(/Erika|Beispielmann/);
    const [m] = (await f.asOrg(p.org, (c) => c.query("select patient_id from messages where id = $1", [id]))).rows;
    expect(m.patient_id).toBeNull();
  });

  it("keine Vorschläge für interne Hinweise und KI-Telefon-Notizen; KIM erst nach Zuordnung", async () => {
    const p = await practice({ aiReplies: AI_ON });
    const phone = await message(p.org, { channel: "phone", body: "Terminwunsch per KI-Telefon\nName laut Anrufer: Max Muster" });
    const none = await message(p.org, { channel: "none", body: "Warteliste: Angebot verschickt an: Max Muster" });
    const kim = await message(p.org, { channel: "kim", from: "praxis@arzt.kim.telematik", body: "Arztbrief zu Frau Kunz" });
    expect((await inbox.suggestReplyAction(undefined, fd({ id: phone })))?.error).toMatch(/keine KI-Antwortvorschläge/);
    expect((await inbox.suggestReplyAction(undefined, fd({ id: none })))?.error).toMatch(/keine KI-Antwortvorschläge/);
    expect((await inbox.suggestReplyAction(undefined, fd({ id: kim })))?.error).toMatch(/zuerst einer Person zuordnen/);
    expect(llm.sent).toHaveLength(0);
    const patient = await f.patient(p.org, { firstName: "Gerda", lastName: "Kunz" });
    await f.asOrg(p.org, (c) => c.query("update messages set patient_id = $2 where id = $1", [kim, patient]));
    expect((await inbox.suggestReplyAction(undefined, fd({ id: kim })))?.ok).toBeTruthy();
    expect(llm.sent[0].text).not.toContain("Kunz");
  });

  it("Zuordnung einer Online-Anfrage ordnet den vorgemerkten Termin derselben Praxis mit zu (nur, wenn noch ohne Person)", async () => {
    const p = await practice();
    const { messageId, appointmentId } = await onlineRequest(p);
    const patient = await f.patient(p.org, { lastName: "Testfrau", firstName: "Olga" });
    const [{ number }] = (await f.asOrg(p.org, (c) => c.query("select number from patients where id = $1", [patient]))).rows;
    expect(await inbox.matchPatientAction(undefined, fd({ id: messageId, patientNumber: String(number) }))).toEqual({ ok: "Zugeordnet." });
    const appt = (await f.asOrg(p.org, (c) => c.query("select patient_id from appointments where id = $1", [appointmentId]))).rows[0];
    expect(appt.patient_id).toBe(patient);
    const audit = (await f.asOrg(p.org, (c) => c.query("select meta from audit_log where organization_id = $1 and action = 'message.match'", [p.org]))).rows;
    expect(audit[0].meta).toEqual({ patientId: patient, appointmentId });

    // Termin schon einer anderen Person zugeordnet → bleibt unverändert
    const second = await onlineRequest(p);
    const other = await f.patient(p.org, { lastName: "Andere" });
    await f.asOrg(p.org, (c) => c.query("update appointments set patient_id = $2 where id = $1", [second.appointmentId, other]));
    await inbox.matchPatientAction(undefined, fd({ id: second.messageId, patientNumber: String(number) }));
    expect((await f.asOrg(p.org, (c) => c.query("select patient_id from appointments where id = $1", [second.appointmentId]))).rows[0].patient_id).toBe(other);
    // zugeordnete Anfrage fällt nicht mehr unter die automatische Löschung
    await f.asOrg(p.org, (c) => c.query("update appointments set created_at = now() - interval '7 months' where id = $1", [appointmentId]));
    const { purgeStaleOnlineRequests } = await import("./online-request-retention");
    await purgeStaleOnlineRequests(p.org);
    expect((await f.asOrg(p.org, (c) => c.query("select count(*)::int n from appointments where id = $1", [appointmentId]))).rows[0].n).toBe(1);
  });

  it("Schalter: Einschalten nur mit Anbieter, Land und beiden Bestätigungen; nicht per Support-Freigabe; Audit", async () => {
    const p = await practice();
    const aiOf = async () => (await f.pool.query("select settings->'aiReplies' a from organizations where id = $1", [p.org])).rows[0].a;
    expect((await settings.saveAiRepliesAction(undefined, fd({ enabled: "on", provider: "Beispiel-KI", country: "Frankreich", avvConfirmed: "on" })))?.error).toMatch(/beide Punkte/);
    expect((await settings.saveAiRepliesAction(undefined, fd({ enabled: "on", avvConfirmed: "on", confidentialityConfirmed: "on" })))?.error).toMatch(/Anbieter und Land/);
    expect(await aiOf()).toBeNull();
    authState.support = { id: "s" };
    expect((await settings.saveAiRepliesAction(undefined, fd({ enabled: "on", provider: "X", country: "Y", avvConfirmed: "on", confidentialityConfirmed: "on" })))?.error).toMatch(/Nur die Praxis selbst/);
    authState.support = null;
    expect((await settings.saveAiRepliesAction(undefined, fd({ enabled: "on", provider: " Beispiel-KI ", country: "Frankreich", avvConfirmed: "on", confidentialityConfirmed: "on" })))?.ok).toMatch(/eingeschaltet/);
    expect(await aiOf()).toMatchObject({ enabled: true, provider: "Beispiel-KI", country: "Frankreich", avvConfirmed: true, confidentialityConfirmed: true, by: p.user });
    expect((await settings.saveAiRepliesAction(undefined, fd({})))?.ok).toMatch(/ausgeschaltet/);
    expect(await aiOf()).toMatchObject({ enabled: false, provider: "Beispiel-KI", country: "Frankreich" });
    const actions = (await f.asOrg(p.org, (c) => c.query("select action from audit_log where organization_id = $1 and action like 'settings.ai_replies.%' order by id", [p.org]))).rows.map((r) => r.action);
    expect(actions).toEqual(["settings.ai_replies.on", "settings.ai_replies.off"]);
  });

  it("AVV nachträglich akzeptieren: nur Inhaber:in, speichert Version, Zeitpunkt, Person und die frühere Zustimmung", async () => {
    const p = await practice({ legalAcceptance: { agb: "0.3", avv: "0.2", version: "agb-0.3+avv-0.2", at: "2026-11-01T00:00:00.000Z", by: "alt" } });
    authState.role = "therapist";
    expect((await settings.acceptAvvAction(undefined, fd({})))?.error).toMatch(/Inhaberin bzw. der Inhaber/);
    authState.role = "owner";
    authState.support = { id: "s" };
    expect((await settings.acceptAvvAction(undefined, fd({})))?.error).toMatch(/Inhaberin bzw. der Inhaber/);
    authState.support = null;
    expect((await settings.acceptAvvAction(undefined, fd({})))?.ok).toBe("AVV Version 0.3 akzeptiert.");
    const { legalAcceptance: a } = (await f.pool.query("select settings from organizations where id = $1", [p.org])).rows[0].settings;
    expect(a).toMatchObject({ agb: "0.3", avv: "0.3", version: "agb-0.3+avv-0.3", by: p.user, previous: { avv: "0.2", by: "alt" } });
    expect(Date.now() - Date.parse(a.at)).toBeLessThan(60_000);
    const { avvAcceptedAtLeast } = await import("@/lib/legal");
    expect(avvAcceptedAtLeast((await f.pool.query("select settings from organizations where id = $1", [p.org])).rows[0].settings, "0.3")).toBe(true);
    const audit = (await f.asOrg(p.org, (c) => c.query("select meta, user_id from audit_log where organization_id = $1 and action = 'legal.avv_accepted'", [p.org]))).rows;
    expect(audit).toEqual([{ meta: { avv: "0.3", previous: "0.2" }, user_id: p.user }]);
  });
});
