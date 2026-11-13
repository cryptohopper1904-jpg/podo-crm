/**
 * Öffnungszeiten je Wochentag (DB): Speichern/Laden über Einstellungen → Öffnungszeiten und → Website,
 * Verfügbarkeit ohne Arbeitszeiten, Migration 0046 der Altdaten (Website-Zeiten, Mo–Fr-Bereich). Erfundene Daten.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const authState = vi.hoisted(() => ({ org: "", user: "", perms: [] as string[] }));
vi.mock("@/lib/auth/session", () => ({
  requireAuth: async (perm?: string) => {
    if (perm) authState.perms.push(perm);
    return { organization: { id: authState.org, state: "BE" }, user: { id: authState.user }, role: "owner", support: null, can: () => true };
  },
  requestMeta: async () => ({ ip: null }),
}));

import { practiceHours, storedPracticeHours, validateWeek } from "@/lib/opening-hours";
import { websiteOpeningHours } from "@/lib/website";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const h = (weekday: number, from: string, to: string) => ({ weekday, from, to });
const ownerUrlFrom = (url: string) => url.replace(/\/\/[^@]+@/, "//podo_owner:podo_owner@");

(TEST_DB ? describe : describe.skip)("Öffnungszeiten je Wochentag (DB)", () => {
  const f = fixtures(TEST_DB!);
  const owner = new Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL ?? ownerUrlFrom(TEST_DB ?? ""), max: 1 });
  let actions: typeof import("@/app/(app)/einstellungen/actions");
  let websiteActions: typeof import("@/app/(app)/einstellungen/website/actions");
  let staff: typeof import("./staff");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    actions = await import("@/app/(app)/einstellungen/actions");
    websiteActions = await import("@/app/(app)/einstellungen/website/actions");
    staff = await import("./staff");
  });
  afterAll(async () => {
    await f.end();
    await owner.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const settingsOf = async (org: string) => (await f.pool.query("select settings from organizations where id = $1", [org])).rows[0].settings;

  async function setup(settings: unknown = {}) {
    const org = await f.org({ settings });
    const user = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'owner')", [org, user]);
    authState.org = org;
    authState.user = user;
    authState.perms = [];
    return { org, user };
  }

  it("speichert Tageszeiten mit Pause, ersetzt den alten Mo–Fr-Bereich, schreibt Audit; Verfügbarkeit folgt", async () => {
    const { org, user } = await setup({ opening: { from: "07:00", to: "15:00" }, materialCostCents: 400 });
    const hours = [h(1, "13:00", "18:00"), h(1, "08:00", "12:00"), h(3, "08:00", "12:00"), h(6, "09:00", "12:00")];
    expect(await actions.saveOpeningHoursAction(undefined, fd({ hours: JSON.stringify(hours) }))).toEqual({ ok: "Gespeichert." });
    expect(authState.perms).toEqual(["settings.manage"]);
    const s = await settingsOf(org);
    expect(s.practiceHours).toEqual([h(1, "08:00", "12:00"), h(1, "13:00", "18:00"), h(3, "08:00", "12:00"), h(6, "09:00", "12:00")]);
    expect(s.opening).toBeUndefined();
    expect(s.materialCostCents).toBe(400); // andere Einstellungen bleiben
    const audit = await f.asOrg(org, async (c) => (await c.query("select action, user_id, meta from audit_log where organization_id = $1 and action = 'settings.opening_hours'", [org])).rows);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ user_id: user, meta: { hours: "Mo 08:00–12:00, 13:00–18:00 · Di geschlossen · Mi 08:00–12:00 · Do–Fr geschlossen · Sa 09:00–12:00 · So geschlossen" } });

    // Person ohne eigene Arbeitszeiten: Öffnungszeiten je Tag (Mo 2031-05-05, Di 06, Sa 10, So 11)
    expect((await staff.availability(org, user, "2031-05-05")).ranges).toEqual([{ start: "08:00", end: "12:00" }, { start: "13:00", end: "18:00" }]);
    expect((await staff.availability(org, user, "2031-05-06")).reason).toBe("no_hours");
    expect((await staff.availability(org, user, "2031-05-10")).ranges).toEqual([{ start: "09:00", end: "12:00" }]);
    expect((await staff.availability(org, user, "2031-05-11")).available).toBe(false);
  });

  it("lehnt Ungültiges ab und lässt die gespeicherten Zeiten unverändert", async () => {
    const { org } = await setup({ practiceHours: [h(2, "08:00", "12:00")] });
    expect((await actions.saveOpeningHoursAction(undefined, fd({ hours: JSON.stringify([h(1, "08:00", "12:00"), h(1, "11:00", "13:00")]) })))?.error).toMatch(/überschneiden/);
    expect((await actions.saveOpeningHoursAction(undefined, fd({ hours: JSON.stringify([h(1, "12:00", "08:00")]) })))?.error).toMatch(/muss nach/);
    expect((await actions.saveOpeningHoursAction(undefined, fd({ hours: "kaputt" })))?.error).toMatch(/nicht gelesen/);
    expect((await settingsOf(org)).practiceHours).toEqual([h(2, "08:00", "12:00")]);
    // alle Tage geschlossen ist erlaubt
    expect((await actions.saveOpeningHoursAction(undefined, fd({ hours: "[]" })))?.ok).toMatch(/keine Öffnungszeiten/);
    expect((await settingsOf(org)).practiceHours).toEqual([]);
  });

  it("Website: Standard = Praxis-Öffnungszeiten, optional abweichend (eigene Zeiten bleiben beim Zurückschalten erhalten)", async () => {
    const { org } = await setup({ practiceHours: [h(1, "08:00", "12:00"), h(1, "13:00", "18:00")] });
    const base = { claim: "", about: "", imprint: "", privacy: "", areas: "" };
    // eigene Zeiten
    expect((await websiteActions.saveWebsiteAction(undefined, fd({ ...base, websiteHours: JSON.stringify([h(2, "09:00", "17:00")]) })))?.ok).toBeTruthy();
    let s = await settingsOf(org);
    expect(s.website.customHours).toBe(true);
    expect(s.openingHours).toEqual([h(2, "09:00", "17:00")]);
    expect(websiteOpeningHours(s)).toEqual([h(2, "09:00", "17:00")]);
    // eigene Woche „alles geschlossen“ bleibt geschlossen (kein Rückfall auf Praxiszeiten)
    expect((await websiteActions.saveWebsiteAction(undefined, fd({ ...base, websiteHours: "[]" })))?.ok).toBeTruthy();
    s = await settingsOf(org);
    expect(s.website.customHours).toBe(true);
    expect(s.openingHours).toEqual([]);
    expect(websiteOpeningHours(s)).toEqual([]);
    expect((await websiteActions.saveWebsiteAction(undefined, fd({ ...base, websiteHours: JSON.stringify([h(2, "09:00", "17:00")]) })))?.ok).toBeTruthy();
    // ungültige Website-Zeiten
    expect((await websiteActions.saveWebsiteAction(undefined, fd({ ...base, websiteHours: JSON.stringify([h(2, "09:00", "08:00")]) })))?.error).toMatch(/Website-Zeiten/);
    // wie Praxis-Öffnungszeiten
    expect((await websiteActions.saveWebsiteAction(undefined, fd({ ...base, samePracticeHours: "on" })))?.ok).toBeTruthy();
    s = await settingsOf(org);
    expect(s.website.customHours).toBe(false);
    expect(s.openingHours).toEqual([h(2, "09:00", "17:00")]);
    expect(websiteOpeningHours(s)).toEqual([h(1, "08:00", "12:00"), h(1, "13:00", "18:00")]);
  });

  it("Migration 0046: nur Altdaten werden übernommen (Website-Zeiten vor opening), eingerastet, gefiltert; idempotent; Code liest gleich", async () => {
    const sql = readFileSync(path.join(__dirname, "../../drizzle/0046_oeffnungszeiten_tage.sql"), "utf8").split("--> statement-breakpoint");
    const legacy = await f.org({ settings: { opening: { from: "07:30", to: "16:00" }, website: { enabled: true, claim: "Hallo" } } });
    const none = await f.org({ settings: { website: { enabled: true } } });
    // wie per Bootstrap angelegt: opening = min/max, openingHours = echte Tage
    const boot = await f.org({ settings: { opening: { from: "08:00", to: "17:00" }, openingHours: [h(3, "08:00", "17:00"), h(2, "08:00", "17:00")] } });
    const offGrid = await f.org({ settings: { openingHours: [h(1, "08:03", "12:01"), h(1, "13:00", "18:00"), h(9, "08:00", "09:00"), h(2, "12:00", "08:00"), { weekday: 4, from: 8, to: "09:00" }, "x", h(5, "23:56", "23:59")] } });
    const odd = await f.org({ settings: { opening: "kaputt", website: null } });
    const badRange = await f.org({ settings: { opening: { from: "18:00", to: "08:00" } } });
    const done = await f.org({ settings: { practiceHours: [h(6, "09:00", "12:00")], website: { customHours: true }, openingHours: [h(2, "08:00", "17:00")] } });
    const orgs = [legacy, none, boot, offGrid, odd, badRange, done];
    const before = await Promise.all(orgs.map(settingsOf));
    const run = async () => {
      for (const stmt of sql) await owner.query(stmt);
    };
    await run();
    const after = await Promise.all(orgs.map(settingsOf));
    const weekdays = (from: string, to: string) => [1, 2, 3, 4, 5].map((d) => h(d, from, to));

    expect(after[0].practiceHours).toEqual(weekdays("07:30", "16:00"));
    expect(after[0].website).toEqual({ enabled: true, claim: "Hallo", customHours: false });
    // ohne Angaben: keine practiceHours, Website ohne Zeiten
    expect(after[1]).toEqual({ website: { enabled: true, customHours: false } });
    expect(websiteOpeningHours(after[1])).toEqual([]);
    // Bootstrap: Website-Zeiten werden Praxis-Öffnungszeiten (nicht Mo–Fr), Website identisch
    expect(after[2].practiceHours).toEqual([h(2, "08:00", "17:00"), h(3, "08:00", "17:00")]);
    expect(after[2].website.customHours).toBe(false);
    expect(websiteOpeningHours(after[2])).toEqual([h(2, "08:00", "17:00"), h(3, "08:00", "17:00")]);
    // Raster + Filter wie websiteSettings()/openingHours()
    expect(after[3].practiceHours).toEqual([h(1, "08:00", "12:05"), h(1, "13:00", "18:00")]);
    expect(after[4].practiceHours).toBeUndefined();
    expect(after[4].website).toEqual({ customHours: false });
    expect(after[5].practiceHours).toEqual([]);
    expect(after[6]).toEqual(before[6]);

    // Code liest Altdaten genauso wie die migrierten Daten
    for (let i = 0; i < orgs.length; i++) {
      expect(practiceHours(after[i]), `Praxis ${i}`).toEqual(practiceHours(before[i]));
      expect(storedPracticeHours(after[i]), `gespeichert ${i}`).toEqual(storedPracticeHours(before[i]));
      expect(websiteOpeningHours(after[i]), `Website ${i}`).toEqual(websiteOpeningHours(before[i]));
    }
    // gespeicherte Zeiten lassen sich unverändert wieder speichern (Raster)
    expect(validateWeek(after[3].practiceHours).error).toBeUndefined();

    // zweiter Lauf ändert nichts
    await run();
    expect(await Promise.all(orgs.map(settingsOf))).toEqual(after);
  });
});
