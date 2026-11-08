/** KIM-Posteingang: Import mit Dedupe über Message-ID, nie automatische Zuordnung, Vorschläge (erfundene Daten). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { KimMock } from "@/integrations/kim/kim";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("KIM-Abruf (DB)", () => {
  const f = fixtures(TEST_DB!);
  let kim: typeof import("./kim");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    kim = await import("./kim");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const kimRows = (org: string) =>
    f.asOrg(org, async (c) => (await c.query("select external_id, patient_id, subject, body from messages where organization_id = $1 and channel = 'kim' order by received_at", [org])).rows);

  it("importiert Beispielnachrichten genau einmal – auch bei wiederholtem und parallelem Abruf", async () => {
    const org = await f.org();
    // Person mit gleichem Namen wie in der Beispielnachricht: wird trotzdem NICHT automatisch zugeordnet
    await f.patient(org, { lastName: "Musterfrau", firstName: "Erika" });
    const first = await kim.syncKimInbox(org, { adapter: new KimMock() });
    expect(first).toMatchObject({ fetched: 2, imported: 2, duplicates: 0, mock: true });
    const again = await kim.syncKimInbox(org, { adapter: new KimMock() });
    expect(again).toMatchObject({ imported: 0, duplicates: 2 });
    const parallel = await Promise.all([1, 2, 3].map(() => kim.syncKimInbox(org, { adapter: new KimMock() })));
    expect(parallel.every((r) => "imported" in r && r.imported === 0)).toBe(true);

    const rows = await kimRows(org);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.patient_id === null)).toBe(true);
    expect(rows[0].subject).toBe("[eArztbrief] Arztbrief: Erika Musterfrau, geb. 01.02.1950");
    expect(rows[0].body).toContain("Arztbrief_Musterfrau.pdf");
  });

  it("Dedupe gilt je Praxis; gleiche Message-ID in fremder Praxis wird separat importiert", async () => {
    const a = await f.org();
    const b = await f.org();
    await kim.storeKimMessages(a, await new KimMock().fetchInbox());
    const res = await kim.storeKimMessages(b, await new KimMock().fetchInbox());
    expect(res).toEqual({ imported: 2, duplicates: 0 });
    // doppelte ID innerhalb eines Abrufs
    const [m] = await new KimMock().fetchInbox({ limit: 1 });
    const c = await f.org();
    expect(await kim.storeKimMessages(c, [m, { ...m }])).toEqual({ imported: 1, duplicates: 1 });
  });

  it("Zuordnungsvorschläge über KVNR bzw. Name + Geburtsdatum", async () => {
    const org = await f.org();
    const p = await f.patient(org, { lastName: "Musterfrau", firstName: "Erika" });
    await f.asOrg(org, (c) => c.query("update patients set insurance_number = 'A123456780', birth_date = '1950-02-01' where id = $1", [p]));
    await f.patient(org, { lastName: "Musterfrau", firstName: "Anna" });
    const [msg] = await new KimMock().fetchInbox({ limit: 1 });
    const s = await kim.kimPatientSuggestions(org, { subject: msg.subject, body: msg.text });
    expect(s[0].patient.id).toBe(p);
    expect(s[0].reasons).toContain("KVNR");
    expect(s.map((x) => x.patient.id)).toHaveLength(1);
  });

  it("ohne KIM-Verbindung (und ohne Testmodus) keine Abfrage", async () => {
    const org = await f.org();
    const prev = process.env.INTEGRATIONS_MODE;
    delete process.env.INTEGRATIONS_MODE;
    try {
      expect(await kim.syncKimInbox(org)).toEqual({ error: expect.stringMatching(/nicht eingerichtet/) });
    } finally {
      if (prev !== undefined) process.env.INTEGRATIONS_MODE = prev;
    }
  });
});
