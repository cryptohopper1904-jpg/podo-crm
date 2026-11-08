/**
 * KI-Telefon gegen eine echte DB (erfundene Daten): Minutenzählung je Monat und Verhalten bei
 * erschöpftem Kontingent bzw. fehlender Freischaltung (Rückrufbitte statt Buchung).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const NOW = new Date("2030-03-04T05:00:00Z"); // Montag, 06:00 Berlin
const TUE_0900 = "2030-03-05T08:00:00.000Z";

(TEST_DB ? describe : describe.skip)("KI-Telefon: Minutenkontingent (DB)", () => {
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

  async function practice(plan: string, settings: Record<string, unknown> = {}) {
    const org = await f.org({ settings });
    await f.pool.query("update organizations set plan = $2, subscription_status = $3, trial_ends_at = null where id = $1", [org, plan, plan === "trial" ? "trialing" : "active"]);
    await f.asOrg(org, (c) => c.query("insert into services (organization_id, code, name, price_cents, duration_min, category) values ($1,'PK','Podologische Komplexbehandlung',6500,40,'treatment')", [org]));
    return org;
  }
  const call = (org: string, ext: string, startedAt: string, sec: number) =>
    f.asOrg(org, (c) => c.query("insert into voice_calls (organization_id, provider, external_id, started_at, duration_sec, outcome) values ($1,'vapi',$2,$3,$4,'info')", [org, ext, startedAt, sec]));
  const tool = async (org: string, callId: string, name: string, args: Record<string, unknown>) =>
    (await voice.runVoiceToolCalls(org, { vendor: "retell", callId, caller: "+4915100000023", now: () => NOW }, [{ toolCallId: `${callId}-${name}`, tool: name, args }]))[0].result;
  const counts = (org: string) =>
    f.asOrg(org, async (c) => ({
      appts: (await c.query("select count(*)::int as n from appointments where organization_id = $1", [org])).rows[0].n as number,
      msgs: (await c.query("select subject from messages where organization_id = $1 order by received_at", [org])).rows.map((r) => r.subject as string),
      outcome: (await c.query("select outcome from voice_calls where organization_id = $1 and external_id = 'c-q'", [org])).rows[0]?.outcome as string | undefined,
    }));

  it("zählt Sekunden je Kalendermonat (Berlin), ohne Testanrufe", async () => {
    const org = await practice("plus");
    await call(org, "a", "2030-03-01T08:00:00Z", 600);
    await call(org, "b", "2030-03-31T21:30:00Z", 120); // 23:30 Berlin → März
    await call(org, "c", "2030-03-31T22:30:00Z", 999); // 00:30 Berlin → April
    await call(org, "d", "2030-02-28T22:59:00Z", 999); // 23:59 Berlin → Februar
    await call(org, "sim-abcdef123456", "2030-03-02T08:00:00Z", 5000);
    expect(await voice.usedVoiceSeconds(org, "2030-03")).toBe(720);
    const q = await voice.voiceQuotaStatus({ id: org, settings: {}, billing: { plan: "plus", subscriptionStatus: "active", trialEndsAt: null, currentPeriodEnd: null, seats: 1 } }, NOW);
    expect(q).toMatchObject({ blocked: false, usage: { usedMinutes: 12, includedMinutes: 300 } });
  });

  it("Kontingent erschöpft (Testphase 30 Min.): keine Buchung, Rückrufbitte in den Posteingang", async () => {
    const org = await practice("trial");
    await call(org, "x1", "2030-03-02T08:00:00Z", 30 * 60);
    expect(await tool(org, "c-q", "freie_termine", { von: "2030-03-05", leistung: "PK" })).toMatch(/ruft .*zurück/);
    expect(await tool(org, "c-q", "termin_buchen", { vorname: "Erika", nachname: "Muster", leistung: "PK", termin: TUE_0900 })).toMatch(/später/);
    const s = await counts(org);
    expect(s.appts).toBe(0);
    expect(s.msgs).toEqual(["Rückrufbitte (KI-Telefon, Minutenkontingent erschöpft)"]); // je Anruf nur einmal
    expect(s.outcome).toBe("callback");
    // Rückrufbitte geht weiterhin
    expect(await tool(org, "c-q", "rueckruf", { name: "Erika", anliegen: "Termin" })).toMatch(/weitergegeben/);
  });

  it("Tarif ohne KI-Telefon (Praxis ohne Zusatzmodul) → Rückrufbitte; mit Zusatzmodul → Buchung", async () => {
    const without = await practice("praxis");
    expect(await tool(without, "c-q", "freie_termine", { von: "2030-03-05", leistung: "PK" })).toMatch(/ruft .*zurück/);
    expect((await counts(without)).msgs).toHaveLength(1);

    const withAddon = await practice("praxis", { voiceAddon: true });
    expect(await tool(withAddon, "c-q", "freie_termine", { von: "2030-03-05", leistung: "PK" })).toMatch(/termin=/);
    expect(await tool(withAddon, "c-q", "termin_buchen", { vorname: "Erika", nachname: "Muster", leistung: "PK", termin: TUE_0900 })).toMatch(/vorgemerkt/);
    const s = await counts(withAddon);
    expect(s.appts).toBe(1);
    expect(s.outcome).toBe("booked");
  });
});
