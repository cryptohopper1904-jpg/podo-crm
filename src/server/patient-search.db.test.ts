/**
 * Live-Patientensuche gegen eine echte DB (RLS aktiv, erfundene Daten):
 * Treffer, Mandantentrennung, Rechte, archivierte/gelöschte ausgeblendet, Verstorbene gekennzeichnet,
 * „Meinten Sie“ bei Tippfehlern, mehrteilige Namen in der Patientenliste.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { AuthContext } from "@/lib/auth/session";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Live-Patientensuche (DB)", () => {
  const f = fixtures(TEST_DB!);
  let mod: typeof import("./patient-search");
  let pts: typeof import("./patients");
  let orgA: string;
  let orgB: string;
  let user: string;
  const ids: Record<string, string> = {};

  const auth = (org: string, perms: string[] = ["patients.read"]) =>
    ({ role: "staff", support: null, organization: { id: org }, user: { id: user }, can: (p: string) => perms.includes(p) }) as unknown as AuthContext;
  const q = (org: string, sql: string, params: unknown[]) => f.asOrg(org, (c) => c.query(sql, params));

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    mod = await import("./patient-search");
    pts = await import("./patients");
    orgA = await f.org();
    orgB = await f.org();
    user = await f.user();
    ids.schmidt = await f.patient(orgA, { lastName: "Schmidt", firstName: "Hans" });
    ids.schmitz = await f.patient(orgA, { lastName: "Schmitz", firstName: "Gerda" });
    ids.musterfrau = await f.patient(orgA, { lastName: "Musterfrau", firstName: "Erika" });
    ids.archived = await f.patient(orgA, { lastName: "Schmiedel", firstName: "Archiv" });
    ids.erased = await f.patient(orgA, { lastName: "Schmidtke", firstName: "Geloescht" });
    ids.deceased = await f.patient(orgA, { lastName: "Wagner", firstName: "Paula" });
    ids.foreign = await f.patient(orgB, { lastName: "Schmidt", firstName: "Fremd" });
    await q(orgA, "update patients set birth_date = '1950-03-12', city = 'Musterstadt' where id = $1", [ids.musterfrau]);
    await q(orgA, "update patients set archived_at = now() where id = $1", [ids.archived]);
    await q(orgA, "update patients set archived_at = now(), contact_erased_at = now() where id = $1", [ids.erased]);
    await q(orgA, `update patients set extra = '{"deceased": {"at": "2026-01-01"}}'::jsonb where id = $1`, [ids.deceased]);
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("direkte Treffer nur aus der eigenen Praxis, ohne archivierte/gelöschte", async () => {
    const r = await mod.suggestPatients(auth(orgA), "Schmi");
    expect(r.hits.map((h) => h.id).sort()).toEqual([ids.schmidt, ids.schmitz].sort());
    expect(r.hits.some((h) => h.id === ids.foreign || h.id === ids.archived || h.id === ids.erased)).toBe(false);
    // Antwort ohne Kontakt-/Zusatzdaten
    expect(Object.keys(r.hits[0]).sort()).toEqual(["birthDate", "city", "deceased", "firstName", "id", "lastName", "number"]);

    const b = await mod.suggestPatients(auth(orgB), "Schmi");
    expect(b.hits.map((h) => h.id)).toEqual([ids.foreign]);
  });

  it("Nachname-Präfix zuerst, mehrteilige Namen, Geburtsdatum, Nummer", async () => {
    const r = await mod.suggestPatients(auth(orgA), "Erika Musterfrau");
    expect(r.hits.map((h) => h.id)).toEqual([ids.musterfrau]);
    expect(r.hits[0]).toMatchObject({ birthDate: "1950-03-12", city: "Musterstadt", deceased: false });
    expect((await mod.suggestPatients(auth(orgA), "Musterfrau, Erika")).hits.map((h) => h.id)).toEqual([ids.musterfrau]);
    expect((await mod.suggestPatients(auth(orgA), "12.03.1950")).hits.map((h) => h.id)).toEqual([ids.musterfrau]);
    const nr = (await f.asOrg(orgA, (c) => c.query("select number from patients where id = $1", [ids.musterfrau]))).rows[0].number;
    expect((await mod.suggestPatients(auth(orgA), String(nr))).hits.map((h) => h.id)).toContain(ids.musterfrau);
    // Platzhalter im Suchtext werden wörtlich genommen
    expect((await mod.suggestPatients(auth(orgA), "S%t")).hits).toEqual([]);
  });

  it("Verstorbene erscheinen wie in der Liste, gekennzeichnet", async () => {
    const r = await mod.suggestPatients(auth(orgA), "Wagner");
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]).toMatchObject({ id: ids.deceased, deceased: true });
  });

  it("„Meinten Sie“ bei Tippfehlern – nur eigene Praxis, keine archivierten", async () => {
    const r = await mod.suggestPatients(auth(orgA), "Schmitt");
    expect(r.hits).toEqual([]);
    expect(r.didYouMean?.query).toBe("Schmidt");
    const fuzzy = r.didYouMean!.patients.map((p) => p.id);
    expect(fuzzy[0]).toBe(ids.schmidt);
    expect(fuzzy).toContain(ids.schmitz);
    expect(fuzzy).not.toContain(ids.foreign);
    expect(fuzzy).not.toContain(ids.archived);
    expect(fuzzy).not.toContain(ids.erased);

    const full = await mod.suggestPatients(auth(orgA), "Ericka Mustrefrau");
    expect(full.didYouMean).toMatchObject({ query: "Erika Musterfrau" });
    expect(full.didYouMean!.patients[0].id).toBe(ids.musterfrau);

    // genug direkte Treffer bzw. nichts Ähnliches → kein „Meinten Sie“
    expect((await mod.suggestPatients(auth(orgA), "Qwxyz")).didYouMean).toBeNull();
  });

  it("ohne patients.read: verweigert", async () => {
    await expect(mod.suggestPatients(auth(orgA, ["appointments.read"]), "Schmidt")).rejects.toBeInstanceOf(mod.SuggestForbiddenError);
  });

  it("Patientenliste: gleiche Suchbedingung (mehrteilig, wie bisher einteilig)", async () => {
    const list = await pts.listPatients(auth(orgA), { q: "Erika Musterfrau" });
    expect(list.map((p) => p.id)).toEqual([ids.musterfrau]);
    const single = await pts.listPatients(auth(orgA), { q: "Musterstadt" });
    expect(single.map((p) => p.id)).toEqual([ids.musterfrau]);
  });
});
