/**
 * Neuigkeiten-Popup gegen PostgreSQL: Sitzungs-Flag (einmal je Anmeldung, Praxiswechsel zählt nicht),
 * Merken von „gesehen“/„nicht mehr anzeigen“ je Person.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined),
    set: (n: string, v: string, o?: { maxAge?: number }) => (o?.maxAge === 0 || v === "" ? jar.delete(n) : jar.set(n, v)),
    delete: (n: string) => jar.delete(n),
  }),
  headers: async () => new Headers({ "x-podo-method": "GET", "x-podo-path": "/heute", "user-agent": "vitest" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`REDIRECT ${to}`), { to });
  },
}));

import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

(TEST_DB ? describe : describe.skip)("Neuigkeiten (DB)", () => {
  const f = fixtures(TEST_DB!);
  let session: typeof import("@/lib/auth/session");
  let changelog: typeof import("@/server/changelog");
  let content: typeof import("@/content/changelog");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    session = await import("@/lib/auth/session");
    changelog = await import("@/server/changelog");
    content = await import("@/content/changelog");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });
  beforeEach(() => jar.clear());

  const setup = async (role = "therapist") => {
    const org = await f.org();
    await f.pool.query("update organizations set plan = 'internal', subscription_status = 'active' where id = $1", [org]);
    const user = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,$3)", [org, user, role]);
    const token = randomBytes(24).toString("base64url");
    await f.pool.query("insert into sessions (id, user_id, organization_id, verified, expires_at) values ($1,$2,$3,true, now() + interval '3 hours')", [sha(token), user, org]);
    jar.set(session.SESSION_COOKIE, token);
    return { org, user, token };
  };
  const shownAt = async (token: string) => (await f.pool.query("select changelog_shown_at from sessions where id = $1", [sha(token)])).rows[0]?.changelog_shown_at ?? null;
  const prefs = async (user: string) => (await f.pool.query("select prefs from users where id = $1", [user])).rows[0].prefs;
  const latestForAll = () => content.CHANGELOG.filter((e) => (e.audience ?? "all") === "all")[0];

  it("Popup genau einmal je Sitzung; neue Anmeldung zeigt es wieder", async () => {
    const { user, token } = await setup();
    expect(await shownAt(token)).toBeNull();
    const first = await changelog.loginChangelog();
    expect(first?.mode).toBe("neu");
    expect(first?.entries.every((e) => (e.audience ?? "all") === "all")).toBe(true);
    expect(await shownAt(token)).not.toBeNull();
    expect(await changelog.claimChangelogForSession(sha(token))).toBe(false);

    // neue Anmeldung (neue Sitzung) → wieder anbieten
    const t2 = randomBytes(24).toString("base64url");
    const org = (await f.pool.query("select organization_id from sessions where id = $1", [sha(token)])).rows[0].organization_id;
    await f.pool.query("insert into sessions (id, user_id, organization_id, verified, expires_at) values ($1,$2,$3,true, now() + interval '3 hours')", [sha(t2), user, org]);
    expect(await changelog.claimChangelogForSession(sha(t2))).toBe(true);
  });

  it("nach bestätigter 2FA (neues Token) kommt das Popup, vorher nicht", async () => {
    const { org, user } = await setup();
    const token = randomBytes(24).toString("base64url");
    await f.pool.query("insert into sessions (id, user_id, organization_id, verified, expires_at) values ($1,$2,$3,false, now() + interval '10 minutes')", [sha(token), user, org]);
    jar.set(session.SESSION_COOKIE, token);
    expect(await changelog.loginChangelog()).toBeNull();
    expect(await shownAt(token)).toBeNull();
    await session.markSessionVerified();
    const fresh = jar.get(session.SESSION_COOKIE)!;
    expect(fresh).not.toBe(token);
    expect(await shownAt(fresh)).toBeNull();
  });

  it("Praxiswechsel (Token-Rotation) übernimmt das Flag – kein zweites Popup", async () => {
    const { user, token } = await setup();
    await changelog.loginChangelog();
    const other = await f.org();
    expect(await session.rotateSession(sha(token), user, other)).toBe(true);
    const fresh = jar.get(session.SESSION_COOKIE)!;
    expect(await shownAt(fresh)).not.toBeNull();
  });

  it("Schließen merkt den Eintrag; alles gesehen → neuester Eintrag erneut, außer stummgeschaltet", async () => {
    const { user } = await setup();
    const latest = latestForAll();
    const viewer = { role: "therapist" as const, isPlatformAdmin: false };
    expect(await changelog.saveChangelogDismissal(user, viewer, latest.id, false)).toBe(true);
    expect((await prefs(user)).changelog).toEqual({ seenId: latest.id });

    // nächste Anmeldung: Wiederholung des neuesten Eintrags
    const t = randomBytes(24).toString("base64url");
    const org = (await f.pool.query("select organization_id from memberships where user_id = $1", [user])).rows[0].organization_id;
    await f.pool.query("insert into sessions (id, user_id, organization_id, verified, expires_at) values ($1,$2,$3,true, now() + interval '3 hours')", [sha(t), user, org]);
    jar.set(session.SESSION_COOKIE, t);
    const again = await changelog.loginChangelog();
    expect(again).toEqual({ mode: "wiederholung", entries: [expect.objectContaining({ id: latest.id })] });

    // stummschalten → nächste Anmeldung ohne Popup
    expect(await changelog.saveChangelogDismissal(user, viewer, latest.id, true)).toBe(true);
    const t3 = randomBytes(24).toString("base64url");
    await f.pool.query("insert into sessions (id, user_id, organization_id, verified, expires_at) values ($1,$2,$3,true, now() + interval '3 hours')", [sha(t3), user, org]);
    jar.set(session.SESSION_COOKIE, t3);
    expect(await changelog.loginChangelog()).toBeNull();
    expect(await shownAt(t3)).toBeNull();
  });

  it("Plattform-Einträge lassen sich ohne Plattform-Rolle nicht als gesehen speichern", async () => {
    const { user } = await setup();
    const platformEntry = content.CHANGELOG.find((e) => e.audience === "platform");
    if (!platformEntry) return;
    expect(await changelog.saveChangelogDismissal(user, { role: "therapist", isPlatformAdmin: false }, platformEntry.id, true)).toBe(false);
    expect(await prefs(user)).toEqual({});
  });
});
