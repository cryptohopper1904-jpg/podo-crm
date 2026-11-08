/** Erinnerungs-Runner gegen PostgreSQL: Dedupe über reminder_log, Einwilligung, Fehlerprotokoll (erfundene Daten). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { MessagingPort, OutboundMessage } from "@/integrations/types";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Erinnerungen (DB)", () => {
  const f = fixtures(TEST_DB!);
  let mod: typeof import("./reminders");
  const sent: OutboundMessage[] = [];
  const port = (fail = false): MessagingPort => ({
    provider: "sms",
    isMock: true,
    async send(m) {
      if (fail) throw new Error("Gateway nicht erreichbar");
      sent.push(m);
      return { externalId: `x${sent.length}` };
    },
    parseInbound: () => [],
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    mod = await import("./reminders");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("versendet je Termin genau einmal (Dedupe) und nur mit Einwilligung", async () => {
    const org = await f.org({ settings: { reminders: { r24: true } } });
    const withConsent = await f.patient(org, { phoneMobile: "+49 170 1111111" });
    const without = await f.patient(org, { lastName: "Ohne", phoneMobile: "+49 170 2222222" });
    await f.consent(org, withConsent, "sms_reminders");
    await f.consent(org, without, "marketing");
    const start = new Date(Date.now() + 24 * 3600_000);
    const end = new Date(start.getTime() + 30 * 60_000);
    await f.asOrg(org, async (c) => {
      for (const p of [withConsent, without]) {
        await c.query("insert into appointments (organization_id, patient_id, starts_at, ends_at, status) values ($1,$2,$3,$4,'planned')", [org, p, start, end]);
      }
    });
    const o = { id: org, name: "Testpraxis Fuß", phone: "030 1234567", settings: { reminders: { r24: true } } };
    const first = await mod.runRemindersForOrg(o, new Date(), { getPort: async () => port() });
    expect(first).toMatchObject({ planned: 1, sent: 1, failed: 0, skipped: 1 });
    expect(sent.at(-1)?.body).toMatch(/^Erinnerung: Ihr Termin bei Testpraxis Fuß am /);

    // zweiter Lauf (z. B. 15 Minuten später, oder parallel) → nichts doppelt
    const [a, b] = await Promise.all([
      mod.runRemindersForOrg(o, new Date(), { getPort: async () => port() }),
      mod.runRemindersForOrg(o, new Date(), { getPort: async () => port() }),
    ]);
    expect(a.sent + b.sent).toBe(0);
    expect(a.duplicates + b.duplicates).toBe(2);

    const log = await mod.reminderLogFor(org);
    expect(log).toHaveLength(1);
    expect(log[0].log).toMatchObject({ kind: "reminder_24h", status: "sent", channel: "sms" });
  });

  it("protokolliert Fehler und versucht nicht erneut", async () => {
    const org = await f.org();
    const p = await f.patient(org, { phoneMobile: "+49 170 3333333" });
    const planned = [{ kind: "recall" as const, dedupeKey: `recall:${p}:2026-11`, patientId: p, appointmentId: null, channel: "sms" as const, to: "+49 170 3333333", subject: "s", body: "b" }];
    const r1 = await mod.sendPlannedReminders(org, planned, { getPort: async () => port(true) });
    expect(r1).toMatchObject({ sent: 0, failed: 1 });
    const r2 = await mod.sendPlannedReminders(org, planned, { getPort: async () => port() });
    expect(r2).toMatchObject({ sent: 0, duplicates: 1 });
    const log = await mod.reminderLogFor(org);
    expect(log[0].log.status).toBe("failed");
    expect(log[0].log.detail).toBe("Error"); // describeError gibt bewusst keine Upstream-Texte weiter
  });
});
