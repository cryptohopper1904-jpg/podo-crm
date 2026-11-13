/**
 * Öffnungszeiten je Wochentag (DB): Speichern/Laden über Einstellungen → Öffnungszeiten und → Website,
 * Verfügbarkeit ohne Arbeitszeiten, Migration 0039 der Altdaten (Mo–Fr-Bereich, eigene Website-Zeiten). Erfundene Daten.
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
    // ungültige Website-Zeiten
    expect((await websiteActions.saveWebsiteAction(undefined, fd({ ...base, websiteHours: JSON.stringify([h(2, "09:00", "08:00")]) })))?.error).toMatch(/Website-Zeiten/);
    // wie Praxis-Öffnungszeiten
    expect((await websiteActions.saveWebsiteAction(undefined, fd({ ...base, samePracticeHours: "on" })))?.ok).toBeTruthy();
    s = await settingsOf(org);
    expect(s.website.customHours).toBe(false);
    expect(s.openingHours).toEqual([h(2, "09:00", "17:00")]);
    expect(websiteOpeningHours(s)).toEqual([h(1, "08:00", "12:00"), h(1, "13:00", "18:00")]);
  });

  it("Migration 0039: alter Mo–Fr-Bereich → Mo–Fr gleiche Zeiten, eigene Website-Zeiten bleiben abweichend; idempotent", async () => {
    const sql = readFileSync(path.join(__dirname, "../../drizzle/0039_oeffnungszeiten_tage.sql"), "utf8").split("--> statement-breakpoint");
    const legacy = await f.org({ settings: { opening: { from: "07:30", to: "16:00" }, website: { enabled: true, claim: "Hallo" } } });
    const none = await f.org({ settings: {} });
    const ownSite = await f.org({ settings: { opening: { from: "08:00", to: "17:00" }, openingHours: [h(2, "08:00", "17:00"), h(3, "08:00", "17:00")] } });
    const done = await f.org({ settings: { practiceHours: [h(6, "09:00", "12:00")], website: { customHours: false }, openingHours: [h(2, "08:00", "17:00")] } });
    const odd = await f.org({ settings: { opening: "kaputt", website: null } });
    const run = async () => {
      for (const stmt of sql) await owner.query(stmt);
    };
    await run();
    const weekdays = (from: string, to: string) => [1, 2, 3, 4, 5].map((d) => h(d, from, to));

    const a = await settingsOf(legacy);
    expect(a.practiceHours).toEqual(weekdays("07:30", "16:00"));
    expect(a.website).toEqual({ enabled: true, claim: "Hallo", customHours: false });
    expect((await settingsOf(none)).practiceHours).toEqual(weekdays("08:00", "18:00"));
    const c = await settingsOf(ownSite);
    expect(c.practiceHours).toEqual(weekdays("08:00", "17:00"));
    expect(c.website.customHours).toBe(true);
    expect(c.openingHours).toHaveLength(2);
    expect(await settingsOf(done)).toEqual({ practiceHours: [h(6, "09:00", "12:00")], website: { customHours: false }, openingHours: [h(2, "08:00", "17:00")] });
    const e = await settingsOf(odd);
    expect(e.practiceHours).toEqual(weekdays("08:00", "18:00"));
    expect(e.website).toEqual({ customHours: false });

    // zweiter Lauf ändert nichts
    const before = await Promise.all([legacy, none, ownSite, done, odd].map(settingsOf));
    await run();
    expect(await Promise.all([legacy, none, ownSite, done, odd].map(settingsOf))).toEqual(before);

    // die Anwendung liest migrierte Daten wie zuvor die Altdaten
    const { practiceHours, weekdaysWeek } = await import("@/lib/opening-hours");
    expect(practiceHours(a)).toEqual(weekdaysWeek({ start: "07:30", end: "16:00" }));
    expect(practiceHours({ opening: { from: "07:30", to: "16:00" } })).toEqual(practiceHours(a));
  });
});
